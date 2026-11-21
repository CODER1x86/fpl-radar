// FPL Radar chat: Ask Radar as a full chat window with screenshot attachments (your squad or a scouted/rival squad).
// Screenshots are read ON THE PHONE (Tesseract, same reader as Squad Sync); only the matched player names go to the AI.
// Uses globals of app.js (D, PJ, TEAM, TEAMDATA, PROXY, t, esc, f1, go, $) and window.RADAR from features.js.

// ------------------------------------------------------------------ pure helpers (tested in tests/js/chat.test.js)
const CHAT = (() => {
  const xpN = (p, k) => (p && p.b ? p.b.slice(0, k).reduce((s, x) => s + (x || 0), 0) : 0);
  // mine/theirs: player ids. P: {id:{n,t,c,posn,b,...}}. bestXI(ids,P,gwIndex) -> {xp} (FREngine.bestXI in the app).
  function compare(mine, theirs, P, bestXI, k = 3) {
    const A = new Set(mine), B = new Set(theirs), by = (x, y) => xpN(P[y], k) - xpN(P[x], k);
    const shared = theirs.filter(i => A.has(i)), edges = mine.filter(i => !B.has(i)).sort(by), threats = theirs.filter(i => !A.has(i)).sort(by);
    const team = ids => { let s = 0; for (let g = 0; g < k; g++) { const r = bestXI ? bestXI(ids, P, g) : null; s += r ? r.xp : 0; } return +s.toFixed(1); };
    const next = ids => { const r = bestXI ? bestXI(ids, P, 0) : null; return r ? +r.xp.toFixed(1) : null; };
    const val = ids => +ids.reduce((s, i) => s + ((P[i] || {}).c || 0), 0).toFixed(1);
    return { shared, edges, threats, k,
      mine: { next: next(mine), horizon: team(mine), value: val(mine) },
      theirs: { next: next(theirs), horizon: team(theirs), value: val(theirs) },
      edgeXP: +edges.reduce((s, i) => s + xpN(P[i], k), 0).toFixed(1), threatXP: +threats.reduce((s, i) => s + xpN(P[i], k), 0).toFixed(1) };
  }
  // A screenshot that shares most players with the user's squad is almost surely their own team.
  const guessKind = (ids, mine) => ids.filter(i => mine.includes(i)).length >= 9 ? 'mine' : 'scout';
  // keep the last n text turns for the model (cards and images are not sent)
  const history = (msgs, n = 6) => msgs.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content).slice(-n).map(m => ({ role: m.role, content: m.content }));
  // minimal, safe formatting for model replies: escape, then **bold** and line breaks
  const fmt = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^\s*[-*•]\s+/gm, '• ').replace(/\n/g, '<br>');
  return { compare, guessKind, history, fmt, xpN };
})();

