// ====================================================================
// 跟朋友一起玩的排行榜（設計師第六次紙條：線上玩有排行榜，生存最久、錢最多、最快到 12、和總和）
// 只排同一個房間裡一起玩的人，不用伺服器：每個人自己算自己的成績，每 2 秒送給大家（'rk'）。
//   生存最久：在房間裡活著（沒有倒下）的時間
//   錢最多：在房間裡賺到的硬幣（花掉的不扣，朋友送的不算）
//   撐過最多夜：一整晚都沒倒下的夜晚數（大家的天數是一起的，所以比的是誰沒倒下；一樣多就比倒下的次數）
//   總和：三項的名次加起來，越小越前面
// 房間關了之後最後的排行留在 localStorage（home99_rank_v1），主選單的「🏆 排行榜」看得到上一次的。
// game.js 的 frame 每一幀呼叫 NetRank.tick()，addCoins 呼叫 NetRank.earn(n)。
// ====================================================================
const NetRank = (() => {
  const KEY = 'home99_rank_v1', SEND_MS = 2000, SHOW = 20;
  const TABS = [['a', '⏱ 生存最久'], ['c', '🪙 錢最多'], ['n', '🌙 撐過最多夜'], ['sum', '🏆 總和']];
  const S = { code: '', rows: new Map(), me: null, last: 0, sent: 0, saved: 0, drawn: 0, phase: '', world: 0, downNight: false, wasDown: false, tab: 'sum', from: 'title', go: '' };
  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, max) => Math.max(0, Math.min(max, Math.floor(+v) || 0));
  const live = () => typeof Net !== 'undefined' && Net.active;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || !Array.isArray(s.rows)) return;
      for (const [id, r] of s.rows) if (r && typeof r.name === 'string') S.rows.set(String(id), { name: r.name.slice(0, 12), a: num(r.a, 1e7), c: num(r.c, 1e7), n: num(r.n, 999), dn: num(r.dn, 9999), me: !!r.me });
    } catch (e) { /* 壞掉的紀錄不理 */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ rows: [...S.rows] })); } catch (e) { /* 存不了就算了 */ }
  }

  // 排名：每一項「比我好的有幾個」加 1（一樣的同名次）
  function board() {
    const list = [...S.rows].map(([id, r]) => ({ id, ...r }));
    const key = { a: r => r.a, c: r => r.c, n: r => r.n * 10000 - r.dn };
    for (const k of ['a', 'c', 'n']) for (const r of list) r['r' + k] = 1 + list.filter(o => key[k](o) > key[k](r)).length;
    for (const r of list) r.sum = r.ra + r.rc + r.rn;
    for (const r of list) r.rsum = 1 + list.filter(o => o.sum < r.sum || (o.sum === r.sum && o.a > r.a)).length;
    return list;
  }
  const mmss = s => `${Math.floor(s / 60)} 分 ${String(Math.floor(s % 60)).padStart(2, '0')} 秒`;
  const valText = (r, k) => (k === 'a' ? mmss(r.a) : k === 'c' ? `🪙 ${r.c}` : k === 'n' ? `${r.n} 夜${r.dn ? `<span class="small">（倒下 ${r.dn} 次）</span>` : ''}` : `${r.sum} 分<span class="small">（生存第 ${r.ra}・錢第 ${r.rc}・夜第 ${r.rn}）</span>`);
  function rowsHtml(k, max) {
    const list = board().sort((p, q) => p['r' + k] - q['r' + k] || p.name.localeCompare(q.name));
    const top = list.slice(0, max), mine = list.find(r => r.me);
    if (mine && !top.includes(mine)) top.push(mine);   // 自己不在前幾名：補在最後面
    return top.map(r => `<div class="rank-row${r.me ? ' me' : ''}"><b class="rank-no">${r['r' + k] <= 3 ? ['🥇', '🥈', '🥉'][r['r' + k] - 1] : r['r' + k]}</b><span class="rank-name">${esc(r.name)}${r.me ? '（你）' : ''}</span><span class="rank-val">${valText(r, k)}</span></div>`).join('');
  }
  function draw() {
    const box = el('rankList');
    if (!box) return;
    for (const b of document.querySelectorAll('#rankTabs button')) b.classList.toggle('on', b.dataset.t === S.tab);
    el('rankNote').textContent = S.rows.size < 1 ? '跟朋友一起玩才有排行榜：主選單 → 👥 朋友，開房間或用代碼加入。'
      : live() ? `現在這個房間（${Net.code}）的排行，一邊玩一邊更新。` : '上一次跟朋友一起玩的排行。';
    box.innerHTML = rowsHtml(S.tab, SHOW);
  }
  function open(from) {
    S.from = from;
    el(from).classList.add('hidden');
    el('rank').classList.remove('hidden');
    draw();
  }
  function close() {
    el('rank').classList.add('hidden');
    el(S.from).classList.remove('hidden');
  }
  // 結束畫面（破關、結局）：下面放一份總和的排行
  function drawEnd() {
    const box = el('goRank'), go = el('gameover');
    if (!box || !go) return;
    const html = !go.classList.contains('hidden') && S.rows.size >= 2 ? `<h3>🏆 排行榜（總和）</h3>${rowsHtml('sum', 5)}` : '';
    if (html !== S.go) { S.go = html; box.innerHTML = html; box.classList.toggle('hidden', !html); }
  }

  function tick() {
    const t = performance.now(), dt = Math.min(0.5, S.last ? (t - S.last) / 1000 : 0);
    S.last = t;
    if (t - S.drawn > 1000) { S.drawn = t; drawEnd(); if (el('rank') && !el('rank').classList.contains('hidden')) draw(); }
    if (!live()) { if (S.code) { S.code = ''; S.me = null; save(); } return; }
    if (Net.code !== S.code || !S.me) {
      // 新的房間：從頭算
      S.code = Net.code; S.rows = new Map(); S.phase = ''; S.downNight = false; S.wasDown = false; S.sent = 0;
      S.me = { name: Net.name, a: 0, c: 0, n: 0, dn: 0, me: true };
      S.rows.set(Net.myId, S.me);
    }
    const me = S.me;
    me.name = Net.name;
    if (Net.ready && G) {
      const down = Net.downed;
      if (!down && (mode === 'play' || mode === 'modal')) me.a += dt;
      if (down && !S.wasDown) me.dn++;
      S.wasDown = down;
      if (G.phase === 'night' && (down || S.phase !== 'night')) S.downNight = down;   // 剛天黑：重新算；晚上倒下過：這一夜不算
      if (S.phase === 'night' && G.phase === 'day' && S.world === curWorld) { if (!S.downNight) me.n++; S.downNight = false; }
      S.phase = G.phase; S.world = curWorld;
    } else S.phase = '';
    if (t - S.sent > SEND_MS) {
      S.sent = t;
      Net.send('rk', { n: me.name, a: Math.floor(me.a), c: me.c, k: me.n, d: me.dn });
    }
    if (t - S.saved > 10000) { S.saved = t; save(); }
  }
  function earn(n) { if (S.me && live() && n > 0) S.me.c += Math.floor(n); }

  function bind() {
    load();
    if (typeof Net !== 'undefined') Net.on('rk', (d, from) => {
      if (!d || !from || !S.me || from === Net.myId) return;
      S.rows.set(from, { name: String(d.n || '朋友').slice(0, 12), a: num(d.a, 1e7), c: num(d.c, 1e7), n: num(d.k, 999), dn: num(d.d, 9999), me: false });
    });
    if (!el('rank')) return;
    el('btnRank').onclick = () => open('title');
    el('btnPauseRank').onclick = () => open('pause');
    el('btnRankBack').onclick = close;
    el('rankTabs').innerHTML = TABS.map(([k, name]) => `<button data-t="${k}">${name}</button>`).join('');
    for (const b of document.querySelectorAll('#rankTabs button')) b.onclick = () => { S.tab = b.dataset.t; draw(); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else setTimeout(bind, 0);

  return { tick, earn, board, open, get rows() { return S.rows; } };
})();
