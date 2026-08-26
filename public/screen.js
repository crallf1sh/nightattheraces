const $=s=>document.querySelector(s);
let state=null,pendingState=null,revealTimer=null,suppressedAnnouncementKey=null;
const esc=x=>String(x).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function showReveal({place,name,prize,icon='✕',gift=false}){
  $('.burst').textContent=icon;
  $('.burst').classList.toggle('gift-icon',gift);
  $('#place').textContent=place;
  $('#winner').textContent=name;
  $('#prize').textContent=prize;
  $('#prize').hidden=!prize;
  $('#reveal').hidden=false;
}

function layoutCards(count){
  const board=$('#screenCards');
  if(!count){board.removeAttribute('style');return}
  const availableWidth=board.parentElement.clientWidth||1200;
  const availableHeight=Math.max(180,window.innerHeight-125);
  const columns=Math.max(1,Math.ceil(Math.sqrt(count*availableWidth/availableHeight)));
  const rows=Math.ceil(count/columns);
  const cellWidth=availableWidth/columns;
  const cellHeight=availableHeight/rows;
  const fontPx=Math.max(3,Math.min(36,Math.min(cellWidth,cellHeight)*.28));
  board.style.height=`${availableHeight}px`;
  board.style.marginTop='0';
  board.style.gap=count>100?'2px':count>30?'4px':'8px';
  board.style.gridTemplateColumns=`repeat(${columns},minmax(0,1fr))`;
  board.style.gridTemplateRows=`repeat(${rows},minmax(0,1fr))`;
  const compact=fontPx<14||count>80;
  const labels=[...board.querySelectorAll('.card-name')];
  const longestName=Math.max(1,...labels.map(label=>label.textContent.length));
  const usableWidth=Math.max(1,cellWidth-4);
  const usableHeight=Math.max(1,cellHeight-4);
  let uniformFont=Math.max(1,Math.min(fontPx,usableWidth/(Math.ceil(longestName/2)*.7),usableHeight/(2*1.18)));
  board.querySelectorAll('.card').forEach(card=>{
    const label=card.querySelector('.card-name');
    card.style.minHeight='0';
    card.style.height='100%';
    card.style.maxWidth='100%';
    card.style.padding=compact?'1px':'.35em';
    label.style.maxWidth='100%';
    label.style.fontSize=`${uniformFont}px`;
    label.style.fontWeight=compact?'500':'800';
    label.style.lineHeight='1.18';
    card.style.overflow='hidden';
    label.style.display='block';
    label.style.WebkitLineClamp='unset';
    label.style.WebkitBoxOrient='initial';
    label.style.whiteSpace='normal';
    label.style.overflow='visible';
    label.style.textOverflow='clip';
    label.style.wordBreak='normal';
    label.style.overflowWrap='anywhere';
  });
  // One shared shrink pass keeps every card visually equal while ensuring the
  // longest rendered name still fits within two lines.
  for(let attempt=0;attempt<24;attempt++){
    if(labels.every(label=>label.scrollHeight<=uniformFont*2*1.18+.5))break;
    uniformFont*=.85;
    labels.forEach(label=>label.style.fontSize=`${uniformFont}px`);
  }
}

function boardName(participant,count){
  return participant.name;
}

function render(s){
  state=s;
  if(!s){$('#screenMeta').textContent='Waiting for the event operator';$('#screenCards').innerHTML='';return}
  const rem=s.participants.filter(p=>p.status==='remaining');
  $('#screenMeta').textContent=s.mode==='finalFive'?'FINAL FIVE':'ROUND '+s.round.number;
  $('#remain').textContent=`${rem.length} REMAINING`;
  $('#screenCards').innerHTML=rem.map(p=>`<div class="card" data-id="${p.id}" title="${esc(p.name)}"><span class="card-name">${esc(boardName(p,rem.length))}</span></div>`).join('');
  layoutCards(rem.length);
  $('#recent').innerHTML=s.recentEliminations.map(x=>`<div class="recent">${esc(x.name)}<small>Round ${x.round}</small></div>`).join('')||'<p>No names pulled yet.</p>';
  const a=s.finalFour?.announcement;
  const announcementKey=a?`${a.place}:${a.name}`:null;
  if(a&&announcementKey!==suppressedAnnouncementKey)showTimedReveal({...a,icon:'💵',gift:true},20000,announcementKey);else $('#reveal').hidden=true;
}

function showTimedReveal(reveal,duration=10000,announcementKey=null){
  clearTimeout(revealTimer);
  showReveal(reveal);
  revealTimer=setTimeout(()=>{
    revealTimer=null;
    if(announcementKey)suppressedAnnouncementKey=announcementKey;
    $('#reveal').hidden=true;
    if(pendingState){const next=pendingState;pendingState=null;render(next)}
  },duration);
}

const socket=io();
socket.emit('screen');
socket.on('state',s=>{
  if(revealTimer){pendingState=s;return}
  render(s);
});
socket.on('elimination',event=>{
  // Final Five results remain visible until the Admin operator dismisses them.
  if(event.final?.place||state?.mode==='finalFive'){const final={...event.final,place:event.final?.place||'FINAL FIVE',name:event.final?.name||event.participant.name,prize:event.final?.prize||'',icon:'💵',gift:true};showTimedReveal(final,20000,`${final.place}:${final.name}`);return}
  showTimedReveal({place:'NAME DRAWN',name:event.participant.name,prize:'',icon:'✕'});
});
socket.on('gift-card',event=>showTimedReveal({place:'GIFT CARD WINNER',name:event.name,prize:event.prize,icon:'🎁',gift:true}));
fetch('/api/state').then(r=>r.json()).then(x=>render(x.state));
window.addEventListener('resize',()=>{if(state)layoutCards(state.participants.filter(p=>p.status==='remaining').length)});
