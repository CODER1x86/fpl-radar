let LANG='en';try{LANG=localStorage.getItem('fr-lang')||'en'}catch(e){}
const t=(k,v={})=>(I18N[LANG][k]??I18N.en[k]??k).replace(/\{(\w+)\}/g,(_,x)=>v[x]??'');
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const LOC=()=>LANG==='ar'?'ar-EG':'en-GB';
const ago=ts=>{if(!ts)return'—';const m=Math.max(0,(Date.now()-Date.parse(ts))/6e4);const rt=new Intl.RelativeTimeFormat(LOC(),{numeric:'auto'});return m<1?rt.format(0,'minute'):m<60?rt.format(-Math.round(m),'minute'):m<1440?rt.format(-Math.round(m/60),'hour'):rt.format(-Math.round(m/1440),'day')};
const when=ts=>ts?new Date(ts).toLocaleString(LOC(),{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'—';
const f1=v=>v==null?'—':(+v).toFixed(1),pc=v=>v==null?'—':Math.round(v*100)+'%',sum=a=>a.reduce((x,y)=>x+y,0);
let D=null,gwi=0,who='',labKey='plan';
const SCN={plan:'scPlan',current:'scCurrent',model:'scModel',budget:'scBudget',elite:'scElite',experts:'scExperts'};

function applyLang(){document.documentElement.lang=LANG;document.documentElement.dir=LANG==='ar'?'rtl':'ltr';
 $('#lang').textContent=LANG==='ar'?'🏴󠁧󠁢󠁥󠁮󠁧󠁿 EN':'🇪🇬 AR';
 document.querySelectorAll('[data-t]').forEach(el=>el.textContent=t(el.dataset.t));
 $('#q').placeholder=t('search');const pv=$('#pos').value,sv=$('#sort').value;
 $('#pos').innerHTML=`<option value="">${t('allPos')}</option>`+['GKP','DEF','MID','FWD'].map(x=>`<option>${x}</option>`).join('');$('#pos').value=pv;
 $('#sort').innerHTML=[['b1','sNext'],['b5','s5'],['u1','sP90'],['c','sPrice'],['own','sOwn']].map(([v,k])=>`<option value="${v}">${t(k)}</option>`).join('');if(sv)$('#sort').value=sv;
 $('#who').innerHTML=[['','all'],['mine','mine'],['watch','watch']].map(([w,k])=>`<button data-w="${w}" class="${w===who?'on':''}">${t(k)}</button>`).join('');
 $('#who').querySelectorAll('button').forEach(b=>b.onclick=()=>{who=b.dataset.w;applyLang()});
 if(D){render();if(window.onData)onData()}}
$('#lang').onclick=()=>{LANG=LANG==='ar'?'en':'ar';try{localStorage.setItem('fr-lang',LANG)}catch(e){}applyLang()};
// 5 tabs, each with a few sub-pages (segmented control); last choice remembered per tab
function seg(view,p){const box=document.querySelector(`[data-seg="${view}"]`);if(!box)return;
 const ps=[...box.querySelectorAll('button')].map(b=>b.dataset.p);if(!ps.includes(p)){let s=null;try{s=localStorage.getItem('fr-seg-'+view)}catch(e){}p=ps.includes(s)?s:ps[0]}
 box.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));
 document.querySelectorAll(`[data-pane^="${view}:"]`).forEach(x=>x.classList.toggle('on',x.dataset.pane===view+':'+p));
 try{localStorage.setItem('fr-seg-'+view,p)}catch(e){}if(window.onPane)onPane(view,p)}
function go(v,p){document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('on',x.dataset.v===v));document.querySelectorAll('.view').forEach(x=>x.classList.toggle('on',x.id==='v-'+v));
 seg(v,p);scrollTo(0,0);try{localStorage.setItem('fr-tab3',v)}catch(e){}}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>go(b.dataset.v));
document.querySelectorAll('[data-seg]').forEach(box=>box.querySelectorAll('button').forEach(b=>b.onclick=()=>{seg(box.dataset.seg,b.dataset.p);scrollTo(0,0)}));
$('#sysbtn').onclick=()=>go('explore','system');
document.addEventListener('click',e=>{const g=e.target.closest('[data-go]');if(g){const [v,p]=g.dataset.go.split(':');go(v,p)}});

function tick(){const G=D&&D.gw;if(!G||!G.next_deadline)return;const ms=Date.parse(G.next_deadline)-Date.now();
 if(ms<=0){$('#cd').textContent=t('passed');return}const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);
 $('#cd').textContent=(d?d+'d ':'')+h+'h '+String(m).padStart(2,'0')+'m';$('#cd').className='cd num '+(ms<36e5*3?'bad':ms<864e5?'warn':'')}
setInterval(tick,15000);

const shirt=gk=>`<svg viewBox="0 0 64 64"><path d="M22 6l-12 6-8 14 9 5 4-6v33h34V25l4 6 9-5-8-14-12-6c-2 5-6 8-10 8s-8-3-10-8z" fill="${gk?'#ffd166':'#ffffff'}" stroke="#1d0a20" stroke-width="2"/><path d="M22 6c2 5 6 8 10 8s8-3 10-8" fill="none" stroke="${gk?'#1d0a20':'#963cff'}" stroke-width="3"/></svg>`;
const POSN={GKP:1,DEF:2,MID:3,FWD:4};
function tileFn(o){const by=D.byId;return (i,n)=>{const p=by[i]||{n:'?',t:'',b:[],st:'a'};const isNew=o.newIds&&o.newIds.has(i);
 return `<div class="pl ${o.mark&&p.mine?'mine':''} ${isNew?'new':''}">${i===o.cap?'<span class="bdg">C</span>':i===o.vice?'<span class="bdg">V</span>':''}${n!=null?`<span class="bdg sub">${n}</span>`:''}${p.st&&p.st!=='a'?'<span class="flg">!</span>':''}${shirt(p.pos==='GKP')}<div class="nm">${esc(p.n)}</div><div class="pt num">${o.val(p)} · ${esc(p.t)}</div></div>`}}
