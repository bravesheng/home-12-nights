'use strict';
// ===== 跟朋友一起玩：怪物同步（net.js 的 Net） =====
// 每隻怪物由一台平板來算（牠的「主人」，通常是離牠最近的那個人）：怪物的行為照舊是「追、咬這台平板的玩家」，
// 所以 24 種怪物的程式都不用改。主人每 0.1 秒把自己算的怪物送給大家（'mon'：位置，加上跟上一次比有改變的欄位；
// 每 1 秒送一次完整的），別人畫面上的同一隻怪物（e.rm 是主人的 id）只照收到的畫，不自己算。
// 換人算：朋友比主人近 3 公尺以上（或主人倒下了、開著商店的視窗），主人就把整隻怪物交給朋友（'mgive'），以後由朋友算、朋友送。
//   怪物只會咬牠的主人；草叢人抓著你的時候、爬行女（從自己的電視爬出來）、黑球（吃自己家的燈）不換人算。
// 打別人算的怪物：手電筒、武器、天使、火球打到 e.rm 的怪物時先記下來，每 0.1 秒送給主人（'mhit'），由主人扣血、敲暈、推開；
//   被朋友的手電筒照著也算照著（主人那邊的 inBeam 是真的），怪物照樣會怕光、變慢。
//   打倒了主人送「沒了」，大家的畫面一起冒煙；最近 5 秒有打到牠的人也算打倒了一隻（會掉東西）。
// 怪物還是各自生（每個人照自己的排程），但數量上限把朋友的怪物也算進去，朋友越多上限高一點（crowd），不會變成好幾倍。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、mode、hurtMonster…都是遊戲跑起來之後才呼叫。

const NM_SEND_MS = 100;       // 每秒送 10 次
const NM_KEY_EVERY = 10;      // 每 10 次送一次完整的（剛進來的朋友才拿得到整隻怪物）
const NM_GIVE_MS = 500;       // 每 0.5 秒看一次要不要交給朋友
const NM_GIVE_GAP = 3000;     // 剛換過人算的怪物，3 秒內不再換（免得兩個人站一樣近時換來換去）
const NM_GIVE_MARGIN = 3;     // 朋友比主人近 3 公尺以上才換
const NM_LOST = 2;            // 玩了 2 秒都沒收到主人的消息（他離開了、怪物跟著他換世界了）：拿掉
const NM_NO_GIVE = new Set(['crawler', 'blob']);
// 不送的欄位：位置另外送、wob 各自往前走、其他是同步自己用的；seenT 是自己看了多久（圖鑑）
const NM_SKIP = new Set(['x', 'y', 'wob', 'nid', 'rm', 'nx', 'ny', 'na', 'nT', 'fbT', 'fbD', 'myHit', 'seenT', 'dead']);
// 指到別的東西（燈、門、牆、尋路的表）：換人算時丟掉，怪物自己會重新找
const NM_DROP = new Set(['target', 'door', 'wallAhead', 'flow']);
const NM_SRC = new Set(['flash', 'pan', 'shot', 'spray', 'salt', 'bomb', 'fire', 'angel', 'lava']);
// 怪物在主人那邊發出的聲音也送給大家（各自照自己離怪物多遠決定大小聲）；這些是主人自己的聲音（受傷、驚嚇、心跳……），不送
const NM_QUIET = new Set(['hurt', 'scream', 'heartbeat', 'empty', 'click', 'pickup', 'win', 'dawn', 'place', 'install', 'land', 'jump', 'heal', 'hug', 'cardLegend']);

