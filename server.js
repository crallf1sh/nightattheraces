from pathlib import Path

src = Path("/mnt/data/server.js").read_text()

# 1) Replace publicState with a screen-safe projection.
src = src.replace(
    "function publicState(s){ return s; }",
    """function publicState(s){
  if(!s) return null;
  // Big Screen only needs presentation state. Never send undo snapshots or
  // admin/history data over the screen WebSocket channel.
  return {
    id:s.id,
    title:s.title,
    mode:s.mode,
    round:s.round,
    participants:s.participants,
    recentEliminations:s.recentEliminations||[],
    finalThree:s.finalThree,
    settings:{
      announcementDuration:s.settings?.announcementDuration,
      giftCardPrize:s.settings?.giftCardPrize
    }
  };
}
const screenCount=()=>io.sockets.adapter.rooms.get('screens')?.size||0;
function emitScreenStatus(){ io.emit('screen-status',screenCount()); }
function socketStats(label){
  const m=process.memoryUsage();
  console.log(`[SOCKET] ${label} clients=${io.engine.clientsCount} screens=${screenCount()} rss=${Math.round(m.rss/1024/1024)}MB heap=${Math.round(m.heapUsed/1024/1024)}MB`);
}"""
)

# 2) Replace save() so screen state is only sent to screen room, admin state elsewhere,
# and gift-card emission is explicit via an argument rather than history[0].
old_save = """function save(s,label,emit){ const ts=now(); s.lastSaved=ts; const tx=db.transaction(()=>{db.prepare('UPDATE events SET state=?,updated_at=? WHERE id=?').run(JSON.stringify(s),ts,s.id); checkpoint(s.id,s,label)});tx(); if(emit) io.emit('elimination',emit); io.emit('state', publicState(s)); if(s.history[0]?.type==='round-complete'){const winner=s.completedRounds.at(-1);io.emit('gift-card',{name:winner.giftWinner,prize:s.settings.giftCardPrize,round:winner.number,duration:s.settings.announcementDuration});} return s; }"""
new_save = """function save(s,label,emit,gift=null){
  const ts=now(); s.lastSaved=ts;
  const tx=db.transaction(()=>{
    db.prepare('UPDATE events SET state=?,updated_at=? WHERE id=?').run(JSON.stringify(s),ts,s.id);
    checkpoint(s.id,s,label);
  });
  tx();

  // Admin sockets retain full state; screens receive only presentation state.
  io.to('admins').emit('state',s);
  io.to('screens').emit('state',publicState(s));

  if(emit) io.to('screens').emit('elimination',emit);
  if(gift) io.to('screens').emit('gift-card',gift);
  return s;
}"""
if old_save not in src:
    raise RuntimeError("Expected save() function not found")
src = src.replace(old_save, new_save)

# 3) API state screen count should use room.
src = src.replace(
    "app.get('/api/state',(q,r)=>r.json({state:getState(),screenClients:[...io.sockets.sockets.values()].filter(x=>x.data.screen).length}));",
    "app.get('/api/state',(q,r)=>r.json({state:getState(),screenClients:screenCount()}));"
)

# 4) Create/archive/restore should target appropriate rooms.
src = src.replace(
    "checkpoint(s.id,s,'Event created');io.emit('state',s);r.json({state:s});",
    "checkpoint(s.id,s,'Event created');io.to('admins').emit('state',s);io.to('screens').emit('state',publicState(s));r.json({state:s});"
)
src = src.replace(
    "db.prepare(\"UPDATE events SET status='archived',updated_at=? WHERE id=?\").run(now(),s.id);io.emit('state',null);r.json({ok:true});",
    "db.prepare(\"UPDATE events SET status='archived',updated_at=? WHERE id=?\").run(now(),s.id);io.to('admins').emit('state',null);io.to('screens').emit('state',null);r.json({ok:true});"
)
src = src.replace(
    "checkpoint(s.id,s,'Backup restored');});tx();io.emit('state',s);r.json({state:s});",
    "checkpoint(s.id,s,'Backup restored');});tx();io.to('admins').emit('state',s);io.to('screens').emit('state',publicState(s));r.json({state:s});"
)

# 5) Action route: gift emission explicit and clear announcement screen-only.
old_action_start = "app.post('/api/action',(q,r)=>{try{let s=getState(),a=q.body;ensure(s);let emit=null;switch(a.type){"
new_action_start = "app.post('/api/action',(q,r)=>{try{let s=getState(),a=q.body;ensure(s);let emit=null,gift=null;switch(a.type){"
src = src.replace(old_action_start, new_action_start)

src = src.replace(
    "case'end-round':{const needed=target(s);if(s.round.eliminatedIds.length<needed&&!a.early)throw Error('Target is not yet complete. Confirm an early end to continue.');finishRound(s,!!a.early);break;}",
    """case'end-round':{const needed=target(s);if(s.round.eliminatedIds.length<needed&&!a.early)throw Error('Target is not yet complete. Confirm an early end to continue.');const winner=finishRound(s,!!a.early);gift={name:winner.giftWinner,prize:s.settings.giftCardPrize,round:winner.number,duration:s.settings.announcementDuration};break;}"""
)
src = src.replace("io.emit('clear-announcement')", "io.to('screens').emit('clear-announcement')")
src = src.replace("}save(s,a.type,emit);r.json({state:s});", "}save(s,a.type,emit,gift);r.json({state:s});")

# 6) Replace socket connection handler with rooms, one-time role, diagnostics.
old_socket = """io.on('connection',socket=>{socket.on('screen',()=>{socket.data.screen=true;io.emit('screen-status',[...io.sockets.sockets.values()].filter(x=>x.data.screen).length);});socket.emit('state',getState());socket.on('disconnect',()=>io.emit('screen-status',[...io.sockets.sockets.values()].filter(x=>x.data.screen).length));});"""
new_socket = """io.on('connection',socket=>{
  // Default connections are admin clients. A Big Screen promotes itself once
  // by emitting "screen"; it is then moved out of the admin room.
  socket.join('admins');
  socket.data.role='admin';
  socket.emit('state',getState());
  socketStats(`connected ${socket.id}`);

  socket.once('screen',()=>{
    socket.leave('admins');
    socket.join('screens');
    socket.data.role='screen';
    socket.emit('state',publicState(getState()));
    emitScreenStatus();
    socketStats(`screen ${socket.id}`);
  });

  socket.on('disconnect',reason=>{
    // Socket.IO removes room membership automatically on disconnect.
    setImmediate(()=>{
      emitScreenStatus();
      socketStats(`disconnected ${socket.id} reason=${reason}`);
    });
  });
});

// Periodic diagnostics: enough to diagnose another Render failure without
// external observability tooling. This timer is created exactly once.
setInterval(()=>{
  const m=process.memoryUsage();
  console.log('[HEALTH]',{
    clients:io.engine.clientsCount,
    screens:screenCount(),
    rssMB:Math.round(m.rss/1024/1024),
    heapUsedMB:Math.round(m.heapUsed/1024/1024),
    heapTotalMB:Math.round(m.heapTotal/1024/1024),
    externalMB:Math.round(m.external/1024/1024)
  });
},60000).unref();"""
if old_socket not in src:
    raise RuntimeError("Expected socket handler not found")
src = src.replace(old_socket, new_socket)

out = Path("/mnt/data/server-patched.js")
out.write_text(src)
print(f"Created {out} ({out.stat().st_size:,} bytes)")