function pitchHTML(ids,o){const by=D.byId,tile=tileFn(o);const lines=[4,3,2,1].map(k=>ids.filter(i=>by[i]&&POSN[by[i].pos]===k));
 return '<div class="pitch-wrap"><div class="pitch">'+lines.filter(r=>r.length).map(r=>'<div class="line">'+r.map(i=>tile(i)).join('')+'</div>').join('')+'</div></div>'}
function benchHTML(ids,o){const tile=tileFn(o);return `<div class="bench">${ids.map((i,k)=>tile(i,D.byId[i]&&D.byId[i].pos==='GKP'?t('gk2'):k)).join('')}</div>`}

function distBlock(dist,xp){if(!dist)return `<div class="xp num">${f1(xp)} <small>${t('expPts')}</small></div>`;
 const hi=Math.max(100,dist.p90+10),x=v=>Math.max(0,Math.min(100,v/hi*100));
 return `<div class="xp num">${f1(dist.mean)} <small>${t('expPts')}</small></div>
 <div class="bar"><i style="inset-inline-start:${x(dist.p10)}%;width:${x(dist.p90)-x(dist.p10)}%"></i><em style="inset-inline-start:${x(dist.p50)}%"></em></div>
 <div class="small mute">${t('range')}: <b class="num">${dist.p10}–${dist.p90}</b></div>
 <div class="probs">${Object.entries(dist.prob).map(([k,v])=>`<span>${t('chance',{k})} <b class="num">${pc(v)}</b></span>`).join('')}</div>
 <div class="small mute" style="margin-top:4px">${t('dist')}</div>`}