const NetMon = (() => {
  const S = {
    base: new Map(),   // 自己算的怪物上一次送出去的樣子：nid → { e, s }
    hits: new Map(),   // 打到別人算的怪物：主人 id → Map(nid → { d: { 攻擊: 傷害 }, st, kx, ky })
    lit: new Map(),    // 手電筒照著別人算的怪物：主人 id → Set(nid)
    snd: [],           // 這 0.1 秒裡自己算的怪物發出的聲音：[怪物, 聲音]
    cur: null,         // 正在算哪一隻怪物（game.js 的 updateEnemies 設定），牠發出的聲音要送出去
    n: 0, tick: 0, lastSend: 0, lastGive: 0,
    pre: Math.random().toString(36).slice(2, 5),   // 怪物的 id：每台平板一個前綴，加上流水號
  };
  const now = () => performance.now();
  const on = () => typeof Net !== 'undefined' && Net.active && Net.ready && !!G && mode !== 'title' && mode !== 'cutscene';
  const newId = () => S.pre + (++S.n).toString(36);
  const num = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v > 0 ? 1e9 : v < 0 ? -1e9 : 0);
  const tag = () => ({ w: curWorld, d: G.day, ph: G.phase === 'night' ? 1 : 0 });
  const match = d => !!d && on() && d.w === curWorld && d.d === G.day && d.ph === (G.phase === 'night' ? 1 : 0);
  const byId = () => { const m = new Map(); for (const e of G.enemies) if (e.nid) m.set(e.nid, e); return m; };
  // 同一個世界裡、在遊戲裡的朋友
  const here = () => (typeof Net !== 'undefined' && Net.active ? Net.friends().filter(f => f.ingame && f.world === curWorld) : []);
  // 可以把怪物交給他的朋友：在畫面前面玩、沒倒下、同一天
  const takers = () => here().filter(f => !f.down && !f.away && !f.busy && f.day === G.day);
  // 怪物離某個人多遠：站得比較高（車頂、貨架上）的人比較難追，多算一點
  const dist = (e, x, y, z) => Math.hypot(e.x - x, e.y - y) + Math.abs(z || 0) * 1.5;

  // ---------- 把怪物變成可以送的資料 ----------
  const prim = v => v === null || typeof v === 'string' || typeof v === 'boolean';
  function flat(v) {   // 數字、字、真假、null，或裡面只有這些的物件；不能送的回傳 undefined
    if (prim(v)) return v;
    if (typeof v === 'number') return num(v);
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return undefined;
    const o = {};
    for (const k in v) {
      const x = v[k];
      if (x === undefined) continue;
      if (prim(x)) o[k] = x; else if (typeof x === 'number') o[k] = num(x); else return undefined;
    }
    return o;
  }
  function val(v) {
    if (!Array.isArray(v)) return flat(v);
    if (v.length > 40) return undefined;
    const out = [];
    for (const x of v) { const y = flat(x); if (y === undefined) return undefined; out.push(y); }
    return out;
  }
  // lossy：有指到別的東西、又不在 NM_DROP 裡的欄位（這種怪物先不換人算）
  function state(e) {
    const s = {};
    let lossy = false;
    for (const k in e) {
      if (NM_SKIP.has(k)) continue;
      const v = e[k];
      if (v === undefined || typeof v === 'function') continue;
      const y = val(v);
      if (y === undefined) { if (!NM_DROP.has(k)) lossy = true; continue; }
      s[k] = y;
    }
    return { s, lossy };
  }
  const same = (a, b) => (a !== null && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);

  // ---------- 主人：每 0.1 秒送自己算的怪物 ----------
  function send() {
    const key = ++S.tick % NM_KEY_EVERY === 0, m = [], g = [], live = new Set();
    for (const e of G.enemies) {
      if (e.rm || e.dead) continue;
      const nid = e.nid || (e.nid = newId());
      live.add(nid);
      const { s } = state(e), b = S.base.get(nid);
      let out = s;
      if (b && !key) {
        out = null;
        for (const k in s) if (!same(s[k], b.s[k])) (out || (out = {}))[k] = s[k];
      }
      S.base.set(nid, { e, s });
      m.push(out ? [nid, num(e.x), num(e.y), out] : [nid, num(e.x), num(e.y)]);
    }
    for (const [nid, b] of S.base) if (!live.has(nid)) { S.base.delete(nid); g.push([nid, b.e.hp > 0 ? 0 : 1]); }
    const snd = S.snd.filter(([e]) => e.nid).map(([e, name]) => [e.nid, name]);
    S.snd = [];
    if (m.length || g.length) Net.send('mon', snd.length ? { ...tag(), m, g, s: snd } : { ...tag(), m, g });
  }
  // 別人算的怪物
  function gotMon(d, from) {
    if (!match(d)) return;
    const ids = byId();
    for (const [nid, x, y, s] of Array.isArray(d.m) ? d.m : []) {
      if (typeof nid !== 'string' || typeof x !== 'number' || typeof y !== 'number') continue;
      let e = ids.get(nid);
      if (e && !e.rm) { if (from > Net.myId) continue; delete e.nT; S.base.delete(nid); }   // 兩個人都以為是自己算的（交接剛好撞在一起）：id 大的讓給 id 小的
      if (!e) {
        if (!s || typeof s.kind !== 'string') continue;   // 還沒收到完整的：等下一次
        e = { wob: Math.random() * 10 };
        Object.assign(e, s, { nid, x, y });
        G.enemies.push(e); ids.set(nid, e);
      } else if (s && typeof s === 'object') { delete s.x; delete s.y; Object.assign(e, s); }
      e.rm = from; e.nx = x; e.ny = y; e.na = 0; e.dead = false;
      if (Math.hypot(x - e.x, y - e.y) > 3) { e.x = x; e.y = y; }   // 瞬間移動（血淚女消失再出現、「它」抓到人）
    }
    for (const [nid, name] of Array.isArray(d.s) ? d.s.slice(0, 12) : []) {
      const e = ids.get(nid);
      if (!e || e.rm !== from || typeof name !== 'string' || NM_QUIET.has(name)) continue;
      const dd = Math.hypot(e.x - G.p.x, e.y - G.p.y);
      if (dd < 16) Sound.play(name, nearVol(dd));
    }
    for (const [nid, killed] of Array.isArray(d.g) ? d.g : []) {
      const e = ids.get(nid);
      if (!e || e.rm !== from || e.dead) continue;
      e.dead = true;
      if (killed) { defeatFx(e); if (e.myHit > 0) killCredit(e); }
      else puff(e.x, e.y);
    }
  }
  // 別人算的怪物每一幀（game.js 的 updateEnemies 呼叫）：往收到的位置平滑移過去；自己的手電筒照著就告訴主人
  function remote(e, dt) {
    e.wob += dt; e.na = (e.na || 0) + dt;
    if (e.myHit > 0) e.myHit -= dt;
    if (e.na > NM_LOST || !Net.active) { e.dead = true; return; }
    const k = 1 - Math.exp(-dt * 12);
    e.x += (e.nx - e.x) * k; e.y += (e.ny - e.y) * k;
    if (inMyBeam(e)) {
      let set = S.lit.get(e.rm);
      if (!set) S.lit.set(e.rm, set = new Set());
      set.add(e.nid); e.myHit = 5;
      beamSpark(e, dt);
    }
  }

  // ---------- 打到別人算的怪物：記下來，每 0.1 秒送給主人 ----------
  function hit(t, dmg, src, stun = 0, kb = null) {
    if (!t.rm || !t.nid) return;
    t.myHit = 5;
    let o = S.hits.get(t.rm);
    if (!o) S.hits.set(t.rm, o = new Map());
    let h = o.get(t.nid);
    if (!h) o.set(t.nid, h = { d: {}, st: 0, kx: 0, ky: 0 });
    if (dmg > 0) h.d[src] = (h.d[src] || 0) + dmg;
    if (stun > h.st) h.st = stun;
    if (kb) { h.kx += kb[0]; h.ky += kb[1]; }
    if (stun > 0) t.stunT = Math.max(t.stunT || 0, stun);   // 自己的畫面先轉星星，主人下一次送來就對了
  }
  function flush() {
    const owners = new Set([...S.hits.keys(), ...S.lit.keys()]);
    for (const id of owners) {
      const o = S.hits.get(id), set = S.lit.get(id), msg = tag();
      if (o) msg.h = [...o].map(([nid, h]) => [nid, Object.fromEntries(Object.entries(h.d).map(([k, v]) => [k, Math.round(v * 1000) / 1000])), num(h.st), num(h.kx), num(h.ky)]);
      if (set) { msg.b = [...set]; msg.bd = flTier().dmg; }
      Net.sendTo(id, 'mhit', msg);
    }
    S.hits.clear(); S.lit.clear();
  }
  function gotHit(d, from) {
    if (!match(d)) return;
    const ids = byId();
    for (const row of Array.isArray(d.h) ? d.h : []) {
      const [nid, dm, st, kx, ky] = row, e = ids.get(nid);
      if (!e || e.dead) continue;
      if (e.rm) { if (!d.fw && e.rm !== from) Net.sendTo(e.rm, 'mhit', { ...tag(), h: [row], fw: 1 }); continue; }   // 剛交給別人算了：轉過去
      for (const src in dm || {}) if (NM_SRC.has(src)) hurtMonster(e, clamp(+dm[src] || 0, 0, 100), src);
      if (e.dead) continue;
      if (st > 0) stunMonster(e, Math.min(+st, 5));
      if (kx || ky) move(e, clamp(+kx || 0, -3, 3), clamp(+ky || 0, -3, 3), ENEMY_R);
    }
    for (const nid of Array.isArray(d.b) ? d.b : []) {
      const e = ids.get(nid);
      if (e && !e.rm && !e.dead) { e.fbT = 0.35; e.fbD = clamp(+d.bd || 1, 0, 20); }
    }
  }

  // ---------- 換人算 ----------
  function give() {
    const fr = takers();
    if (!fr.length) return;
    const p = G.p, meOk = mode === 'play' && !Net.downed, t = now();
    for (const e of G.enemies) {
      if (e.rm || e.dead || !e.kind || NM_NO_GIVE.has(e.kind) || p.grabbed === e || (e.nT && t - e.nT < NM_GIVE_GAP)) continue;
      const dMe = dist(e, p.x, p.y, p.z);
      let best = null, bd = Infinity;
      for (const f of fr) { const d = dist(e, f.x, f.y, f.z); if (d < bd) { bd = d; best = f; } }
      // 自己在玩：朋友近很多才換；自己倒下了：交給最近的朋友；開著商店、書包的視窗：交給 15 公尺內的朋友（不然就停著等你）
      if (!(meOk ? bd < dMe - NM_GIVE_MARGIN : Net.downed || bd < 15)) continue;
      const { s, lossy } = state(e);
      if (lossy) continue;
      const nid = e.nid || (e.nid = newId());
      Net.sendTo(best.id, 'mgive', { ...tag(), nid, x: num(e.x), y: num(e.y), s });
      e.rm = best.id; e.nx = e.x; e.ny = e.y; e.na = 0; e.nT = t;
      S.base.delete(nid);
    }
  }
  function gotGive(d) {
    if (!match(d) || typeof d.nid !== 'string' || !d.s || typeof d.s.kind !== 'string') return;   // 已經不在同一個世界、同一天了：這隻怪物就不見了
    let e = G.enemies.find(x => x.nid === d.nid);
    if (!e) { e = { wob: Math.random() * 10 }; G.enemies.push(e); }
    Object.assign(e, d.s, { nid: d.nid, x: d.x, y: d.y, dead: false, nT: now(), na: 0 });
    delete e.rm;
    // 鳥腳女的尋路表沒有送過來：重新算
    if (e.kind === 'momo') { delete e.ftx; delete e.fty; if (typeof e.tx === 'number') setMomoTarget(e, e.tx, e.ty); }
  }

  // 每一幀（game.js 的 frame）：送怪物、送打到的、看要不要換人算
  function tick() {
    if (!on()) { if (S.base.size) S.base.clear(); S.hits.clear(); S.lit.clear(); return; }
    const t = now();
    if (t - S.lastSend >= NM_SEND_MS && mode !== 'pause' && mode !== 'over') {
      S.lastSend = t;
      send();
      flush();
    }
    if (t - S.lastGive >= NM_GIVE_MS && (mode === 'play' || mode === 'modal' || mode === 'down')) { S.lastGive = t; give(); }
  }

  function bind() {
    if (typeof Net === 'undefined') return;
    // 記下自己算的怪物發出的聲音（每 0.1 秒跟著怪物一起送出去）
    const play = Sound.play;
    Sound.play = function (name, ...rest) {
      if (S.cur && !NM_QUIET.has(name) && S.snd.length < 20 && Net.active) S.snd.push([S.cur, name]);
      return play.call(this, name, ...rest);
    };
    Net.on('mon', gotMon);
    Net.on('mhit', gotHit);
    Net.on('mgive', gotGive);
    // 朋友離開房間：他算的怪物跟著不見
    Net.on('@leave', d => { if (!G || !d) return; for (const e of G.enemies) if (e.rm === d.id && !e.dead) { e.dead = true; puff(e.x, e.y); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else setTimeout(bind, 0);

  return {
    tick, remote, hit,
    set cur(e) { S.cur = e; },
    id: e => e.nid || (e.nid = newId()),
    // 朋友越多，怪物的數量上限越高一點：一個朋友 1.5 倍、兩個 2 倍、三個 2.5 倍
    crowd: () => 1 + 0.5 * here().length,
    friendsHere: () => here().length,
    // 有沒有朋友在 (x, y) 的 r 公尺內（生怪物不要生在朋友旁邊）
    nearFriend: (x, y, r) => here().some(f => Math.hypot(f.x - x, f.y - y) < r),
  };
})();