if (typeof module !== 'undefined') { module.exports = { CHAT }; }
else (() => {
  const KEY = () => `fr-chat-${TEAM}`, MAXM = 60;
  const CH = { msgs: [], scouts: [], mineShot: null, pending: [], busy: false, open: false };
  const R = () => window.RADAR || {};
  const allP = () => (R().allP ? R().allP() : {});
  const pubSquad = () => (D && D.projection && D.projection.squad) || [];
  const mySquad = () => CH.mineShot || pubSquad();
  const nm = i => (allP()[i] || {}).n || '#' + i;
  const save = () => { try { localStorage.setItem(KEY(), JSON.stringify({ msgs: CH.msgs.slice(-MAXM).map(m => { const { imgs, ...r } = m; return r; }), scouts: CH.scouts.slice(-5), mineShot: CH.mineShot, gw: D && D.gw && D.gw.next })); } catch (e) { } };
  const load = () => { try { const s = JSON.parse(localStorage.getItem(KEY()) || 'null'); if (!s) return;
    CH.msgs = s.msgs || []; CH.scouts = s.scouts || []; CH.mineShot = s.gw === (D && D.gw && D.gw.next) ? s.mineShot : null; } catch (e) { } };

  // ---- DOM ------------------------------------------------------------------------------
  document.body.insertAdjacentHTML('beforeend', `
  <button id="chat-fab" aria-label="Ask Radar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg></button>
  <div id="chat" role="dialog" aria-modal="true" aria-labelledby="chat-h" hidden>
    <div class="ch-head"><button class="ch-x" id="chat-close" aria-label="Close">‹</button><div class="ch-title"><b id="chat-h"></b><small id="chat-sub"></small></div><button class="ch-x" id="chat-new" aria-label="New chat">⟲</button></div>
    <div class="ch-body" id="chat-body" aria-live="polite"></div>
    <div class="ch-sugg" id="chat-sugg"></div>
    <div class="ch-att" id="chat-att"></div>
    <form class="ch-comp" id="chat-form">
      <label class="ch-clip" aria-label="Attach screenshot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/></svg><input type="file" accept="image/*" multiple id="chat-file"></label>
      <textarea id="chat-q" rows="1" maxlength="500"></textarea>
      <button class="ch-send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg></button>
    </form>
  </div>`);
  // the Home card becomes a launcher with quick questions
  const homeCard = $('#ask-form') && $('#ask-form').closest('.card');
  if (homeCard) homeCard.innerHTML = `<h2 data-t="askTitle">${t('askTitle')}</h2><p class="small mute" id="ask-intro"></p><div class="ch-sugg in-card" id="home-sugg"></div><div class="two"><button class="btn" id="home-chat"></button><label class="btn sec file" id="home-shot-l"><span id="home-shot"></span><input type="file" accept="image/*" multiple id="home-file"></label></div><p class="mute small" data-t="askNote">${t('askNote')}</p>`;

  const body = $('#chat-body'), q = $('#chat-q');
  function openChat(prefill) {
    if (!D || !D.projection) return; CH.open = true; $('#chat').hidden = false; document.body.classList.add('chat-on');
    if (prefill) q.value = prefill; draw(); setTimeout(() => q.focus(), 50);
  }
  function closeChat() { CH.open = false; $('#chat').hidden = true; document.body.classList.remove('chat-on'); CH.pending.forEach(a => URL.revokeObjectURL(a.url)); CH.pending = []; }

  // ---- rendering --------------------------------------------------------------------------
  const PN = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const chip = (i, cls) => { const p = allP()[i] || {}; return `<span class="pchip ${cls || ''}">${esc(p.n || '#' + i)} <i>${esc(p.t || '')} · ${f1(CHAT.xpN(p, 3))}</i></span>`; };
  function cmpCard(label, cmp) {
    const d = +(cmp.mine.horizon - cmp.theirs.horizon).toFixed(1);
    return `<div class="ccard"><div class="ch-k">${t('chCmpTitle', { l: esc(label) })}</div>
      <div class="h2h"><div><span class="small mute">${t('chYou')}</span><b class="num">${f1(cmp.mine.horizon)}</b></div><span class="vs ${d >= 0 ? 'pos' : 'neg'} num">${d > 0 ? '+' : ''}${d}</span><div><span class="small mute">${esc(label)}</span><b class="num">${f1(cmp.theirs.horizon)}</b></div></div>
      <div class="small mute" style="text-align:center">${t('chCmpSub', { k: cmp.k, a: f1(cmp.mine.next), b: f1(cmp.theirs.next) })}</div>
      <div class="ch-k">${t('chThreats', { n: cmp.threats.length, x: f1(cmp.threatXP) })}</div><div>${cmp.threats.map(i => chip(i, 'thr')).join('') || `<span class="mute small">${t('chNone')}</span>`}</div>
      <div class="ch-k">${t('chEdges', { n: cmp.edges.length, x: f1(cmp.edgeXP) })}</div><div>${cmp.edges.map(i => chip(i, 'edg')).join('') || `<span class="mute small">${t('chNone')}</span>`}</div>
      <div class="ch-k">${t('chShared', { n: cmp.shared.length })}</div><div>${cmp.shared.map(i => chip(i)).join('')}</div>
      <div class="small mute" style="margin-top:6px">${t('chCmpNote')}</div></div>`;
  }
  function squadCard(kind, r, idx) {
    const by = { 1: [], 2: [], 3: [], 4: [] }, P = allP(); r.squad.forEach(i => P[i] && by[P[i].posn].push(i));
    const miss = r.squad.filter(i => !r.seen.has(i)).length;
    return `<div class="ccard"><div class="ch-k">${t(kind === 'mine' ? 'chReadMine' : 'chReadScout', { n: r.seen.size })}</div>
      ${[1, 2, 3, 4].map(q => by[q].length ? `<div class="ch-line"><span class="pos">${PN[q]}</span>${by[q].map(i => chip(i, r.seen.has(i) ? '' : 'kept')).join('')}</div>` : '').join('')}
      ${miss && kind === 'mine' ? `<div class="small warn">${t('chKept', { n: miss })}</div>` : ''}
      ${kind === 'mine' ? `<button class="btn" data-use="${idx}">${t('chUseMine')}</button>` : ''}
      <button class="mini" data-flip="${idx}">${t(kind === 'mine' ? 'chIsScout' : 'chIsMine')}</button></div>`;
  }
  function bubble(m, k) {
    if (m.role === 'card') return `<div class="msg card-m">${m.html}</div>`;
    const who = m.role === 'user' ? 'me' : 'bot';
    const imgs = (m.imgs || []).map(u => `<img src="${u}" alt="">`).join('');
    const txt = m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : CHAT.fmt(m.content);
    return `<div class="msg ${who}${m.err ? ' err' : ''}">${imgs ? `<div class="mimgs">${imgs}</div>` : ''}${m.shots && !imgs ? `<div class="small mute">📷 ${t('chShots', { n: m.shots })}</div>` : ''}${txt}${m.model ? `<div class="mmeta">${esc(m.model.split('/').pop())}</div>` : ''}</div>`;
  }
  function suggestions() {
    const s = ['chQCap', 'chQTr', 'chQChip', 'chQRisk', 'chQRate'];
    if (window.cupContext && window.cupContext()) s.unshift('cupAskShort');
    if (CH.scouts.length) s.unshift('chQBeat');
    return s.map(k => `<button type="button" data-q="${k}">${t(k)}</button>`).join('');
  }
  function draw() {
    $('#chat-h').textContent = t('askTitle');
    $('#chat-sub').textContent = CH.mineShot ? t('chSubShot') : t('chSub');
    const welcome = `<div class="msg bot">${t('chHello')}</div>`;
    body.innerHTML = welcome + CH.msgs.map(bubble).join('') + (CH.busy ? `<div class="msg bot typing"><span></span><span></span><span></span>${CH.busyMsg ? `<div class="small mute">${esc(CH.busyMsg)}</div>` : ''}</div>` : '');
    $('#chat-sugg').innerHTML = CH.busy ? '' : suggestions();
    $('#chat-att').innerHTML = CH.pending.map((a, k) => `<div class="att"><img src="${a.url}" alt=""><button type="button" class="att-x" data-rm="${k}" aria-label="Remove">×</button>
      <div class="att-kind">${['auto', 'mine', 'scout'].map(v => `<button type="button" data-kind="${k}:${v}" class="${a.kind === v ? 'on' : ''}">${t('chK_' + v)}</button>`).join('')}</div></div>`).join('');
    q.placeholder = CH.pending.length ? t('chPhImg') : t('askPh');
    body.scrollTop = body.scrollHeight;
  }

  // ---- actions ----------------------------------------------------------------------------
  function addFiles(files) {
    for (const f of [...files].slice(0, 4 - CH.pending.length)) if (/^image\//.test(f.type)) CH.pending.push({ file: f, url: URL.createObjectURL(f), kind: 'auto' });
    if (!CH.open) openChat(); else draw();
  }
  function contextBlock() {
    let c = R().askContext ? R().askContext() : '';
    if (window.cupContext && window.cupContext()) c += '\n\n' + window.cupContext();
    const P = allP(), g = (D.projection.gws || []), line = i => { const p = P[i]; return p ? `${p.n} (${p.t} ${PN[p.posn]} £${p.c}) xP GW${g[0]} ${f1((p.b || [])[0])}, next3 ${f1(CHAT.xpN(p, 3))}` : ''; };
    if (CH.mineShot) c += `\n\nMY SQUAD (screenshot, replaces the public squad):\n${CH.mineShot.map(line).join('\n')}`;
    const s = CH.scouts[CH.scouts.length - 1];
    if (s) { const cmp = CHAT.compare(mySquad(), s.squad, P, FREngine.bestXI);
      c += `\n\nSCOUT SQUAD "${s.label}":\n${s.squad.map(line).join('\n')}\nCOMPARISON (best XI xP next ${cmp.k} GWs): me ${cmp.mine.horizon}, scout ${cmp.theirs.horizon}. Scout differentials: ${cmp.threats.map(nm).join(', ') || 'none'}. My differentials: ${cmp.edges.map(nm).join(', ') || 'none'}.`; }
    return c;
  }
  // set (or switch) what a screenshot card means: my squad -> chat context + "use as my squad"; scout -> comparison
  function applyKind(k, kind, r) {
    const m = CH.msgs[k], P = allP();
    if (m.label) { CH.scouts = CH.scouts.filter(s => s.label !== m.label); if (CH.msgs[k + 1] && CH.msgs[k + 1].cmp === m.label) CH.msgs.splice(k + 1, 1); delete m.label; }
    if (m.kind === 'mine' && m.res && kind !== 'mine') CH.mineShot = null;
    m.kind = kind; m.res = { squad: r.squad, seen: [...r.seen], bank: r.bank, ft: r.ft };
    m.html = squadCard(kind, r, k);
    if (kind === 'mine') CH.mineShot = r.squad.length === 15 ? r.squad : null;
    else { const n = CH.scouts.reduce((x, s) => Math.max(x, +(s.n || 0)), 0) + 1, label = t('chScoutN', { n }), squad = [...r.seen].filter(i => P[i]);
      m.label = label; CH.scouts.push({ label, n, squad, ts: Date.now() });
      CH.msgs.splice(k + 1, 0, { role: 'card', cmp: label, html: cmpCard(label, CHAT.compare(mySquad(), squad, P, FREngine.bestXI)) }); }
  }
  async function readAttachments(list) {
    const mine = pubSquad();
    for (let k = 0; k < list.length; k++) {
      const a = list[k]; CH.busyMsg = t('chReading', { i: k + 1, n: list.length, p: 0 }); draw();
      let text;
      try { text = await R().ocrText(a.file, p => { CH.busyMsg = t('chReading', { i: k + 1, n: list.length, p: Math.round(p * 100) }); const e = body.querySelector('.typing .small'); if (e) e.textContent = CH.busyMsg; }); }
      catch (e) { CH.msgs.push({ role: 'assistant', content: t('syncLoadErr', { e: e.message || e }), err: true }); continue; }
      // first pass without prior to see what the image really holds, then decide mine vs scout
      const raw = R().syncResult(text, []), kind = a.kind === 'auto' ? CHAT.guessKind([...raw.seen], mine) : a.kind;
      const r = kind === 'mine' ? R().syncResult(text, mine) : raw;
      if (raw.seen.size < 3) { CH.msgs.push({ role: 'assistant', content: t('chNoPlayers'), err: true }); continue; }
      const idx = CH.msgs.length;
      CH.msgs.push({ role: 'card', kind, text });
      applyKind(idx, kind, r);
    }
    CH.busyMsg = '';
  }
  async function send(text) {
    if (CH.busy || !D || !D.projection) return;
    text = (text || '').trim(); const atts = CH.pending.splice(0);
    if (!text && !atts.length) return;
    const imgs = atts.map(a => a.url), start = CH.msgs.length;
    CH.msgs.push({ role: 'user', content: text || t('chOnlyImg', { n: atts.length }), imgs, shots: atts.length });
    q.value = ''; CH.busy = true; draw();
    if (atts.length) await readAttachments(atts);
    // a screenshot alone still gets an answer: compare with the scout, or rate the synced squad
    const lastCard = CH.msgs.slice(start).reverse().find(m => m.role === 'card' && m.kind);
    const ask = text || (lastCard ? t(lastCard.kind === 'scout' ? 'chAutoScout' : 'chAutoMine') : '');
    if (ask) {
      if (!PROXY) CH.msgs.push({ role: 'assistant', content: t('askErr', { e: 'no proxy' }), err: true });
      else {
        CH.busyMsg = t('askWait'); draw();
        try {
          const hist = CHAT.history(CH.msgs.slice(0, start));
          const r = await fetch(PROXY + '/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: ask, context: contextBlock(), history: hist }) });
          const j = await r.json();
          CH.msgs.push(j.answer ? { role: 'assistant', content: j.answer, model: j.model } : { role: 'assistant', content: t('askErr', { e: j.error || r.status }), err: true });
        } catch (err) { CH.msgs.push({ role: 'assistant', content: t('askErr', { e: err.message || err }), err: true }); }
      }
    }
    CH.busy = false; CH.busyMsg = '';
    // images are not stored: keep a "📷 n" marker instead of object URLs
    save(); draw(); drawHome();
  }

  // ---- events -----------------------------------------------------------------------------
  $('#chat-fab').onclick = () => openChat();
  $('#chat-close').onclick = closeChat;
  $('#chat-new').onclick = () => { if (!confirmClear()) return; CH.msgs = []; CH.scouts = []; CH.mineShot = null; save(); draw(); drawHome(); };
  function confirmClear() { const b = $('#chat-new'); if (b.dataset.arm) { delete b.dataset.arm; b.textContent = '⟲'; return true; } b.dataset.arm = 1; b.textContent = t('chSure'); setTimeout(() => { delete b.dataset.arm; b.textContent = '⟲'; }, 2500); return false; }
  $('#chat-form').onsubmit = e => { e.preventDefault(); send(q.value); };
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(q.value); } });
  q.addEventListener('input', () => { q.style.height = 'auto'; q.style.height = Math.min(120, q.scrollHeight) + 'px'; });
  $('#chat-file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  q.addEventListener('paste', e => { const f = [...(e.clipboardData || {}).files || []]; if (f.length) { e.preventDefault(); addFiles(f); } });
  $('#chat').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.q) send(t(b.dataset.q));
    else if (b.dataset.rm != null) { const a = CH.pending.splice(+b.dataset.rm, 1)[0]; if (a) URL.revokeObjectURL(a.url); draw(); }
    else if (b.dataset.kind) { const [k, v] = b.dataset.kind.split(':'); CH.pending[+k].kind = v; draw(); }
    else if (b.dataset.use != null) { const m = CH.msgs[+b.dataset.use]; if (m && m.res && R().useSync) { closeChat(); R().useSync({ ...m.res, seen: new Set(m.res.seen) }); } }
    else if (b.dataset.flip != null) { // the guess was wrong: re-read the same text the other way
      const k = +b.dataset.flip, m = CH.msgs[k]; if (!m || !m.text) return;
      const kind = m.kind === 'mine' ? 'scout' : 'mine';
      applyKind(k, kind, R().syncResult(m.text, kind === 'mine' ? pubSquad() : [])); save(); draw();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && CH.open) closeChat(); });

  function drawHome() {
    if (!$('#home-chat')) return;
    $('#ask-intro').textContent = t('chIntro');
    $('#home-chat').textContent = CH.msgs.length ? t('chContinue') : t('chOpen');
    $('#home-shot').textContent = t('chAttach');
    $('#home-sugg').innerHTML = ['chQCap', 'chQTr', 'chQChip'].map(k => `<button type="button" data-q="${k}">${t(k)}</button>`).join('');
  }
  if ($('#home-chat')) {
    $('#home-chat').onclick = () => openChat();
    $('#home-file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    $('#home-sugg').onclick = e => { const b = e.target.closest('[data-q]'); if (b) { openChat(); send(t(b.dataset.q)); } };
  }
  let loadedFor = null;
  window.onChatData = () => {
    if (TEAM !== loadedFor) { loadedFor = TEAM; CH.msgs = []; CH.scouts = []; CH.mineShot = null; load(); }
    $('#chat-fab').style.display = D && D.projection && TEAM ? '' : 'none';
    drawHome(); if (CH.open) draw();
  };
  window.onChatLang = () => { drawHome(); if (CH.open) draw(); };
})();