const syncKey=()=>`fr-sync-${TEAM}`;
function getSync(){try{const s=JSON.parse(localStorage.getItem(syncKey())||'null');return s&&D&&D.gw&&s.gw===D.gw.next&&Array.isArray(s.squad)&&s.squad.length===15?s:null}catch(e){return null}}
function setSync(s){try{s?localStorage.setItem(syncKey(),JSON.stringify(s)):localStorage.removeItem(syncKey())}catch(e){}loadTeam()}
const doneKey=()=>`fr-done-${TEAM}-${(D&&D.gw&&D.gw.next)||0}`;
function getDone(){try{return JSON.parse(localStorage.getItem(doneKey())||'[]')}catch(e){return[]}}
function setDone(a){try{localStorage.setItem(doneKey(),JSON.stringify(a))}catch(e){}loadTeam()}
function markDone(o,i){const a=getDone();if(!a.some(x=>x[0]===o))a.push([o,i]);setDone(a)}
function undoDone(o){setDone(getDone().filter(x=>x[0]!==o))}
let PROXY='',TEAM=null,PJ=null,BASE=null,TEAMDATA=null,OWNER=null;
const prox=path=>fetch(PROXY+'/api'+path,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
function offline(){$('#upd').textContent='offline';$('#banner').innerHTML=`<div class="banner bad">⚠️ ${t('nodata')}<div class="small" style="font-weight:500;margin-top:4px">${t('fixOffline')}</div><button class="btn sec" onclick="location.reload()">${t('retry')}</button></div>`}
async function load(){
 let dash,pj,px;
 try{[dash,pj,px]=await Promise.all([fetch('data/dashboard.json?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json()),
   fetch('data/players.json?ts='+Date.now(),{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
   fetch('proxy.json?ts='+Date.now(),{cache:'no-store'}).then(r=>r.ok?r.json():{}).catch(()=>({}))])}catch(e){offline();return}
 checkVersion();
 D=dash;PJ=pj;PROXY=(px&&px.proxy)||'';OWNER=(D.status&&D.status.owner)||4969994;BASE=D.projection;
 try{TEAM=+localStorage.getItem('fr-team')||null}catch(e){}
 if(!TEAM){showLogin();return}
 await loadTeam()}
async function loadTeam(){
 $('#upd').textContent='…';
 if(!PROXY){TEAMDATA=null}else{
  try{const cur=(D.gw&&D.gw.current)||null;
   const [entry,history,transfers]=await Promise.all([prox(`/entry/${TEAM}/`),prox(`/entry/${TEAM}/history/`),prox(`/entry/${TEAM}/transfers/`).catch(()=>[])]);
   const ev=entry.current_event||cur;const picks=ev?await prox(`/entry/${TEAM}/event/${ev}/picks/`).catch(()=>null):null;
   TEAMDATA={entry,history,transfers,picks}}catch(e){TEAMDATA={error:String(e.message||e)}}}
 if(TEAMDATA&&TEAMDATA.error&&TEAM!==OWNER){showLogin(t('loginErr'));return}
 const DONE=getDone(),SY=getSync();
 if(SY&&TEAMDATA&&TEAMDATA.picks&&PJ&&BASE){ // squad read from the manager's screenshot overrides the public picks until the deadline
  const td={...TEAMDATA,picks:{...TEAMDATA.picks,picks:SY.squad.map((e,k)=>({element:e,position:k+1})),entry_history:{...TEAMDATA.picks.entry_history,bank:Math.round(SY.bank*10)}}};
  D.projection=FREngine.buildForTeam(PJ,BASE,td,[],{ft:SY.ft});D.projection.synced=SY}
 else if((TEAM!==OWNER||DONE.length)&&TEAMDATA&&TEAMDATA.picks&&PJ&&BASE){D.projection=FREngine.buildForTeam(PJ,BASE,TEAMDATA,DONE)}else D.projection=BASE;
 D.byId=D.projection?Object.fromEntries(D.projection.players.map(p=>[p.id,p])):{};
 // make sure every id referenced anywhere has a row (rows come from the all-players table)
 if(PJ){const all=FREngine.players(PJ),mine=new Set(D.projection?D.projection.squad:[]);for(const id in all)if(!D.byId[id])D.byId[id]={...all[id],mine:mine.has(+id)}}
 hideLogin();render();renderProfile();renderPush();if(window.onData)onData()}
function showLogin(err){document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));$('#v-login').classList.add('on');$('#nav').style.display='none';
 $('#login-err').textContent=err||'';$('#upd').textContent=t('welcomeTo')}
function hideLogin(){$('#v-login').classList.remove('on');$('#nav').style.display='';if(!document.querySelector('.view.on')){let v='home';try{v=localStorage.getItem('fr-tab3')||'home'}catch(e){}go($('#v-'+v)?v:'home')}}
function doLogin(id){id=parseInt(String(id).replace(/\D/g,''),10);if(!id){$('#login-err').textContent=t('loginBad');return}
 TEAM=id;try{localStorage.setItem('fr-team',id)}catch(e){}go('home');loadTeam()}

async function checkVersion(){if(APP_V.startsWith('__'))return;try{const r=await fetch('version.json?ts='+Date.now(),{cache:'no-store'});const v=(await r.json()).v;
 if(v&&v!==APP_V){let n=0;try{n=+sessionStorage.getItem('fr-rl')||0}catch(e){}
  if(n<2){try{sessionStorage.setItem('fr-rl',n+1)}catch(e){}location.replace(location.pathname+'?v='+v);return}
  if(!$('#newver'))document.body.insertAdjacentHTML('afterbegin',`<button id="newver" class="btn" style="position:fixed;z-index:9;top:calc(env(safe-area-inset-top) + 60px);left:16px;right:16px;width:auto" onclick="location.replace(location.pathname+'?v=${v}')">${t('newVer')}</button>`)}
 else{try{sessionStorage.removeItem('fr-rl')}catch(e){}}}catch(e){}}
function render(){const S=D.status||{},P=D.projection,G=D.gw||{};
 $('#dot').style.background=S.health==='ok'&&S.freshness==='current'?'var(--neon)':S.health==='failing'?'var(--mag)':'#ffb547';
 $('#upd').textContent=t('data',{t:ago(S.data_observed_at||S.last_ingest_ok)});
 $('#banner').innerHTML=(S.freshness!=='current'||S.health==='failing')?`<div class="banner ${S.freshness==='stale'?'':'bad'}">⚠️ ${S.freshness==='stale'?t('stale',{m:S.data_age_minutes??'?'}):S.freshness==='current'?'':t('nodata')}<div class="small" style="font-weight:500;margin-top:4px">${S.health==='failing'?t('fixFail'):t('fixStale')}</div></div>`:'';
 $('#dl-gw').textContent=t('deadline',{g:G.next??'?'});$('#dl-local').textContent=when(G.next_deadline);tick();
 const A=(D.alerts||[]).slice().reverse(),al=a=>`<div class="al sev-${a.severity}"><b>${esc(a.title)}</b><div class="small">${esc(a.what)}</div><div class="mute small">${esc(a.action||'')} · ${ago(a.sent_at)}</div></div>`;
 $('#alerts-top').innerHTML=TEAM&&TEAM!==OWNER?`<div class="empty">${t('ownerOnly')}</div>`:A.length?A.slice(0,3).map(al).join(''):`<div class="empty">${t('noAlerts')}</div>`;
 $('#alerts-all').innerHTML=A.length?A.slice(0,40).map(al).join(''):`<div class="empty">—</div>`;
 const plan=S.deadline_plan||[],nx=plan.find(r=>Date.parse(r.at)>Date.now());
 $('#next-rem').textContent=nx?t('nextAlert',{l:nx.label==='final'?t('final'):nx.label,t:when(nx.at)}):t('allSent');
 $('#plan').innerHTML=plan.map(r=>`<div class="row"><span>${r.label==='final'?t('final'):r.label}${r.moved?` <span class="pill">${t('moved')}</span>`:''}</span><span class="v small">${when(r.at)} ${Date.parse(r.at)<=Date.now()?'✓':''}</span></div>`).join('')||`<div class="empty">—</div>`;
 renderSys(S,P);renderPhase(S,G,P);if(!P)return;
 renderPlan(P);renderLab(P);renderChips(P);renderMore(P);drawPlayers();renderHome(P)}

// update mode: quiet between gameweeks, focus window in the last 36 h, live while matches run
function renderPhase(S,G,P){const c=S.cadence||{},ph=c.phase||'focus',m=c.interval_minutes||10;
 $('#phase').innerHTML=`<span class="phase ${ph}"><i></i>${t(ph==='quiet'?'phQuiet':ph==='live'?'phLive':'phFocus')}</span>`;
 $('#phase-txt').textContent=ph==='quiet'?t('phQuietTxt',{t:when(c.focus_from)}):ph==='live'?t('phLiveTxt',{t:when(c.focus_from)}):t('phFocusTxt',{m});
 const old=P&&G.next&&P.gws&&P.gws[0]!==G.next;
 $('#plan-notice').innerHTML=old?`<div class="notice">${t('oldPlan',{g:P.gws[0],n:G.next,t:when(c.focus_from)})}</div>`:''}
function renderHome(P){const pl=P.plan||{moves:[]},L=(pl.lineups||[])[0]||P.lineups[0]||{},C=(P.chips||{}).chips||[],now=C.find(c=>c.verdict==='use_now');
 const done=(pl.done||[]).length,n=pl.moves.length;
 const tr=done?t('madeN',{n:done})+(n?' + '+t('makeN',{n}):''):n?pl.moves.map(m=>`${m.out_n} → ${m.in_n}`).join(', '):t('noMove');
 const arrow='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
 const row=(k,v,go)=>`<button class="todo" data-go="${go}"><span class="k">${k}</span><span class="v">${esc(v)}</span>${arrow}</button>`;
 $('#home-todo').innerHTML=row(t('todoTr'),tr,'planner:plan')+row(t('todoCap'),L.captain_n?`${L.captain_n} (VC ${L.vice_n})`:'—','planner:plan')
  +row(t('todoChip'),now?t('chipUse',{c:now.name}):t('chipNone'),'planner:chips')
  +row(t('todoSync'),P.synced?t('syncActive',{t:when(P.synced.ts)}):t('srcPublic'),'squad:sync')}

function renderPlan(P){const pl=P.plan||{moves:[]},L=(pl.lineups||[])[0]||P.lineups[0];
 const hits=pl.hits||0,n=pl.moves.length;
 const nd=(pl.done||[]).length;$('#hero-sum').innerHTML=`<div class="pill hero-pill">${t('heroSum',{n:nd?t('madeN',{n:nd})+(n?' + '+t('makeN',{n}):''):(n?t('makeN',{n}):t('heroNone')),xp:f1(L&&L.dist?L.dist.mean:L&&L.xp)})}</div>`;
 // 1 transfers
 let h='';const done=pl.done||[];
 const mvRow=(m,k,isDone)=>`<div class="move"><span class="mn num">${isDone?'✓':k+1}</span><span><span class="bad">▼ ${t('out')}</span> ${esc(m.out_n)}<br><span class="ok">▲ ${t('in')}</span> <b>${esc(m.in_n)}</b> <span class="mute small">£${(D.byId[m.in]||{}).c??'?'}m</span></span><span class="g num">${isDone?`<button class="mini" data-undo="${m.out}">${t('undo')}</button>`:`+${m.gain}<br><span class="mute small">${m.type==='free'?t('free'):t('hit')}</span><br><button class="mini" data-done="${m.out}:${m.in}">${t('markDone')}</button>`}</span></div>`;
 if(done.length){h+=`<div class="big-line ok">${t('madeN',{n:done.length})}${pl.hits_done?` · <span class="bad">-${pl.hits_done*4}</span>`:''}</div>`+done.map((m,k)=>mvRow(m,k,true)).join('');
  h+=n?`<div class="big-line" style="margin-top:10px">${t('extraSug')}</div>`+pl.moves.map((m,k)=>mvRow(m,k,false)).join(''):`<p class="small">${t('noMore')}</p>`}
 else if(n){h+=`<div class="big-line">${t('makeN',{n})} · <span class="${hits?'bad':'ok'}">${hits?t('withHits',{h:hits,p:hits*4}):t('freeOnly')}</span></div>`+pl.moves.map((m,k)=>mvRow(m,k,false)).join('')}
 else h+=`<div class="big-line">${t('noMove')}</div>`;
 h+=`<details style="margin-top:6px"><summary>${t('addOwn')}</summary><div class="filters" style="margin-top:8px"><select id="own-out"></select><select id="own-in"></select></div><button class="btn sec" id="own-add">${t('addBtn')}</button></details>`;
 h+=`<div class="row"><span class="k">${t('gainW')}</span><span class="v num ok">+${f1(pl.net)}</span></div><div class="row"><span class="k">${t('bankAfter')}</span><span class="v num">£${pl.bank_after??'—'}m</span></div><div class="row"><span class="k">${t('ftNext')}</span><span class="v num">${pl.ft_after??'—'}</span></div>`;
 if(pl.stop&&pl.stop.next_out_n)h+=`<details><summary>${t('stopWhy')}</summary><p class="small">${t('stopTxt',{o:esc(pl.stop.next_out_n),i:esc(pl.stop.next_in_n),g:pl.stop.next_gain,t:pl.stop.threshold,r:pl.stop.reason})}</p></details>`;
 $('#s-transfers').innerHTML=h;
 $('#s-transfers').querySelectorAll('[data-done]').forEach(b=>b.onclick=()=>{const [o,i]=b.dataset.done.split(':').map(Number);markDone(o,i)});
 $('#s-transfers').querySelectorAll('[data-undo]').forEach(b=>b.onclick=()=>undoDone(+b.dataset.undo));
 const sq=(P.squad||[]).map(i=>D.byId[i]).filter(Boolean);$('#own-out').innerHTML=`<option value="">${t('outPick')}</option>`+sq.map(p=>`<option value="${p.id}">${esc(p.n)} (${p.pos})</option>`).join('');
 $('#own-out').onchange=()=>{const o=D.byId[+$('#own-out').value];$('#own-in').innerHTML=o?`<option value="">${t('inPick')}</option>`+Object.values(D.byId).filter(p=>p.pos===o.pos&&!(P.squad||[]).includes(p.id)).sort((a,b)=>(b.b?b.b[0]:0)-(a.b?a.b[0]:0)).slice(0,150).map(p=>`<option value="${p.id}">${esc(p.n)} · ${esc(p.t)} · £${p.c}m</option>`).join(''):''};
 $('#own-add').onclick=()=>{const o=+$('#own-out').value,i=+$('#own-in').value;if(o&&i)markDone(o,i)};
 // 2 lineup
 if(L){const newIds=new Set(pl.moves.map(m=>m.in));const o={cap:L.captain,vice:L.vice,val:p=>f1(p.b[0]),newIds};
  $('#s-lineup').innerHTML=pitchHTML(L.xi,o)+`<div class="small mute" style="margin:8px 0 4px">${t('benchOrder')}</div>`+benchHTML(L.bench,o)+`<p class="small">${t('xpTeam',{xp:f1(L.xp),f:L.formation})}</p>`;
  const caps=L.xi.map(i=>D.byId[i]).filter(Boolean).sort((a,b)=>b.b[0]-a.b[0]).slice(0,4);
  $('#s-captain').innerHTML=`<div class="row"><span class="k">${t('capRow')}</span><span class="v">${esc(L.captain_n)}</span></div><div class="row"><span class="k">${t('viceRow')}</span><span class="v">${esc(L.vice_n)}</span></div><p class="small mute">${t('capWhy')}</p>`+caps.map(p=>`<div class="row small"><span>${esc(p.n)} <span class="mute">${esc(p.t)}</span></span><span class="num">${f1(p.b[0])} xP · P90 ${f1(p.u1)} · ≥10 ${pc(p.h1)}</span></div>`).join('')}
 // 4 chip
 const C=(P.chips||{}).chips||[],now=C.find(c=>c.verdict==='use_now');
 $('#s-chip').innerHTML=`<div class="big-line">${now?t('chipUse',{c:now.name}):t('chipNone')}</div>`+C.filter(c=>c.available).map(c=>`<div class="row small"><span>${esc(c.name)}</span><span>${t('verdict_'+c.verdict)}${c.best_gw?` · GW${c.best_gw}`:''}</span></div>`).join('')+`<button class="btn sec" data-go="planner:chips">${t('chipDetail')}</button>`;
 const fl=P.players.filter(p=>p.mine&&p.st!=='a');
 $('#flags').innerHTML=fl.length?fl.map(p=>`<div class="row"><span><b>${esc(p.n)}</b> <span class="mute small">${esc(p.t)}</span><br><span class="mute small">${esc(p.news)}</span></span><span class="pill warn num">${p.st}${p.ch!=null?' '+p.ch+'%':''}</span></div>`).join(''):`<div class="ok">${t('allFit')}</div>`}

function renderLab(P){const SC=P.scenarios||[];if(!SC.find(s=>s.key===labKey))labKey=SC[0]?SC[0].key:'plan';
 $('#lab-chips').innerHTML=Object.keys(SCN).map(k=>{const s=SC.find(x=>x.key===k);return `<button class="${k===labKey?'on':''}" data-k="${k}" ${s?'':'disabled'}>${t(SCN[k])}</button>`}).join('');
 $('#lab-chips').querySelectorAll('button').forEach(b=>b.onclick=()=>{labKey=b.dataset.k;renderLab(P)});
 const s=SC.find(x=>x.key===labKey);
 if(!s){$('#lab-body').innerHTML=`<div class="card empty">${labKey==='experts'?t('expertsNone'):t('none')}</div>`}
 else{const plan=SC.find(x=>x.key==='plan')||{xi:[]};const inPlan=new Set(plan.xi);
  let src='';if(s.key==='model')src=t('noBudget');if(s.key==='budget')src=t('withinBudget');if(s.key==='elite'&&P.elite)src=t('eliteSrc',{n:P.elite.sample,g:P.elite.gw});
  if(s.key==='experts'&&P.experts)src=t('expertsSrc')+' '+(P.experts.sources||[]).map(x=>`<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a> (${esc(x.published)})`).join(', ')+(s.from_shortlist?` — ${t('fromShort')}`:'');
  const same=s.xi.filter(i=>inPlan.has(i)).length,notMine=s.differentials.map(i=>D.byId[i]?D.byId[i].n:i);
  $('#lab-body').innerHTML=`<div class="card"><h2>${t(SCN[s.key])} · GW${P.gws[0]}<small class="num">£${s.cost}m</small></h2>${distBlock(s.dist,s.xp)}<p class="small mute">${src}</p></div>
  <div class="card">${pitchHTML(s.xi,{cap:s.captain,vice:s.vice,val:p=>f1(p.b[0]),mark:true})}<div class="legend">${t('overlap')}: <b class="num">${same}/11</b> · ${t('diff')}: ${esc(notMine.join(', ')||'—')}</div></div>`}
 $('#lab-table').innerHTML=`<tr><th class="l"></th><th>${t('xpShort')}</th><th>${t('p50')}</th><th>${t('p90')}</th><th>${t('p60')}</th></tr>`+SC.map(s=>`<tr class="${s.key===labKey?'sel':''}"><td class="l">${t(SCN[s.key])}</td><td class="num">${f1(s.dist?s.dist.mean:s.xp)}</td><td class="num">${s.dist?s.dist.p50:'—'}</td><td class="num">${s.dist?s.dist.p90:'—'}</td><td class="num">${s.dist?pc(s.dist.prob['60']):'—'}</td></tr>`).join('')}

function renderChips(P){const CP=P.chips;if(!CP){$('#chips-body').innerHTML=`<div class="card empty">${t('none')}</div>`;return}
 $('#chips-body').innerHTML=CP.chips.map(c=>{const ser=c.series||[],mx=Math.max(c.threshold*1.3,...ser.map(x=>x.value||0),1);
  const bars=ser.map(x=>`<div class="cb"><div class="cbv num">${f1(x.value)}</div><div class="cbb"><i style="height:${Math.max(2,x.value/mx*100)}%" class="${x.value>=c.threshold?'hot':''}"></i><em style="bottom:${c.threshold/mx*100}%"></em></div><div class="cbl num">GW${x.gw}</div></div>`).join('');
  const who=c.chip==='3xc'&&ser.length?' · '+ser.map(x=>D.byId[x.who]?D.byId[x.who].n:'').filter((v,i,a)=>a.indexOf(v)===i).join('/'):'';
  return `<div class="card"><h2>${esc(c.name)}<span class="pill ${c.verdict==='use_now'||c.verdict==='use_before_expiry'?'ok':''}">${t('verdict_'+c.verdict)}</span></h2>
  <div class="small mute">${c.available?t('chipAvail'):t('chipUsed',{g:c.used_gw})} · ${t('chipExp',{g:c.expires_gw,n:c.gws_left_in_half})}</div>
  ${c.available?`<div class="chart">${bars}</div><div class="small">${t('chipBest',{g:c.best_gw,v:f1(c.chip==='wildcard'?c.value_now:Math.max(...ser.map(x=>x.value)))})}${who} · ${t('chipThr',{t:c.threshold})}</div><div class="small mute">${t('chipWhy_'+c.chip,{m:c.moves??''})}</div>`:''}</div>`}).join('')+`<p class="small mute">${t('chipNote')}</p>`}

function renderMore(P){const pl=P.plan||{},LS=(pl.lineups&&pl.lineups.length?pl.lineups:P.lineups);
 $('#gw-chips').innerHTML=P.gws.map((g,i)=>`<button class="${i===gwi?'on':''}" data-i="${i}">GW${g}</button>`).join('');
 $('#gw-chips').querySelectorAll('button').forEach(x=>x.onclick=()=>{gwi=+x.dataset.i;renderMore(P)});
 const L=LS[gwi];if(L){const o={cap:L.captain,vice:L.vice,val:p=>f1(p.b[gwi])};$('#pitch').innerHTML=pitchHTML(L.xi,o).replace('<div class="pitch-wrap">','').replace(/<\/div>$/,'');$('#benchrow').innerHTML=L.bench.map((i,k)=>tileFn(o)(i,D.byId[i]&&D.byId[i].pos==='GKP'?t('gk2'):k)).join('');$('#team-xp').textContent=`${L.formation} · ${f1(L.xp)} xP`}
 $('#singles').innerHTML=P.transfers.best_per_out.slice(0,10).map(s=>`<div class="move"><span><span class="bad">▼</span> ${esc(s.out_n)}<br><span class="ok">▲</span> <b>${esc(s.in_n)}</b></span><span class="g num">${s.gain>0?'+':''}${s.gain}</span></div>`).join('')||`<div class="empty">—</div>`;
 const e=P.elite;$('#elite-table').innerHTML=e?`<p class="small mute">${t('eliteSrc',{n:e.sample,g:e.gw})}</p><div class="tbl"><table><tr><th class="l"></th><th>${t('eo')}</th><th>${t('own')}</th><th>${t('capt')}</th></tr>${e.players.slice(0,25).map(r=>{const p=D.byId[r.id];return `<tr><td class="l">${esc(p?p.n:r.id)} <span class="mute">${esc(p?p.t:'')}</span>${p&&p.mine?' ●':''}</td><td class="num">${r.eo}%</td><td class="num">${r.own}%</td><td class="num">${r.capt}%</td></tr>`}).join('')}</table></div>`:`<div class="empty">${t('none')}</div>`}

function drawPlayers(){if(!D||!D.projection)return;const q=$('#q').value.trim().toLowerCase(),ps=$('#pos').value,sk=$('#sort').value||'b1';
 const key=p=>sk==='b1'?p.b[0]:sk==='b5'?sum(p.b):sk==='u1'?(p.u1??0):p[sk];
 const L=D.projection.players.filter(p=>(!q||p.n.toLowerCase().includes(q)||String(p.t).toLowerCase().includes(q))&&(!ps||p.pos===ps)&&(!who||p[who])).sort((a,b)=>key(b)-key(a)).slice(0,60);
 $('#plist').innerHTML=L.map(p=>`<div class="prow"><div class="top"><span><b>${esc(p.n)}</b>${p.mine?` <span class="pill">${t('mine')}</span>`:''} <span class="mute small">${esc(p.t)} · ${p.pos} · <span class="num">£${p.c}m</span></span></span>${p.st!=='a'?`<span class="pill warn num">${p.st}${p.ch!=null?' '+p.ch+'%':''}</span>`:''}</div><div class="nums num" dir="ltr"><span>xP <b>${f1(p.b[0])}</b></span><span>5GW <b>${f1(sum(p.b))}</b></span><span>P90 <b>${f1(p.u1)}</b></span><span>≥10 <b>${pc(p.h1)}</b></span><span>start <b>${pc(p.sp)}</b></span><span>own <b>${p.own}%</b></span></div></div>`).join('')||`<div class="empty">—</div>`}
['#q','#pos','#sort'].forEach(s=>$(s).addEventListener('input',drawPlayers));

function renderSys(S,P){const src=S.sources||{};
 $('#health').innerHTML=[[t('status'),`<span class="pill ${S.health==='ok'?'ok':'warn'}">${S.health==='ok'?t('ok'):esc(S.health)}</span>`],[t('lastIngest'),ago(S.last_ingest_ok)],[t('lastModel'),ago(P&&P.ts)],[t('lastAlert'),ago(S.last_alert_check)],[t('lastVal'),ago(S.last_validate_ok)],[t('fails'),`<span class="num">${S.consecutive_failures??0}</span>`],[t('channels'),esc((S.notify_channels||[]).join(', ')||'—')]]
  .map(([k,v])=>`<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')+Object.entries(src).map(([n,s])=>`<div class="row"><span class="k">${esc(n)}</span><span class="v small">${s.last_error?'<span class="bad">'+esc(s.last_error)+'</span>':ago(s.last_ok)}</span></div>`).join('');
 const pr=(D.prices||[]).slice().reverse();$('#prices').innerHTML=pr.length?pr.slice(0,30).map(r=>`<div class="row"><span>${esc(r.name)}</span><span class="v small num">£${r.old} → £${r.new} · ${when(r.ts)}</span></div>`).join(''):`<div class="empty">${t('noPrices')}</div>`;
 if(!P)return;const bd=P.blanks_doubles||{};$('#bd').innerHTML=Object.entries(bd).filter(([g,x])=>x.doubles.length||x.blanks.length).map(([g,x])=>`GW${g}: DGW ${x.doubles.join(', ')||'—'} · BGW ${x.blanks.join(', ')||'—'}`).join('<br>')||t('noDbl');
 const FX=P.fixtures||{};$('#fx').innerHTML='<tr><th></th>'+P.gws.map(g=>`<th>${g}</th>`).join('')+'</tr>'+Object.keys(FX).sort().map(tm=>'<tr><th>'+tm+'</th>'+P.gws.map(g=>{const l=FX[tm][g]||[];return l.length?`<td class="d${l[0][2]}">${l.map(o=>o[0]+(o[1]==='H'?'':'*')).join('+')}</td>`:'<td class="d5">—</td>'}).join('')+'</tr>').join('');
 const V=D.validation||[];$('#val').innerHTML=V.length?V.map(v=>`<div class="row"><span>GW${v.gw} (${v.n} ${t('players')})</span><span class="v small num">MAE ${v.mae} · ${t('bias')} ${v.bias_actual_minus_proj}</span></div>`).join(''):`<p class="mute small">${t('valNone')}</p>`;
 $('#cons').innerHTML=(D.consistency||[]).map(c=>`<div class="small">${c.ok?'✅':'❌'} ${esc(c.check)}</div>`).join('')}

$('#copy').onclick=e=>{if(!D||!D.projection)return;const P=D.projection,pl=P.plan||{moves:[]},L=(pl.lineups||[])[0]||P.lineups[0];const C=(P.chips||{}).chips||[],now=C.find(c=>c.verdict==='use_now');
 const txt=[`FPL Radar — GW${P.gws[0]}`,`${t('st1')}: `+(pl.moves.length?pl.moves.map(m=>`${m.out_n} → ${m.in_n}`).join(' | '):t('noMove')),
  `XI (${L.formation}): ${L.xi_n.join(', ')}`,`${t('bench')}: ${L.bench_n.map((n,k)=>(k?k+'. ':'GK ')+n).join(', ')}`,`${t('capRow')}: ${L.captain_n} · ${t('viceRow')}: ${L.vice_n}`,`${t('st4')}: ${now?now.name:t('chipNone')}`].join('\n');
 (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>{e.target.textContent=t('copied');setTimeout(()=>e.target.textContent=t('copyPlan'),1500)}).catch(()=>prompt('',txt))};

const fmtN=n=>n==null?'—':Number(n).toLocaleString(LOC());
const CHIPN={wildcard:'WC',freehit:'FH',bboost:'BB','3xc':'TC',manager:'AM'};
function renderProfile(){const T=TEAMDATA;if(!T||!T.entry){$('#pf-name').textContent=TEAM||'—';return}
 const e=T.entry,h=T.history||{current:[],chips:[],past:[]};
 $('#upd').textContent=`${t('welcomeTo')}, ${e.name}`;$('#pf-name').textContent=e.name;$('#pf-mgr').textContent=`${e.player_first_name||''} ${e.player_last_name||''} · ID ${e.id}`;
 const last=h.current[h.current.length-1]||{};
 $('#pf-kpis').innerHTML=[[t('kPts'),fmtN(e.summary_overall_points)],[t('kOR'),fmtN(e.summary_overall_rank)],[t('kGW'),`${fmtN(e.summary_event_points)} <small>(GW${e.current_event??'?'})</small>`],[t('kVal'),last.value!=null?'£'+(last.value/10).toFixed(1)+'m':'—'],[t('kBank'),last.bank!=null?'£'+(last.bank/10).toFixed(1)+'m':'—'],[t('kTr'),fmtN(h.current.reduce((s,r)=>s+(r.event_transfers||0),0))]]
  .map(([k,v])=>`<div><span>${k}</span><b>${v}</b></div>`).join('');
 const L=((e.leagues||{}).classic||[]).slice().sort((a,b)=>(a.league_type==='x')-(b.league_type==='x'));
 $('#pf-leagues').innerHTML=L.map(l=>{const d=(l.entry_last_rank||0)-(l.entry_rank||0);return `<div class="row"><span>${esc(l.name)}</span><span class="v num">${fmtN(l.entry_rank)} ${d>0?`<span class="up">▲${fmtN(d)}</span>`:d<0?`<span class="down">▼${fmtN(-d)}</span>`:''}</span></div>`}).join('')||`<div class="empty">—</div>`;
 // rank chart (log scale, best rank at top)
 const pts=h.current.filter(r=>r.overall_rank);if(pts.length>1){const W=320,H=140,lg=v=>Math.log10(v),mn=lg(Math.min(...pts.map(r=>r.overall_rank))),mx=lg(Math.max(...pts.map(r=>r.overall_rank)));
  const x=i=>10+i*(W-20)/(pts.length-1),y=v=>10+(mx===mn?0.5:(lg(v)-mn)/(mx-mn))*(H-30);
  const path=pts.map((r,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(r.overall_rank).toFixed(1)}`).join('');
  $('#pf-chart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><path d="${path}" fill="none" stroke="var(--neon)" stroke-width="3" stroke-linejoin="round"/>${pts.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r.overall_rank)}" r="3" fill="var(--neon)"/><text x="${x(i)}" y="${H-4}" font-size="9" text-anchor="middle" fill="currentColor" opacity=".6">${r.event}</text>`).join('')}</svg><div class="small mute num">${fmtN(pts[0].overall_rank)} → ${fmtN(pts[pts.length-1].overall_rank)}</div>`}else $('#pf-chart').innerHTML=`<div class="empty">—</div>`;
 const chips={};(h.chips||[]).forEach(c=>chips[c.event]=CHIPN[c.name]||c.name);
 $('#pf-hist').innerHTML=`<tr><th>${t('gwCol')}</th><th>${t('ptsCol')}</th><th>${t('benchCol')}</th><th>${t('trCol')}</th><th>${t('gwrCol')}</th><th>${t('orCol')}</th><th>${t('chipCol')}</th></tr>`+h.current.slice().reverse().map(r=>`<tr class="click" data-gw="${r.event}"><td class="num">${r.event}</td><td class="num"><b>${r.points}</b></td><td class="num">${r.points_on_bench}</td><td class="num">${r.event_transfers}${r.event_transfers_cost?` <span class="bad">-${r.event_transfers_cost}</span>`:''}</td><td class="num">${fmtN(r.rank)}</td><td class="num">${fmtN(r.overall_rank)}</td><td>${chips[r.event]||''}</td></tr>`).join('');
 $('#pf-hist').querySelectorAll('tr.click').forEach(tr=>tr.onclick=()=>{$('#pf-hist').querySelectorAll('tr').forEach(x=>x.classList.toggle('on',x===tr));showGW(+tr.dataset.gw)});
 $('#pf-past').innerHTML=(h.past||[]).slice().reverse().map(s=>`<div class="row"><span>${esc(s.season_name)}</span><span class="v num">${fmtN(s.total_points)} · ${t('rank')} ${fmtN(s.rank)}</span></div>`).join('')||`<div class="empty">—</div>`}
async function showGW(g){const box=$('#pf-gw');box.innerHTML=`<div class="empty">…</div>`;
 try{const [pk,live]=await Promise.all([prox(`/entry/${TEAM}/event/${g}/picks/`),prox(`/event/${g}/live/`)]);
  const pts={};live.elements.forEach(e=>pts[e.id]=e.stats.total_points);
  const xi=pk.picks.filter(x=>x.position<=11).map(x=>x.element),bench=pk.picks.filter(x=>x.position>11).map(x=>x.element);
  const cap=(pk.picks.find(x=>x.is_captain)||{}).element,vice=(pk.picks.find(x=>x.is_vice_captain)||{}).element,mult={};pk.picks.forEach(x=>mult[x.element]=x.multiplier);
  const o={cap,vice,val:p=>(pts[p.id]??0)*(mult[p.id]||1)};
  box.innerHTML=`<h2 style="margin-top:12px">GW${g} · ${pk.entry_history.points} ${t('ptsCol')}${pk.active_chip?' · '+(CHIPN[pk.active_chip]||pk.active_chip):''}</h2>`+pitchHTML(xi,o)+benchHTML(bench,{...o,val:p=>pts[p.id]??0})}
 catch(e){box.innerHTML=`<div class="empty">${t('nodata')}</div>`}}

// ---- push notifications (owner's team)
let SWREG=null;if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').then(r=>SWREG=r).catch(()=>{})}
const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent),standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
function b64u2u8(s){const p='='.repeat((4-s.length%4)%4),b=atob((s+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from([...b].map(c=>c.charCodeAt(0)))}
async function renderPush(){const c=$('#push-card');if(!c)return;if(TEAM!==OWNER){c.style.display='none';return}
 let key=null;try{key=(await fetch('data/vapid.json?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json())).publicKey}catch(e){}
 let saved=null;try{saved=localStorage.getItem('fr-push-key')}catch(e){}
 const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 let html=`<h2>🔔 ${t('pushTitle')}</h2>`;
 if(isIOS&&!standalone)html+=`<p class="small">${t('pushInstall')}</p>`;
 else if(!supported)html+=`<p class="small mute">${t('pushUnsupported')}</p>`;
 else if(Notification.permission==='denied')html+=`<p class="small bad">${t('pushDenied')}</p>`;
 else if(Notification.permission==='granted'&&saved&&saved===key){c.style.display='none';return}
 else html+=(saved&&key&&saved!==key?`<p class="small warn">${t('pushRe')}</p>`:'')+`<button class="btn" id="push-btn">${t('pushBtn')}</button><p class="small mute" id="push-msg"></p>`;
 c.innerHTML=html;c.style.display='';const b=$('#push-btn');if(b)b.onclick=()=>enablePush(key)}
async function enablePush(key){const msg=$('#push-msg');try{
 if(!key)throw new Error('no key yet');const perm=await Notification.requestPermission();if(perm!=='granted'){msg.textContent=t('pushDenied');return}
 const reg=SWREG||await navigator.serviceWorker.ready;let sub=await reg.pushManager.getSubscription();
 if(sub&&localStorage.getItem('fr-push-key')!==key){await sub.unsubscribe();sub=null}
 sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u2u8(key)});
 const body='```json\n'+JSON.stringify(sub)+'\n```\nRegister this device for FPL Radar notifications.';
 window.open('https://github.com/CODER1x86/fpl-radar/issues/new?title=push-subscribe&body='+encodeURIComponent(body),'_blank');
 try{localStorage.setItem('fr-push-key',key)}catch(e){}msg.textContent=t('pushStep2')}catch(e){msg.textContent='⚠️ '+(e.message||e)}}
$('#go-login').onclick=()=>doLogin($('#tid').value);$('#tid').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin($('#tid').value)});
$('#switch-team').onclick=()=>{try{localStorage.removeItem('fr-team')}catch(e){}TEAM=null;showLogin()};
applyLang();try{const v=localStorage.getItem('fr-tab3');go(v&&$('#v-'+v)?v:'home')}catch(e){go('home')}
load();setInterval(load,5*60*1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
