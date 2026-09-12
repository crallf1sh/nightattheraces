const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const databaseFile = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'races.sqlite');
require('fs').mkdirSync(path.dirname(databaseFile), { recursive: true });
const db = new Database(databaseFile);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL);`);
const app = express(), server = http.createServer(app), io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
function adminGate(req, res, next) { const p = process.env.ADMIN_PASSWORD; if (!p || !req.path.startsWith('/api') && req.path !== '/admin') return next(); const h=req.headers.authorization||''; const supplied=h.startsWith('Basic ')?Buffer.from(h.slice(6),'base64').toString().split(':').slice(1).join(':'):''; if (supplied===p) return next(); res.set('WWW-Authenticate','Basic realm="Night at the Races"'); return res.status(401).send('Admin authentication required'); }
app.use(adminGate);
const now=()=>new Date().toISOString();
const activeRow=()=>db.prepare("SELECT * FROM events WHERE status='active' ORDER BY updated_at DESC LIMIT 1").get();
const migrateState=s=>{
  if(!s) return s;
  s.settings=s.settings||{};
  if(!Object.prototype.hasOwnProperty.call(s.settings,'announcementDuration')) s.settings.announcementDuration=10;
  if(!Object.prototype.hasOwnProperty.call(s.settings,'thirdPrize')) s.settings.thirdPrize='$250';
  if(!Object.prototype.hasOwnProperty.call(s.settings,'secondPrize')) s.settings.secondPrize='$500';
  if(!Object.prototype.hasOwnProperty.call(s.settings,'firstPrize')) s.settings.firstPrize='$1,000';
  if(!Object.prototype.hasOwnProperty.call(s.settings,'giftCardPrize')) s.settings.giftCardPrize='Gift Card';
  s.finalThree=s.finalThree||{stage:0,announcement:null,winners:[]};
  if(s.finalFour?.winners?.length && !s.finalThree.winners.length){
    s.finalThree.winners=s.finalFour.winners.filter(w=>['Third Place','Second Place','First Place'].includes(w.place));
    s.finalThree.stage=s.finalThree.winners.filter(w=>w.place!=='First Place').length;
  }
  if(s.mode==='finalFive'||s.mode==='finalFour') s.mode=s.participants.filter(p=>p.status==='remaining').length<=3?'finalThree':'standard';
  return s;
};
const getState=()=>{const r=activeRow(); return r?migrateState(JSON.parse(r.state)):null};
function publicState(s){ return s; }
function record(s,type,detail,participant=null,reversible=false){ s.history.unshift({id:crypto.randomUUID(),at:now(),type,detail,participant,round:s.round.number,reversible}); s.lastSaved=now(); }
function checkpoint(id,s,label){ db.prepare('INSERT INTO checkpoints(event_id,created_at,label,state) VALUES(?,?,?,?)').run(id,now(),label,JSON.stringify(s)); db.prepare('DELETE FROM checkpoints WHERE id IN (SELECT id FROM checkpoints WHERE event_id=? ORDER BY id DESC LIMIT -1 OFFSET 40)').run(id); }
function save(s,label,emit){ const ts=now(); s.lastSaved=ts; const tx=db.transaction(()=>{db.prepare('UPDATE events SET state=?,updated_at=? WHERE id=?').run(JSON.stringify(s),ts,s.id); checkpoint(s.id,s,label)});tx(); if(emit) io.emit('elimination',emit); io.emit('state', publicState(s)); if(s.history[0]?.type==='round-complete'){const winner=s.completedRounds.at(-1);io.emit('gift-card',{name:winner.giftWinner,prize:s.settings.giftCardPrize,round:winner.number,duration:s.settings.announcementDuration});} return s; }
function ensure(s){if(!s) throw Error('No active event. Import a roster first.'); migrateState(s); const remaining=s.participants.filter(p=>p.status==='remaining'); if(new Set(s.participants.map(p=>p.id)).size!==s.participants.length) throw Error('Integrity failure: duplicate participant ID'); if(s.mode==='finalThree'&&remaining.length>3) throw Error('Invalid Final Three state'); return remaining;}
function target(s){const c=s.round.config;if(!c) return 0; const startingRemaining=s.participants.filter(p=>p.status==='remaining').length+s.round.eliminatedIds.length; return c.kind==='percent'?Math.min(Math.max(1,Math.ceil(startingRemaining*c.value/100)),Math.max(0,startingRemaining-3)):Math.min(c.value,Math.max(0,startingRemaining-3));}
function initEvent(rows){const t=now(), id=crypto.randomUUID(); return {id,createdAt:t,lastSaved:t,title:'Night at the Races',participants:rows.map(r=>({id:crypto.randomUUID(),firstName:r.firstName,lastName:r.lastName,name:`${r.firstName} ${r.lastName}`,status:'remaining',eliminatedAt:null,eliminatedRound:null})),mode:'standard',round:{number:1,config:{kind:'number',value:Math.min(10,Math.max(0,rows.length-3))},eliminatedIds:[]},completedRounds:[],recentEliminations:[],finalThree:{stage:0,announcement:null,winners:[]},settings:{thirdPrize:'$250',secondPrize:'$500',firstPrize:'$1,000',giftCardPrize:'Gift Card',announcementDuration:10},history:[],lastSaved:t};}
function finishRound(s, automatic=false){ const ids=s.round.eliminatedIds; if(!ids.length) throw Error('No eliminations in this round.'); if(s.completedRounds.some(r=>r.number===s.round.number)) throw Error('This round already has a winner.'); const pool=s.participants.filter(p=>ids.includes(p.id)); const winner=pool[crypto.randomInt(pool.length)]; const item={number:s.round.number,eliminatedIds:ids,giftWinnerId:winner.id,giftWinner:winner.name,completedAt:now(),automatic}; s.completedRounds.push(item); record(s,'round-complete',`Round ${s.round.number} complete — ${winner.name} wins ${s.settings.giftCardPrize}.`,winner.name); s.round={number:s.round.number+1,config:{kind:'number',value:0},eliminatedIds:[]}; if(s.participants.filter(p=>p.status==='remaining').length===3)s.mode='finalThree'; return item; }
function eliminate(s,id,source){
  const remaining=ensure(s), before=JSON.stringify(s);
  const p=s.participants.find(x=>x.id===id);if(!p||p.status!=='remaining') throw Error('That participant is not remaining.');
  if(s.mode==='standard'){
    const t=target(s); if(!t) throw Error('Configure a valid standard-round target first.'); if(s.round.eliminatedIds.length>=t) throw Error('Current round target is already complete.');
    p.status='eliminated';p.eliminatedAt=now();p.eliminatedRound=s.round.number;s.round.eliminatedIds.push(p.id);s.recentEliminations.unshift({id:p.id,name:p.name,at:now(),round:s.round.number});
    record(s,'eliminate',`${source}: eliminated ${p.name}`,p.name,true); s.undoSnapshot=before; return {p,final:null};
  }
  const placements=[{place:'Third Place',prize:s.settings.thirdPrize},{place:'Second Place',prize:s.settings.secondPrize}];
  if(remaining.length===1){
    if(s.finalThree.winners.some(w=>w.place==='First Place'))throw Error('The final winner has already been announced.');
    const result={place:'First Place',prize:s.settings.firstPrize};
    s.finalThree.winners.push({participantId:p.id,name:p.name,...result});s.finalThree.announcement={name:p.name,...result};
    record(s,'winner-announce',`First Place: ${p.name}${result.prize?` — ${result.prize}`:''}`,p.name,true);s.undoSnapshot=before;return {p,final:s.finalThree.announcement};
  }
  const result=placements[s.finalThree.stage]; if(!result) throw Error('Final Three sequence is already complete.');
  p.status='eliminated';p.eliminatedAt=now();p.eliminatedRound=s.round.number;s.recentEliminations.unshift({id:p.id,name:p.name,at:now(),round:s.round.number});
  s.finalThree.winners.push({participantId:p.id,name:p.name,...result});s.finalThree.stage++;s.finalThree.announcement={name:p.name,...result};
  record(s,'eliminate',`${result.place}: ${p.name}${result.prize?` — ${result.prize}`:''}`,p.name,true);s.undoSnapshot=before;return {p,final:s.finalThree.announcement};
}
function parseWorkbook(buf){let book;try{book=XLSX.read(buf,{type:'buffer'});}catch{throw Error('Could not read this Excel workbook.');}const sheet=book.Sheets[book.SheetNames[0]];if(!sheet)throw Error('Workbook has no worksheet.');const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''});const heads=(rows[0]||[]).map(x=>String(x).trim().toLowerCase());const fi=heads.indexOf('first name'),li=heads.indexOf('last name');if(fi<0||li<0)throw Error('Required columns: First Name and Last Name.');const errors=[],out=[],seen=new Set();rows.slice(1).forEach((row,i)=>{const a=String(row[fi]||'').trim(),b=String(row[li]||'').trim(),n=`${a} ${b}`.trim(),line=i+2;if(!a&&!b)return;if(!a||!b)errors.push(`Row ${line}: both first and last name are required.`);else if(n.length>120)errors.push(`Row ${line}: name is too long.`);else {const key=n.toLocaleLowerCase();if(seen.has(key))errors.push(`Row ${line}: duplicate name “${n}”. Identical names need a distinguishing initial.`);seen.add(key);out.push({firstName:a,lastName:b});}});if(!out.length)errors.push('No valid participants found.');return {rows:out,errors};}
app.get('/',(q,r)=>r.redirect('/admin'));app.get('/admin',(q,r)=>r.sendFile(path.join(__dirname,'public','admin.html')));app.get('/screen',(q,r)=>r.sendFile(path.join(__dirname,'public','screen.html')));
app.get('/api/state',(q,r)=>r.json({state:getState(),screenClients:[...io.sockets.sockets.values()].filter(x=>x.data.screen).length}));
app.post('/api/import-preview',upload.single('file'),(q,r)=>{try{if(!q.file)throw Error('Choose an .xlsx file.');r.json(parseWorkbook(q.file.buffer));}catch(e){r.status(400).json({error:e.message});}});
app.get('/api/template',(q,r)=>{const ws=XLSX.utils.aoa_to_sheet([['First Name','Last Name'],['Example','Participant'],['Taylor','Sample'],['Replace','These Rows']]);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Roster');const b=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});r.attachment('night-at-the-races-roster-template.xlsx').send(b);});
app.post('/api/create-event',(q,r)=>{try{if(activeRow())throw Error('Archive the existing event before creating a new one.');const rows=q.body.rows;if(!Array.isArray(rows)||rows.length<3)throw Error('At least three valid participants are required.');const s=initEvent(rows);db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(s.id,'active',now(),now(),JSON.stringify(s));checkpoint(s.id,s,'Event created');io.emit('state',s);r.json({state:s});}catch(e){r.status(400).json({error:e.message});}});
app.post('/api/archive',(q,r)=>{try{const s=getState();ensure(s);if(q.body.confirm!=='RESET')throw Error('Type RESET to archive this event.');db.prepare("UPDATE events SET status='archived',updated_at=? WHERE id=?").run(now(),s.id);io.emit('state',null);r.json({ok:true});}catch(e){r.status(400).json({error:e.message});}});
app.post('/api/action',(q,r)=>{try{let s=getState(),a=q.body;ensure(s);let emit=null;switch(a.type){
case'config':{const v=Number(a.value);if(!['number','percent'].includes(a.kind)||!Number.isFinite(v)||v<=0||(a.kind==='percent'&&v>100))throw Error('Invalid round configuration.');const rem=ensure(s);const proposed=a.kind==='percent'?Math.ceil(rem.length*v/100):v;if(proposed>rem.length-3)throw Error('A standard round cannot eliminate into the Final Three. Use no more than remaining minus three.');s.round.config={kind:a.kind,value:v};record(s,'round-config',`Round target set to ${v}${a.kind==='percent'?'%':' names'}`);break;}
case'eliminate':{const x=eliminate(s,a.id,a.source==='random'?'Secure random draw':'Drawn/manual name');emit={participant:x.p,final:x.final,duration:s.settings.announcementDuration};break;}
case'random-eliminate':{const rem=ensure(s);const x=eliminate(s,rem[crypto.randomInt(rem.length)].id,'Secure random draw');emit={participant:x.p,final:x.final,duration:s.settings.announcementDuration};break;}
case'end-round':{const needed=target(s);if(s.round.eliminatedIds.length<needed&&!a.early)throw Error('Target is not yet complete. Confirm an early end to continue.');finishRound(s,!!a.early);break;}
case'settings':{Object.assign(s.settings,a.settings||{});record(s,'settings','Prize and announcement settings updated');break;}
case'dismiss-announcement':s.finalThree.announcement=null;record(s,'announcement-dismiss','Announcement dismissed');io.emit('clear-announcement');break;
case'undo':{if(!s.undoSnapshot)throw Error('No reversible action is available.');const currentHistory=s.history||[];const restored=migrateState(JSON.parse(s.undoSnapshot));restored.id=s.id;restored.undoSnapshot=null;record(restored,'undo','Undid the last elimination/winner action');s=restored;io.emit('clear-announcement');break;}
default:throw Error('Unknown action.');}save(s,a.type,emit);r.json({state:s});}catch(e){r.status(400).json({error:e.message});}});
app.get('/api/backup',(q,r)=>{const s=getState();if(!s)return r.status(404).json({error:'No active event'});r.attachment(`night-races-backup-${s.id}.json`).json({format:'night-at-the-races-backup-v2',exportedAt:now(),state:s});});
app.post('/api/restore',(q,r)=>{try{const b=q.body;if(!['night-at-the-races-backup-v1','night-at-the-races-backup-v2'].includes(b?.format)||!b.state?.participants||!Array.isArray(b.state.participants))throw Error('This is not a valid Night at the Races backup.');if(q.body.confirm!=='RESTORE')throw Error('Type RESTORE to confirm recovery.');const old=activeRow();const s=migrateState(b.state);s.id=crypto.randomUUID();s.lastSaved=now();const tx=db.transaction(()=>{if(old)db.prepare("UPDATE events SET status='archived',updated_at=? WHERE id=?").run(now(),old.id);db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(s.id,'active',now(),now(),JSON.stringify(s));checkpoint(s.id,s,'Backup restored');});tx();io.emit('state',s);r.json({state:s});}catch(e){r.status(400).json({error:e.message});}});
app.get('/api/checkpoints',(q,r)=>{const s=getState();r.json(s?db.prepare('SELECT id,created_at,label FROM checkpoints WHERE event_id=? ORDER BY id DESC').all(s.id):[])});
app.post('/api/checkpoints/:id/restore',(q,r)=>{try{if(q.body.confirm!=='CHECKPOINT')throw Error('Type CHECKPOINT to restore.');const s=getState(),row=db.prepare('SELECT * FROM checkpoints WHERE id=? AND event_id=?').get(q.params.id,s.id);if(!row)throw Error('Checkpoint not found.');const restored=migrateState(JSON.parse(row.state));restored.id=s.id;record(restored,'checkpoint-restore',`Restored checkpoint from ${row.created_at}`);save(restored,'Checkpoint restored');r.json({state:restored});}catch(e){r.status(400).json({error:e.message});}});
io.on('connection',socket=>{socket.on('screen',()=>{socket.data.screen=true;io.emit('screen-status',[...io.sockets.sockets.values()].filter(x=>x.data.screen).length);});socket.emit('state',getState());socket.on('disconnect',()=>io.emit('screen-status',[...io.sockets.sockets.values()].filter(x=>x.data.screen).length));});
server.listen(PORT,()=>console.log(`Night at the Races v2 listening on http://localhost:${PORT}`));
