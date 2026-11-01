'use strict';
// ===== 跟朋友一起玩（線上） =====
// 用 PeerJS（WebRTC）連線，配對用 PeerJS 公開的免費伺服器（0.peerjs.com），不用自己架伺服器：
// 一個人「開房間」，畫面上顯示 4 個字的房間代碼（PeerJS 的 id 是 home12- 加代碼），朋友輸入代碼加入，最多 4 個人。
// 房主當中繼（星狀）：客人送出的訊息都先到房主，房主再轉給其他客人。
// 同步的東西：同一個世界、同一天、同一個時間（房主說了算），每個人的位置、名字、蹲下、手電筒；
// 怪物（netmon.js：每隻由離牠最近的人的平板算，再送給大家）、第四世界蓋的牆、搬的家具由別的程式用下面的事件 API 同步。
// 客人用新遊戲的起始物品開始，不讀也不寫自己的存檔（game.js 的 saveGame 會跳過）；
// 客人倒下了不會卡在結束畫面：晚上倒下天亮時醒來、白天倒下 20 秒後醒來，醒在房主旁邊。
// 暫停同步：有人暫停（暫停鈕、Esc、切到別的 App）大家都進暫停畫面，寫著是誰暫停的；有人按「繼續」大家一起繼續。
//   房主說了算：客人按暫停或繼續先送 '_pzq' 給房主，房主改好房間的暫停狀態（S.pz，每改一次 n 加 1）再用 '_pz' 送給大家。
//   開著商店、書包的視窗時先不暫停，關掉視窗才進暫停畫面；過場動畫、倒下、還沒進到房主的世界、在主選單時不會被拉進暫停畫面。
//   暫停的人離開了，大家還是停在暫停畫面，但會寫「某某離開了」，誰按「繼續」都可以。
// 離開：回主選單、關掉 App（pagehide）會送「掰掰」，大家馬上看不到他的人物；切到別的 App（visibilitychange）先把人物藏起來，
//   一直沒回來（NET_AWAY）或沒有消息了（NET_AWAY_QUIET）就當成離開了。
// 沒有網路或 PeerJS 載不到時只能自己玩，遊戲照常。
// 測試：網址加 ?nettest（或 &nettest）改用 BroadcastChannel，同一個瀏覽器的兩個分頁互連，不用上網（自動試玩測試的 net 情境）。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、mode、newGame、toast… 都是遊戲跑起來之後才呼叫。
//
// 給其他程式用的 API（例如第四世界同步蓋房子）：
//   Net.active：在房間裡（開了房間或已經加入）；Net.isHost：是房主；Net.guest：是客人；Net.ready：在遊戲裡、而且客人已經進到房主的世界
//   Net.myId、Net.name、Net.code（房間代碼）
//   Net.friends() → 其他人最新的位置（已經平滑內插過）：[{ id, name, x, y, z, face, pitch, world, day, color, look, crouch, flash, flashLv, pose, down, busy, ingame, away, host }]
//     ingame：在遊戲裡、而且畫面開著（回到主選單、切到別的 App、2.5 秒沒有位置都是 false，不要畫他）
//     busy：開著商店、書包的視窗或暫停畫面（不在玩，怪物先不要交給他算）；hp：血量（頭上的血量條）；
//     hand：手上拿的東西（game.js 的 handCode：武器、蠟燭，第四世界的板子 P1～P5、門 D1～D5、家具 F）；swing：正在揮武器
//   Net.paused → 房間現在是暫停的：{ on, by, name, gone }（by 是誰暫停的、gone 是暫停的人已經離開了）
//   Net.roster() → 房間裡的每個人（包括自己）：[{ id, name, color, look, host, me }]
//   Net.send(type, data)：廣播給房間裡其他人（客人送的由房主轉給其他客人）
//   Net.sendTo(id, type, data)：只送給一個人
//   Net.on(type, (data, fromId) => {})：收事件，回傳取消的函式；Net.off(type, fn)
//   生命週期事件（也用 Net.on 收）：'@join' { id, name }（有人加入）、'@leave' { id, name }（有人離開或斷線）、
//     '@start' { world, day }（客人進到房主的世界；房主換世界時客人跟著換，會再發一次）、'@close' { why }（自己離開房間或斷線）
//   type 不能用 _ 或 @ 開頭（內部用）；data 要能 JSON 化；大的訊息會自動切塊（PeerJS 一次只能送 16KB）

const NET_VER = 4;                      // 連線的訊息格式版本：改了就加 1（版本不一樣的平板會被擋下來，請它更新）
const NET_PREFIX = 'home12-';           // PeerJS 的 id：home12-ABCD
const NET_MAX = 4;                      // 一個房間最多幾個人（房主加 3 個客人）
const NET_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 房間代碼：大寫字母和數字，不用 0/O、1/I（看起來很像）
const NET_COLORS = ['#c0392b', '#2e6fd0', '#2f9a4f', '#d9a21b'];   // 衣服的顏色：房主紅、客人藍綠黃
const NET_SEND_MS = 100;                // 每秒送 10 次位置
const NET_STATE_MS = 500;               // 房主每秒送 2 次時間（換白天晚上、換天、換世界時馬上送）
const NET_TIMEOUT = 15000;              // 15 秒沒收到對方的東西就當成斷線（蓋世界的時候會先說「忙」，多給時間）
const NET_AWAY = 60000;                 // 切到別的 App 超過 60 秒就當成離開了（人物早就先藏起來了）
const NET_AWAY_QUIET = 8000;            // 切到別的 App 之後 8 秒都沒有消息（多半是把 App 關掉了）也當成離開了
const NET_CHUNK = 6000;                 // 一塊最多幾個字（中文 3 個位元組，6000 字也在 PeerJS 的 16KB 以內）
const NET_DOWN_DAY = 20;                // 客人白天倒下幾秒後醒來
const NET_TEST = /[?&]nettest(?:[=&]|$)/.test(location.search);

const Net = (() => {
  const handlers = new Map();
  const S = {
    role: null,          // 'host' | 'guest' | null
    tr: null,            // 傳輸層
    code: '', myId: '', name: '', look: 'm', color: 0,
    conns: new Map(),    // 房主：客人的連線 id → { c, ok, name, look, color, seen }
    hostConn: null,      // 客人：連到房主的連線
    hostId: '',
    roster: [],          // [{ id, name, look, color, host }]
    friends: new Map(),  // 其他人的位置：id → {...}
    hostState: null,     // 客人：房主最新的時間狀態
    joined: false,       // 客人：房主歡迎過了
    entered: false,      // 客人：已經進到房主的世界
    downed: null,        // 客人：倒下了 { cause, at, night }
    chunks: new Map(), msgId: 0, lastPing: 0, lastState: 0, sentKey: '', rate: 1, rateRef: null, lastPump: 0, hostSeen: 0, hostGrace: 0,
    notes: {}, busy: false, panelFrom: 'title', titleNote: '', lastCode: '',
    pz: { n: 0, on: 0, by: '', name: '', gone: 0 },   // 房間的暫停狀態（房主說了算；客人這裡是房主最後說的）
    myPzN: -1,           // 客人：自己按暫停或繼續的時候房間的 n（房主還沒回之前，不要照舊的狀態把自己拉回去）
    hostAwayAt: 0,       // 客人：房主切到別的 App 的時間
  };
  const now = () => performance.now();
  const inGame = () => typeof mode !== 'undefined' && mode !== 'title' && !!G;
  const r2 = v => Math.round((v || 0) * 100) / 100;
  const el = id => document.getElementById(id);
  const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 8);
  const normCode = c => String(c || '').toUpperCase().split('').filter(ch => NET_CODE_CHARS.includes(ch)).join('').slice(0, 4);
  const randCode = () => Array.from({ length: 4 }, () => NET_CODE_CHARS[Math.floor(Math.random() * NET_CODE_CHARS.length)]).join('');
  const wrapA = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  const note = msg => { if (typeof toast === 'function' && inGame()) toast(msg); };

  // ====================================================================
  // 傳輸層：PeerJS（正式）或 BroadcastChannel（測試）
  // listen(id, onConn) 開房間；connect(id) → 連線；連線：{ id, open, send(字串), close(), onData, onClose }
  // ====================================================================
  function mkConn(id, send, close) {
    const c = { id, open: true, onData: null, onClose: null, done: false };
    c.send = s => { if (c.open) try { send(s); } catch (e) { /* 送不出去就算了，斷線會另外處理 */ } };
    c.close = () => { if (!c.open) return; c.open = false; try { close(); } catch (e) { /* 已經關了 */ } };
    c.data = s => { if (c.open && c.onData) c.onData(s); };
    c.closed = () => { if (c.done) return; c.done = true; c.open = false; if (c.onClose) c.onClose(); };
    return c;
  }
  function peerTransport() {
    let peer = null;
    const wrap = dc => {
      const c = mkConn(dc.peer, s => dc.send(s), () => dc.close());
      dc.on('data', d => c.data(typeof d === 'string' ? d : ''));
      dc.on('close', () => c.closed());
      dc.on('error', () => c.closed());
      return c;
    };
    return {
      listen(id, onConn) {
        return new Promise((res, rej) => {
          let opened = false;
          const to = setTimeout(() => { if (!opened) rej({ type: 'timeout' }); }, 15000);
          peer = new Peer(id, { debug: 0 });
          peer.on('open', () => { opened = true; clearTimeout(to); res(); });
          peer.on('connection', dc => dc.on('open', () => onConn(wrap(dc))));
          peer.on('error', e => { if (!opened) { clearTimeout(to); rej(e); } });
          // 跟配對伺服器斷了（網路閃斷）：已經連上的朋友不受影響，過 3 秒重新連，新朋友才加得進來
          peer.on('disconnected', () => setTimeout(() => { try { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); } catch (e) { /* 下次再試 */ } }, 3000));
        });
      },
      connect(id) {
        return new Promise((res, rej) => {
          let done = false;
          const fail = e => { if (done) return; done = true; clearTimeout(to); rej(e); };
          const to = setTimeout(() => fail({ type: 'timeout' }), 30000);   // 找連線的路（ICE）有時候要十幾秒，尤其要經過轉送伺服器的時候
          peer = new Peer({ debug: 0 });
          peer.on('error', fail);   // peer-unavailable：沒有這個房間
          peer.on('open', () => {
            const dc = peer.connect(id, { serialization: 'raw', reliable: true });
            dc.on('open', () => { if (done) return; done = true; clearTimeout(to); res(wrap(dc)); });
            dc.on('error', fail);
          });
        });
      },
      myId: () => (peer && peer.id) || '',
      destroy() { if (peer) try { peer.destroy(); } catch (e) { /* 已經關了 */ } peer = null; },
    };
  }
  // 測試用：同一個瀏覽器的分頁之間用 BroadcastChannel 傳訊息，模擬 PeerJS 的開房間、連線
  function bcTransport() {
    const ch = new BroadcastChannel('home12-nettest');
    const me = 'bc-' + Math.random().toString(36).slice(2, 10);
    let listenId = null, onConn = null, closed = false;
    const conns = new Map(), waits = [];
    const self = () => listenId || me;
    const post = (k, to, d) => { if (!closed) ch.postMessage({ k, from: self(), to, d }); };
    const mk = id => mkConn(id, s => post('msg', id, s), () => { post('close', id); conns.delete(id); });
    ch.onmessage = ({ data: m }) => {
      if (!m || closed) return;
      if (m.k === 'who') { if (listenId && m.d === listenId) post('here', m.from); return; }
      if (m.to !== self()) return;
      if (m.k === 'here' || m.k === 'acc') { for (const w of waits.slice()) w(m); return; }
      if (m.k === 'conn') { if (listenId && onConn) { const c = mk(m.from); conns.set(m.from, c); post('acc', m.from); onConn(c); } return; }
      const c = conns.get(m.from);
      if (!c) return;
      if (m.k === 'msg') c.data(m.d);
      else if (m.k === 'close') { conns.delete(m.from); c.closed(); }
    };
    const wait = (test, ms) => new Promise(res => {
      const f = m => { if (test(m)) done(m); };
      const done = v => { clearTimeout(t); const i = waits.indexOf(f); if (i >= 0) waits.splice(i, 1); res(v); };
      const t = setTimeout(() => done(null), ms);
      waits.push(f);
    });
    return {
      async listen(id, cb) {
        ch.postMessage({ k: 'who', from: me, d: id });
        if (await wait(m => m.k === 'here', 300)) throw { type: 'unavailable-id' };
        listenId = id; onConn = cb;
      },
      async connect(id) {
        post('conn', id);
        if (!(await wait(m => m.k === 'acc' && m.from === id, 2000))) throw { type: 'peer-unavailable' };
        const c = mk(id); conns.set(id, c);
        return c;
      },
      myId: self,
      destroy() { for (const id of conns.keys()) post('close', id); conns.clear(); closed = true; ch.close(); },
    };
  }
  const makeTransport = () => (NET_TEST ? bcTransport() : peerTransport());
  // 能不能連線：沒有網路、PeerJS 載不到、裝置不支援 WebRTC 都只能自己玩
  function available() {
    if (NET_TEST) return typeof BroadcastChannel === 'function' ? { ok: true } : { ok: false, why: '這個瀏覽器不支援測試用的連線' };
    if (navigator.onLine === false) return { ok: false, why: '📴 沒有網路，現在只能自己玩' };
    if (typeof Peer !== 'function') return { ok: false, why: '📴 沒有網路，現在只能自己玩', detail: '連線元件載不到（連上網路後重新打開遊戲）' };
    const sup = window.peerjs && peerjs.util && peerjs.util.supports;
    if (sup && sup.data === false) return { ok: false, why: '這台裝置的瀏覽器不支援線上連線，現在只能自己玩' };
    return { ok: true };
  }
  function errText(e, code) {
    const t = e && e.type;
    if (t === 'peer-unavailable') return `找不到房間「${code}」：請確認代碼，或請朋友重新開房間`;
    if (t === 'unavailable-id') return '房間代碼剛好撞到別人的，再按一次「開房間」';
    if (t === 'browser-incompatible' || t === 'webrtc') return '這台裝置的瀏覽器不支援線上連線，現在只能自己玩';
    if (t === 'full') return '房間已經滿了（最多 4 個人）';
    if (t === 'ver') return '你們的遊戲版本不一樣：請兩邊都連上網路、重新打開遊戲更新到最新版';
    if (t === 'nohost') return '房主沒有回應，請再試一次';
    return '📴 連不上網路，現在只能自己玩（請確認有連上 Wi-Fi）';
  }

  // ====================================================================
  // 訊息：{ t: 種類, d: 資料, f: 誰送的, o: 只給誰 }，送的時候變成字串；太長就切塊
  // ====================================================================
  function rawSend(c, m) {
    if (!c || !c.open) return;
    let s;
    try { s = JSON.stringify(m); } catch (e) { console.warn('Net：資料不能 JSON 化', m.t); return; }
    if (s.length <= NET_CHUNK) { c.send(s); return; }
    const id = ++S.msgId, n = Math.ceil(s.length / NET_CHUNK);
    for (let i = 0; i < n; i++) c.send(JSON.stringify({ t: '_c', c: [id, i, n, s.slice(i * NET_CHUNK, (i + 1) * NET_CHUNK)] }));
  }
  function recvRaw(c, s) {
    let m;
    try { m = JSON.parse(s); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    if (S.role === 'host') { const g = S.conns.get(c.id); if (g) g.seen = now(); } else S.hostSeen = now();
    if (m.t === '_c') {
      const [id, i, n, part] = Array.isArray(m.c) ? m.c : [];
      if (typeof part !== 'string' || !(n > 0) || n > 2000) return;
      const key = c.id + ':' + id;
      let b = S.chunks.get(key);
      if (!b) { if (S.chunks.size > 40) S.chunks.clear(); S.chunks.set(key, b = { n, got: 0, parts: [] }); }
      if (b.parts[i] === undefined) { b.parts[i] = part; b.got++; }
      if (b.got >= b.n) { S.chunks.delete(key); recvRaw(c, b.parts.join('')); }
      return;
    }
    if (S.role === 'host') hostRoute(c, m); else if (S.role === 'guest') handle(m);
  }
  // 房主送給大家（客人的話就是送給房主，由房主轉）
  function sendAll(t, d, skip) {
    const m = { t, d, f: S.myId };
    if (S.role === 'guest') rawSend(S.hostConn, m);
    else for (const [id, g] of S.conns) if (g.ok && id !== skip) rawSend(g.c, m);
  }
  function sendOne(id, t, d) {
    const m = { t, d, f: S.myId, o: id };
    if (S.role === 'guest') rawSend(S.hostConn, m);
    else { const g = S.conns.get(id); if (g && g.ok) rawSend(g.c, m); }
  }
  // 房主收到客人的訊息：自己處理，再轉給其他客人（o 是只給某一個人的）
  function hostRoute(c, m) {
    if (m.t === '_hello') { onHello(c, m.d || {}); return; }
    const g = S.conns.get(c.id);
    if (!g || !g.ok) return;   // 還沒打招呼的不理
    m.f = c.id;                // 不相信客人自己寫的「誰送的」
    if (m.t === '_bye') { dropGuest(c.id, 'left'); return; }
    if (m.o && m.o !== S.myId) { const to = S.conns.get(m.o); if (to && to.ok) rawSend(to.c, m); return; }
    // 一般的心跳不用轉；說「切到別的 App／回來了」的要轉，其他客人才會馬上藏起他的人物
    if (!m.o && (m.t !== '_ping' || (m.d && m.d.away !== undefined))) for (const [id, g2] of S.conns) if (id !== c.id && g2.ok) rawSend(g2.c, m);
    handle(m);
  }
  function handle(m) {
    switch (m.t) {
      case '_pos': gotPos(m.f, m.d || {}); return;
      case '_ping': {
        const f = S.friends.get(m.f), d = m.d || {};
        if (f && !d.ig) f.at = 0;   // 對方回到主選單了：先不畫
        if (d.away !== undefined) gotAway(m.f, f, !!d.away);
        // 對方要蓋世界了（換世界時會卡一下，平板上幾秒、沒有 GPU 的測試要 20 秒）：這段時間沒有消息也不算斷線
        if (d.busy > 0) { const until = now() + Math.min(60, d.busy) * 1000; if (S.role === 'host') { const g = S.conns.get(m.f); if (g) g.grace = until; } else if (m.f === S.hostId) S.hostGrace = until; }
        return;
      }
      case '_state': if (S.role === 'guest' && m.d) { S.hostState = { ...m.d, at: now() }; if (m.d.pz) gotPz(m.d.pz); } return;
      case '_roster': if (S.role === 'guest' && Array.isArray(m.d)) setRoster(m.d); return;
      case '_welcome': if (S.role === 'guest') onWelcome(m.d || {}); return;
      case '_reject': if (S.role === 'guest' && S.joinWait) S.joinWait.rej({ type: (m.d && m.d.why) || 'full' }); return;
      case '_bye': if (S.role === 'guest' && m.f === S.hostId) leave(m.d && m.d.why === 'away' ? 'away' : 'closed'); return;
      case '_pz': if (S.role === 'guest' && m.f === S.hostId && m.d) gotPz(m.d); return;
      case '_pzq': if (S.role === 'host') pzRequest(m.f, !!(m.d && m.d.on)); return;
    }
    if (m.t[0] === '_' || m.t[0] === '@') return;
    emit(m.t, m.d, m.f);
  }
  function emit(t, d, from) {
    const list = handlers.get(t);
    if (!list) return;
    for (const fn of [...list]) {
      try { fn(d, from); } catch (e) { console.error('Net.on(' + t + ') 出錯了：', e); }
    }
  }

  // ====================================================================
  // 房間裡的人
  // ====================================================================
  function buildRoster() {
    const list = [{ id: S.myId, name: S.name, look: S.look, color: 0, host: true }];
    for (const [id, g] of S.conns) if (g.ok) list.push({ id, name: g.name, look: g.look, color: g.color, host: false });
    return list;
  }
  function setRoster(list) {
    const old = new Map(S.roster.map(r => [r.id, r]));
    S.roster = list.map(r => ({ id: String(r.id), name: cleanName(r.name) || '朋友', look: r.look === 'f' ? 'f' : 'm', color: clampColor(r.color), host: !!r.host }));
    const me = S.roster.find(r => r.id === S.myId);
    if (me) S.color = me.color;
    for (const r of S.roster) {
      if (r.id === S.myId) continue;
      if (!old.has(r.id) && S.role === 'guest' && S.joined) { note(`👥 ${r.name} 加入了`); emit('@join', { id: r.id, name: r.name }); }
      const f = S.friends.get(r.id);
      if (f) Object.assign(f, { name: r.name, look: r.look, color: NET_COLORS[r.color], colorIdx: r.color, host: r.host });
    }
    for (const [id, r] of old) if (id !== S.myId && !S.roster.some(x => x.id === id)) {
      S.friends.delete(id);
      if (S.role === 'guest') { note(`👋 ${r.name} 離開了`); emit('@leave', { id, name: r.name }); }
    }
    refreshUI();
  }
  const clampColor = c => (Number.isInteger(c) && c >= 0 && c < NET_COLORS.length ? c : 0);
  const rosterOf = id => S.roster.find(r => r.id === id);
  const hostName = () => { const h = S.roster.find(r => r.host); return h ? h.name : '房主'; };

  // ---------- 房主 ----------
  async function host() {
    const av = available();
    if (!av.ok) throw { msg: av.why };
    if (S.role) return;
    S.busy = true; refreshUI('正在開房間……');
    const tr = makeTransport();
    let err = null;
    for (let i = 0; i < 5; i++) {
      const code = randCode();
      try {
        await tr.listen(NET_PREFIX + code, c => onConn(tr, c));
        S.tr = tr; S.role = 'host'; S.code = code; S.myId = NET_PREFIX + code; S.hostId = S.myId; S.color = 0;
        S.roster = buildRoster(); S.sentKey = ''; S.rateRef = null; S.rate = 1;
        S.pz = { n: 0, on: inGame() && mode === 'pause' ? 1 : 0, by: S.myId, name: S.name, gone: 0 };   // 在暫停選單開的房間：房間一開始就是暫停的
        S.busy = false;
        refreshUI('');
        return code;
      } catch (e) {
        err = e;
        if (!e || e.type !== 'unavailable-id') break;   // 代碼撞到別人的：換一個再試
      }
    }
    try { tr.destroy(); } catch (e) { /* 已經關了 */ }
    S.busy = false;
    throw { msg: errText(err) };
  }
  function onConn(tr, c) {
    if (S.tr !== tr) { c.close(); return; }
    S.conns.set(c.id, { c, ok: false, seen: now() });
    c.onData = s => recvRaw(c, s);
    c.onClose = () => dropGuest(c.id, 'lost');
    // 8 秒內沒打招呼就關掉（不是這個遊戲的連線）
    setTimeout(() => { const g = S.conns.get(c.id); if (g && !g.ok) { S.conns.delete(c.id); c.close(); } }, 8000);
  }
  function onHello(c, d) {
    const g = S.conns.get(c.id);
    if (!g || g.ok) return;
    if (d.v !== NET_VER) { rawSend(c, { t: '_reject', d: { why: 'ver' } }); setTimeout(() => c.close(), 400); S.conns.delete(c.id); return; }
    const used = new Set([0, ...[...S.conns.values()].filter(x => x.ok).map(x => x.color)]);
    const color = [1, 2, 3].find(k => !used.has(k));
    if (color === undefined || used.size >= NET_MAX) { rawSend(c, { t: '_reject', d: { why: 'full' } }); setTimeout(() => c.close(), 400); S.conns.delete(c.id); return; }
    Object.assign(g, { ok: true, name: cleanName(d.name) || '朋友', look: d.look === 'f' ? 'f' : 'm', color, seen: now() });
    S.roster = buildRoster();
    rawSend(c, { t: '_welcome', f: S.myId, d: { id: c.id, color, code: S.code, roster: S.roster, state: hostState() } });
    sendAll('_roster', S.roster, c.id);
    if (inGame()) rawSend(c, { t: '_pos', f: S.myId, d: myPos() });   // 馬上看得到房主
    // 其他客人最後的位置也先送一份
    for (const [id, f] of S.friends) if (f.last) rawSend(c, { t: '_pos', f: id, d: f.last });
    note(`👥 ${g.name} 加入了`);
    if (typeof Sound !== 'undefined') Sound.play('click');
    refreshUI();
    emit('@join', { id: c.id, name: g.name });
  }
  function dropGuest(id, why) {
    const g = S.conns.get(id);
    if (!g) return;
    S.conns.delete(id);
    if (why === 'away') rawSend(g.c, { t: '_bye', f: S.myId, d: { why: 'away' } });   // 跟他說一聲，他回來時才知道為什麼回到主選單
    g.c.close();
    if (!g.ok) return;
    S.friends.delete(id);
    S.roster = buildRoster();
    sendAll('_roster', S.roster);
    note(why === 'lost' ? `📡 ${g.name} 斷線了` : `👋 ${g.name} 離開了`);
    if (S.pz.on && S.pz.by === id) setPz(1, id, g.name, 1);   // 暫停的人走了：畫面上改寫「某某離開了」，誰按「繼續」都可以
    refreshUI();
    emit('@leave', { id, name: g.name });
  }
  // 房主在做什麼：play 玩、pause 暫停、menu 開著商店或書包的視窗（這兩個時間都停住）、cut 過場動畫、over 倒下了或破關畫面
  const hostMode = () => (mode === 'cutscene' ? 'cut' : mode === 'over' ? 'over' : mode === 'play' ? 'play' : mode === 'modal' ? 'menu' : 'pause');
  function hostState() {
    if (!inGame()) return { ig: 0 };
    return { ig: 1, m: hostMode(), w: curWorld, day: G.day, ph: G.phase, t: r2(G.t), diff: G.diff, rate: r2(S.rate), pz: S.pz };
  }
  const stateKey = () => (inGame() ? [hostMode(), curWorld, G.day, G.phase].join('|') : 'title');
  // 房主的時間走多快（遊戲時間／真實時間）：平板很卡的時候遊戲時間也會走得比較慢，客人照這個速度往前推
  function sendState(t) {
    const key = stateKey();
    if (inGame() && mode === 'play' && S.rateRef && S.rateRef.key === key && t > S.rateRef.at + 50) {
      const r = (G.t - S.rateRef.t) / ((t - S.rateRef.at) / 1000);
      S.rate = Math.max(0, Math.min(1.5, S.rate * 0.4 + r * 0.6));
    } else if (!inGame() || mode !== 'play') S.rate = 0;
    else if (S.rate === 0) S.rate = 1;
    S.rateRef = inGame() ? { key, t: G.t, at: t } : null;
    S.lastState = t; S.sentKey = key;
    sendAll('_state', hostState());
  }

  // ---------- 客人 ----------
  async function join(code) {
    const av = available();
    if (!av.ok) throw { msg: av.why };
    code = normCode(code);
    if (code.length !== 4) throw { msg: '房間代碼是 4 個字（英文字母和數字）' };
    if (S.role) return;
    S.busy = true; S.lastCode = code; refreshUI(`正在加入「${code}」……`);
    const tr = makeTransport();
    try {
      const c = await tr.connect(NET_PREFIX + code);
      S.tr = tr; S.role = 'guest'; S.code = code; S.hostConn = c; S.hostId = NET_PREFIX + code; S.myId = tr.myId(); S.hostSeen = now(); S.hostGrace = 0;
      S.joined = false; S.entered = false; S.hostState = null; S.downed = null;
      c.onData = s => recvRaw(c, s);
      c.onClose = () => { if (S.hostConn === c) { if (S.joined) leave('lost'); else if (S.joinWait) S.joinWait.rej({ type: 'nohost' }); } };
      const welcome = new Promise((res, rej) => { S.joinWait = { res, rej }; setTimeout(() => rej({ type: 'nohost' }), 8000); });
      rawSend(c, { t: '_hello', d: { v: NET_VER, name: S.name, look: S.look, build: typeof BUILD_TIME === 'string' ? BUILD_TIME : '' } });
      await welcome;
      S.joinWait = null; S.busy = false;
      refreshUI('');
      return code;
    } catch (e) {
      console.warn('Net：加入房間失敗', e && (e.type || e.msg || e.message || e));
      S.joinWait = null; S.busy = false;
      if (S.tr === tr) reset(); else try { tr.destroy(); } catch (e2) { /* 已經關了 */ }
      throw { msg: e && e.msg ? e.msg : errText(e, code) };
    }
  }
  function onWelcome(d) {
    if (S.joined) return;
    if (d.id) S.myId = String(d.id);
    S.color = clampColor(d.color);
    setRoster(Array.isArray(d.roster) ? d.roster : []);   // 先填好房間裡的人（已經在房間裡的不用說「加入了」）
    S.joined = true;
    if (d.state) { S.hostState = { ...d.state, at: now() }; if (d.state.pz) gotPz(d.state.pz); }
    if (S.joinWait) S.joinWait.res();
    if (typeof Sound !== 'undefined') Sound.play('click');
  }
  // 客人的時間跟著房主走：照房主最後說的時間和速度往前推；客人自己不會換白天晚上（停在快結束的地方，等房主換了才換）
  const phaseEnd = () => (G.phase === 'day' ? DAY_LEN : NIGHT_LEN) - 0.05;
  // t 是這一幀自己往前走之後的時間、dt 是這一幀走了多少
  function clock(t, dt = 0) {
    const h = S.hostState;
    if (!G || !h) return Math.min(t, phaseEnd());
    if (!h.ig || h.m === 'cut' || h.m === 'over') return Math.min(Math.max(0, t - dt), phaseEnd());   // 房主回主選單、看過場動畫、倒下了：時間停住
    if (h.w !== curWorld || h.day !== G.day || h.ph !== G.phase) return Math.min(t, phaseEnd());       // 房主剛換了白天晚上，下一幀就跟著換
    const est = h.t + Math.min(2, (now() - h.at) / 1000) * (h.m === 'play' ? h.rate || 0 : 0);
    return Math.max(0, Math.min(est, phaseEnd()));
  }
  function noteOnce(key, msg) { if (S.notes[key]) return; S.notes = { [key]: 1 }; note(msg); }
  function guestTick(t) {
    const h = S.hostState;
    if (!S.joined || !h) return;
    guestPz();
    if (!h.ig) {
      if (S.entered) noteOnce('title', `⏸ ${hostName()}回到主選單了，時間先停住……`);
      else showLobby();
      return;
    }
    if (h.m === 'cut' || h.m === 'over') {
      if (S.entered) noteOnce(h.m, h.m === 'over' ? `💀 ${hostName()}倒下了……等房主重來` : `🌅 ${hostName()}破關了！等房主看完過場動畫……`);
      return;
    }
    // 房主暫停了但自己還沒進暫停畫面（開著商店、書包的視窗）：先跳個提示，關掉視窗就會暫停
    if (h.m === 'pause' && S.entered && mode !== 'pause') noteOnce('pause', `⏸ ${S.pz.on && S.pz.by !== S.myId ? S.pz.name : hostName()}暫停了，時間先停住`);
    else if (S.notes.pause || S.notes.title || S.notes.over || S.notes.cut) S.notes = {};
    if (!S.entered || h.w !== curWorld || mode === 'title') { enterWorld(h); return; }
    if (h.diff && h.diff !== G.diff && DIFFS[h.diff]) G.diff = h.diff;   // 房主讀了另一個難度的存檔
    if (h.day !== G.day || h.ph !== G.phase) syncPhase(h);
    if (mode !== 'play') G.t = clock(G.t);   // 暫停、商店的視窗、倒下的時候，時間也照樣跟著房主走
    if (S.downed) downTick(t);
  }
  // 進到房主的世界：新遊戲的起始物品（換世界時帶著自己的背包），跳到房主的天數、白天晚上和時間，站在房主旁邊
  function enterWorld(h) {
    const carry = S.entered && G && mode !== 'title' ? { inv: { ...G.inv }, coins: G.coins, flashLv: G.p.flashLv, diff: h.diff, stats: G.stats } : null;
    hidePanel(); hideDown(); S.downed = null; S.notes = {};
    el('modal').classList.add('hidden');
    newGame(h.diff, h.w, carry);   // 客人：saveGame 不會存檔
    if (h.day > 1) startDay(h.day);
    if (h.ph === 'night') startNight();
    G.t = clock(0);
    for (const s of G.ev.schedule || []) if (s.at < G.t - 0.5) s.done = true;   // 半夜才進來：已經過去的事件不要一次全部跑出來
    // 第三世界的晚上才進來：火爐先放好燃料，不然列車馬上就停了
    if (isW3() && G.phase === 'night' && !G.fire.queue.length) for (let i = 0, n = Math.min(3, Math.ceil((NIGHT_LEN - G.t) / 55)); i < n; i++) G.fire.queue.push({ id: 'charcoal', left: 55 });
    placeNearHost(true);
    S.entered = true;
    showBig(`跟 ${hostName()} 一起玩`, `${WORLD_NAMES[curWorld]}・第 ${G.day} ${G.phase === 'night' ? '夜' : '天'}`);
    if (!carry) toast('👥 你用新遊戲的東西開始，玩完你自己的存檔不會變。大家看到的是同一批怪物，一起打吧！', 'good');
    emit('@start', { world: curWorld, day: G.day });
  }
  // 房主換了白天晚上或換天（客人自己不會換）
  function syncPhase(h) {
    if (h.ph === 'day') startDay(h.day);
    else {
      if (!(G.phase === 'day' && G.day === h.day)) startDay(h.day);
      startNight();
    }
    G.t = clock(G.t);
    for (const s of G.ev.schedule || []) if (s.at < G.t - 0.5) s.done = true;
    if (S.downed && (h.ph === 'day' || !S.downed.night)) revive();
  }
  function startPos() { return curWorld === 5 ? { ...W5.start } : curWorld === 4 ? { ...W4.start } : curWorld === 3 ? { ...W3.start } : { x: 19.5, y: 23, face: -Math.PI / 2 }; }
  // 站到房主旁邊（找一格走得到的地方，面向房主）
  function placeNearHost(fromStart) {
    const hf = S.friends.get(S.hostId);
    if (!hf || hf.world !== curWorld || !(hf.at > 0)) return false;
    const p = G.p;
    for (const [dx, dy] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8], [0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6], [1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) {
      const x = hf.sx + dx, y = hf.sy + dy;
      if (!walkable(x, y) || hits(x, y, PLAYER_R)) continue;
      Object.assign(p, { x, y, z: 0, vz: 0, face: Math.atan2(hf.sy - y, hf.sx - x), pitch: 0 });
      return true;
    }
    if (fromStart) Object.assign(p, startPos());
    return false;
  }

  // ---------- 暫停同步：有人暫停大家都暫停，有人按「繼續」大家一起繼續（房主說了算） ----------
  // 房主可以暫停的時候：在玩、已經暫停、開著商店或書包的視窗（關掉視窗才進暫停畫面）；過場動畫、倒下、破關畫面不行
  const hostCanPause = () => inGame() && (mode === 'play' || mode === 'pause' || mode === 'modal');
  const whoName = id => (id === S.myId ? S.name : (rosterOf(id) || {}).name || '朋友');
  // 房主：改房間的暫停狀態，告訴大家，自己也照著暫停或繼續
  function setPz(on, by, name, gone = 0) {
    S.pz = { n: S.pz.n + 1, on: on ? 1 : 0, by: by || '', name: name || (by ? whoName(by) : ''), gone: gone ? 1 : 0 };
    sendAll('_pz', S.pz);
    applyPz();
    refreshUI();
  }
  // 照房間的暫停狀態進出暫停畫面（enterPause、leavePause 在 game.js，不會再傳出去）
  function applyPz() {
    const z = S.pz;
    if (!inGame()) return;
    if (z.on && mode === 'play') enterPause();
    else if (!z.on && mode === 'pause' && leavePause() && z.by && z.by !== S.myId) note(`▶ ${z.name}按了繼續`);
  }
  // 房主收到客人按的暫停或繼續
  function pzRequest(id, on) {
    if (!rosterOf(id)) return;
    if (on && !S.pz.on && hostCanPause()) setPz(1, id);
    else if (!on && S.pz.on) setPz(0, id);
    else sendOne(id, '_pz', S.pz);   // 已經是這樣了（或房主在看過場動畫，不能暫停）：跟他說現在的狀態，畫面上的字才會對
  }
  // 房主每一幀：開著視窗時朋友暫停了，關掉視窗就進暫停畫面；房主看過場動畫或倒下了，大家就不用停著等
  function hostTick() {
    if (!S.pz.on || !inGame()) return;
    if (mode === 'play') applyPz();
    else if (mode === 'cutscene' || mode === 'over') setPz(0, '');
  }
  // 客人收到房主說的暫停狀態（舊的不要）
  function gotPz(d) {
    const n = Number.isInteger(d.n) ? d.n : 0;
    if (n < S.pz.n) return;
    const changed = n !== S.pz.n || !!d.on !== !!S.pz.on || !!d.gone !== !!S.pz.gone;
    S.pz = { n, on: d.on ? 1 : 0, by: String(d.by || ''), name: cleanName(d.name) || '朋友', gone: d.gone ? 1 : 0 };
    if (changed) refreshUI();
  }
  // 客人每一幀：照房主說的進出暫停畫面（自己剛按過暫停或繼續、房主還沒回的話先照自己的）
  function guestPz() {
    if (!S.entered || !inGame() || S.downed || S.pz.n <= S.myPzN) return;
    applyPz();
  }
  // 自己按了暫停或繼續（game.js 的 pauseGame、resumeGame）：自己一個人玩的時候什麼都不做
  function pause(on) {
    if (S.role === 'host') { if (hostCanPause() && !!S.pz.on !== on) setPz(on, S.myId); return; }
    if (S.role !== 'guest' || !S.joined || !S.entered) return;
    S.myPzN = S.pz.n;
    sendOne(S.hostId, '_pzq', { on: on ? 1 : 0 });
    refreshUI();
  }
  // 暫停畫面上的字：「⏸ 小明暫停了」、「👋 小明離開了」（自己一個人在房間裡、自己暫停的就不用寫）
  function pauseText() {
    if (!S.role || (S.roster.length < 2 && !S.pz.gone) || (S.role === 'guest' && !S.entered) || mode !== 'pause') return '';
    const z = S.pz, mine = !z.on || (S.role === 'guest' && z.n <= S.myPzN) || z.by === S.myId;
    if (mine) return '⏸ 你暫停了';
    return z.gone ? `👋 ${z.name}離開了` : `⏸ ${z.name}暫停了`;
  }

  // ---------- 切到別的 App：人物先藏起來（不跳提示：切走時多半也暫停了，暫停畫面會寫），太久沒回來就當成離開了 ----------
  function gotAway(id, f, away) {
    if (f) f.away = away;
    if (S.role === 'host') { const g = S.conns.get(id); if (g) g.awayAt = away ? g.awayAt || now() : 0; }
    else if (id === S.hostId) S.hostAwayAt = away ? S.hostAwayAt || now() : 0;
  }
  const awayPing = () => ({ ig: inGame() ? 1 : 0, away: document.hidden ? 1 : 0 });
  document.addEventListener('visibilitychange', () => {
    if (!S.role || (S.role === 'guest' && !S.joined)) return;
    try { S.lastPing = now(); sendAll('_ping', awayPing()); } catch (e) { /* 送不出去就算了 */ }
  });

  // ---------- 客人倒下：不卡在結束畫面，天亮時（白天倒下是 20 秒後）醒過來 ----------
  function down(cause) {
    if (S.downed || mode !== 'play') return;
    const p = G.p;
    S.downed = { cause, at: now(), night: G.phase === 'night' };
    mode = 'down';
    Sound.setDrone(0);
    Sound.play('hurt');
    releaseInputs();
    if (document.pointerLockElement) document.exitPointerLock();
    p.hp = 0; p.flash = false; p.grabbed = null; p.camDrop = 1.35; p.pitch = 0.55;
    if (p.pose) p.pose = null;
    const why = { train: '火熄了，列車停在荒野裡……', cold: '體溫歸零了……', acid: '你被酸雨溶掉了……' }[cause] || '';
    el('netDownWhy').textContent = why;
    el('netDown').classList.remove('hidden');
    el('bigText').classList.remove('show');
    downTick(now());
    sendAll('_pos', myPos());
  }
  function downTick(t) {
    const d = S.downed;
    if (!d) return;
    let left;
    if (d.night) left = G.phase === 'night' ? Math.max(0, NIGHT_LEN - G.t) : 0;
    else left = Math.max(0, NET_DOWN_DAY - (t - d.at) / 1000);
    el('netDownText').textContent = d.night ? `天亮時會在 ${hostName()} 旁邊醒來（還有 ${Math.ceil(left)} 秒）` : `${Math.ceil(left)} 秒後會在 ${hostName()} 旁邊醒來`;
    if (!d.night && left <= 0) revive();
  }
  // by：扶你起來的朋友的 id（就在原地起來，血少一點）；沒有的話是天亮了或時間到了，在房主旁邊醒來
  function revive(by) {
    if (!S.downed) return;
    S.downed = null;
    hideDown();
    const p = G.p, who = by && rosterOf(by);
    Object.assign(p, { hp: who ? 40 : 60, san: Math.max(p.san, 60), hunger: Math.max(p.hunger, 50), temp: Math.max(p.temp || 0, 80), camDrop: 0, pitch: 0, pose: null, grabbed: null, stunT: 0, slowT: 0, z: 0, vz: 0, inv: 3, hurt: 0 });
    if (!who || !walkable(p.x, p.y)) { if (!placeNearHost(false)) Object.assign(p, startPos()); }
    mode = 'play';
    invDirty = true;
    lockPointer();
    showBig('你醒過來了', who ? `${who.name} 把你扶起來了` : `在 ${hostName()} 旁邊`);
    sendAll('_pos', myPos());
  }
  // 朋友按住 E 把你扶起來（game.js 收到 'revive' 事件時呼叫）
  function wake(by) { if (S.downed && mode === 'down' && rosterOf(by)) revive(by); }
  const hideDown = () => el('netDown').classList.add('hidden');

  // ====================================================================
  // 位置：每秒 10 次；收到的位置平滑內插（往前預測一點點，畫面才不會一跳一跳、慢半拍）
  // ====================================================================
  function myPos() {
    const p = G.p;
    return { x: r2(p.x), y: r2(p.y), z: r2(p.z), f: r2(p.face), p: r2(p.pitch), w: curWorld, d: G.day, c: p.crouch ? 1 : 0,
      fl: !S.downed && flashOn() ? p.flashLv || 1 : 0, dn: S.downed ? 1 : 0, ps: p.pose ? p.pose.kind : 0, b: mode === 'play' || S.downed ? 0 : 1,
      h: S.downed ? 0 : Math.round(clamp(p.hp, 0, 100)), hd: handCode(), sw: G.swingT > 0.05 ? 1 : 0 };
  }
  function gotPos(id, d) {
    if (!id || id === S.myId || typeof d.x !== 'number' || typeof d.y !== 'number') return;
    const r = rosterOf(id);
    if (!r) return;
    let f = S.friends.get(id);
    const t = now();
    if (!f) { f = { id, vx: 0, vy: 0, at: 0, snap: true }; S.friends.set(id, f); }
    gotAway(id, f, false);   // 收到位置：他在畫面前面（切到別的 App 回來了）
    Object.assign(f, { name: r.name, look: r.look, color: NET_COLORS[r.color], colorIdx: r.color, host: r.host });
    const world = d.w | 0;
    if (f.at > 0 && f.world === world) {
      const dt = (t - f.at) / 1000;
      if (dt > 0.02 && dt < 1) {
        const vx = (d.x - f.sx) / dt, vy = (d.y - f.sy) / dt, sp = Math.hypot(vx, vy);
        const k = sp > 9 ? 0 : 1;   // 瞬間移動（爬梯子、醒過來）不算速度
        f.vx = (f.vx * 0.4 + vx * 0.6) * k; f.vy = (f.vy * 0.4 + vy * 0.6) * k;
      }
      if (Math.hypot(d.x - f.sx, d.y - f.sy) > 2.5) f.snap = true;
    } else f.snap = true;
    const wasDown = !!f.down;
    Object.assign(f, { sx: d.x, sy: d.y, sz: +d.z || 0, sf: +d.f || 0, sp: +d.p || 0, at: t, world, day: d.d | 0, crouch: !!d.c, flash: d.fl > 0, flashLv: d.fl || 1, down: !!d.dn, busy: !!d.b, pose: d.ps || null,
      hp: typeof d.h === 'number' ? d.h : 100, hand: typeof d.hd === 'string' ? d.hd.slice(0, 12) : '', swing: !!d.sw, last: d });
    if (f.down && !wasDown) note(`💀 ${f.name}倒下了……天亮時會醒來`);
    else if (!f.down && wasDown) note(`✨ ${f.name}醒過來了`);
  }
  function smooth(f, dt, t) {
    if (!(f.at > 0)) return;
    const age = Math.min(0.25, (t - f.at) / 1000);
    const tx = f.sx + f.vx * age, ty = f.sy + f.vy * age;
    if (f.snap || f.x === undefined) { Object.assign(f, { x: tx, y: ty, z: f.sz, face: f.sf, pitch: f.sp, snap: false }); return; }
    const k = 1 - Math.exp(-dt * 14);
    f.x += (tx - f.x) * k; f.y += (ty - f.y) * k; f.z += (f.sz - f.z) * k;
    f.face = wrapA(f.face + wrapA(f.sf - f.face) * k); f.pitch += (f.sp - f.pitch) * k;
  }
  function friendsList() {
    const t = now(), out = [];
    for (const f of S.friends.values()) {
      if (f.x === undefined) continue;
      out.push({ id: f.id, name: f.name, x: f.x, y: f.y, z: f.z, face: f.face, pitch: f.pitch, world: f.world, day: f.day, color: f.color, colorIdx: f.colorIdx, look: f.look,
        crouch: f.crouch, flash: f.flash, flashLv: f.flashLv, pose: f.pose, down: f.down, busy: !!f.busy, hp: f.hp, hand: f.hand, swing: f.swing, host: f.host, away: !!f.away, ingame: f.at > 0 && t - f.at < 2500 && !f.away });
    }
    return out;
  }

  // ====================================================================
  // 每 0.1 秒：送位置、房主送時間、檢查斷線（用 setInterval，分頁切到背景也照樣送心跳，不會一下子就斷線）
  // ====================================================================
  function pump() {
    if (!S.role || (S.role === 'guest' && !S.joined)) return;
    const t = now(), gap = S.lastPump ? t - S.lastPump : 0;
    S.lastPump = t;
    // 自己卡住了一陣子（例如在蓋世界）：對方的訊息可能還排在後面沒處理，卡住的時間不算
    if (gap > 2000) { S.hostSeen += gap; for (const g of S.conns.values()) g.seen += gap; }
    if (inGame() && !document.hidden) sendAll('_pos', myPos());
    else if (t - S.lastPing > 1000) { S.lastPing = t; sendAll('_ping', awayPing()); }   // 在主選單、切到別的 App：只送心跳
    // 切到別的 App 太久（或切走之後就沒有消息了，多半是把 App 關掉了）：當成離開了
    const gone = (awayAt, seen) => awayAt > 0 && (t - awayAt > NET_AWAY || t - seen > NET_AWAY_QUIET);
    if (S.role === 'host') {
      if (t - S.lastState >= NET_STATE_MS || stateKey() !== S.sentKey) sendState(t);
      for (const [id, g] of S.conns) {
        if (g.ok && gone(g.awayAt, g.seen)) dropGuest(id, 'away');
        else if (t - g.seen > NET_TIMEOUT && t > (g.grace || 0)) dropGuest(id, 'lost');
      }
    } else if (gone(S.hostAwayAt, S.hostSeen)) leave('hostaway');
    else if (t - (S.hostSeen || t) > NET_TIMEOUT && t > S.hostGrace) leave('lost');
  }
  setInterval(pump, NET_SEND_MS);
  // 每一幀（game.js 的 frame）：朋友的位置平滑內插、客人跟著房主的世界和時間
  function tick(dt) {
    if (!S.role) return;
    const t = now();
    for (const f of S.friends.values()) smooth(f, dt, t);
    if (S.role === 'guest') guestTick(t);
    else hostTick();
  }

  // ====================================================================
  // 離開房間、斷線
  // ====================================================================
  function reset() {
    if (S.tr) { const tr = S.tr; setTimeout(() => { try { tr.destroy(); } catch (e) { /* 已經關了 */ } }, 250); }   // 等「掰掰」送出去再關
    Object.assign(S, { role: null, tr: null, code: '', hostConn: null, hostId: '', roster: [], hostState: null, joined: false, entered: false, downed: null, joinWait: null, busy: false, notes: {},
      pz: { n: 0, on: 0, by: '', name: '', gone: 0 }, myPzN: -1, hostAwayAt: 0 });
    S.conns.clear(); S.friends.clear(); S.chunks.clear();
  }
  function leave(why = 'left') {
    if (!S.role) return;
    const wasGuest = S.role === 'guest';
    if (why !== 'away') try { sendAll('_bye', { why }); } catch (e) { /* 已經斷了 */ }
    if (!wasGuest) for (const g of S.conns.values()) setTimeout(() => g.c.close(), 200);
    reset();
    hideDown();
    S.titleNote = !wasGuest ? '' : ({
      lost: '📡 跟房主斷線了，回到主選單（你自己的存檔沒有變）',
      closed: '👋 房主關掉了房間，回到主選單（你自己的存檔沒有變）',
      hostaway: '👋 房主離開了，回到主選單（你自己的存檔沒有變）',
      away: '💤 你切到別的地方太久了，已經離開房間（你自己的存檔沒有變）',
    }[why] || '');
    emit('@close', { why });
    if (wasGuest && typeof mode !== 'undefined' && mode !== 'title') { el('modal').classList.add('hidden'); toTitle(); }   // 客人玩的是房主的世界，離開就回主選單
    refreshUI();
  }
  addEventListener('pagehide', () => { if (S.role) try { sendAll('_bye', { why: 'left' }); } catch (e) { /* 關掉了 */ } });

  // ====================================================================
  // 介面：主選單的「👥 朋友」、暫停選單、主選單上的房間提示
  // ====================================================================
  function loadName() {
    const n = (readProg().net || {});
    S.name = cleanName(n.name) || '玩家' + (10 + Math.floor(Math.random() * 90));
    S.look = n.look === 'f' ? 'f' : 'm';
  }
  function saveName() {
    const p = readProg();
    p.net = { name: S.name, look: S.look };
    writeProg(p);   // 測試版不會寫
  }
  function openPanel(from) {
    if (typeof Sound !== 'undefined') Sound.init();
    S.panelFrom = from;
    el(from).classList.add('hidden');
    el('friends').classList.remove('hidden');
    el('fName').value = S.name;
    if (!el('fCode').value && S.lastCode) el('fCode').value = S.lastCode;
    refreshUI('');
  }
  function hidePanel() { el('friends').classList.add('hidden'); }
  function closePanel() {
    hidePanel();
    el(S.panelFrom).classList.remove('hidden');
    if (S.panelFrom === 'title') refreshTitle();
  }
  // 客人在等房主開始：主選單換成朋友的畫面（只能等或離開房間）
  function showLobby() {
    if (mode !== 'title' || !el('friends').classList.contains('hidden')) return;
    for (const id of ['title', 'help', 'book', 'bulbBook', 'transfer', 'diffPick', 'worldPick']) el(id).classList.add('hidden');
    S.panelFrom = 'title';
    el('friends').classList.remove('hidden');
    refreshUI('');
  }
  function refreshUI(msg) {
    if (msg !== undefined) el('fMsg').textContent = msg;
    const av = available(), room = !!S.role, guest = S.role === 'guest', fromPause = S.panelFrom === 'pause';
    el('fOffline').textContent = av.ok ? '' : av.why + (av.detail ? `（${av.detail}）` : '');
    el('fOffline').classList.toggle('hidden', av.ok || room);
    el('fSetup').classList.toggle('hidden', room);
    el('fRoom').classList.toggle('hidden', !room);
    el('fHost').disabled = !av.ok || S.busy;
    el('fJoin').disabled = !av.ok || S.busy;
    el('fJoinBox').classList.toggle('hidden', fromPause);   // 遊戲中只能開房間；要加入別人的房間先回主選單
    el('fPauseJoinNote').classList.toggle('hidden', !fromPause);
    for (const b of document.querySelectorAll('#fLook button')) b.classList.toggle('on', b.dataset.look === S.look);
    if (room) {
      el('fRoomCode').textContent = S.code || '----';
      el('fRoomTitle').textContent = guest ? `在 ${hostName()} 的房間` : '你的房間';
      const ul = el('fRoster');
      ul.textContent = '';
      for (const r of S.roster) {
        const li = document.createElement('li'), dot = document.createElement('span'), nm = document.createElement('span'), tag = document.createElement('span');
        dot.className = 'dot'; dot.style.background = NET_COLORS[r.color]; dot.style.color = NET_COLORS[r.color];
        nm.textContent = (r.look === 'f' ? '👧 ' : '🧑 ') + r.name;
        tag.className = 'tag2'; tag.textContent = [r.host ? '房主' : '', r.id === S.myId ? '你' : ''].filter(Boolean).join('・');
        li.append(dot, nm, tag); ul.appendChild(li);
      }
      el('fRosterN').textContent = `${S.roster.length}/${NET_MAX} 人`;
      const hostTitle = !guest && !fromPause && mode === 'title';
      el('fHostBtns').classList.toggle('hidden', !hostTitle);
      el('fStartCont').disabled = !readSave();
      el('fResume').classList.toggle('hidden', !(fromPause && mode === 'pause'));
      el('fWait').classList.toggle('hidden', !(guest && !S.entered));
      el('fBack').classList.toggle('hidden', guest && !S.entered);   // 客人在等房主：只能離開房間
    } else el('fBack').classList.remove('hidden');
    // 主選單：房間開著的提示、斷線的提示
    const nn = el('netNote');
    const txt = S.role === 'host' ? `👥 房間「${S.code}」開著（${S.roster.length} 個人）：按「繼續遊戲」或「新遊戲」，朋友會一起進來` : S.titleNote;
    nn.textContent = txt; nn.classList.toggle('hidden', !txt);
    // 暫停選單：是誰暫停的、房間裡的人
    const pw = el('pauseWho');
    if (pw) {
      const txt = pauseText();
      pw.querySelector('b').textContent = txt;
      pw.classList.toggle('hidden', !txt);
    }
    const pn = el('pauseNet');
    if (pn) {
      pn.textContent = S.role ? `👥 房間「${S.code}」：${S.roster.map(r => r.name).join('、')}` : '';
      pn.classList.toggle('hidden', !S.role);
      el('btnQuit').textContent = guest ? '離開房間（回主選單）' : '回主選單';
    }
  }
  function bindUI() {
    loadName();
    el('btnFriends').onclick = () => { S.titleNote = ''; openPanel('title'); };
    el('btnPauseFriends').onclick = () => openPanel('pause');
    el('fBack').onclick = closePanel;
    el('fResume').onclick = () => { hidePanel(); resumeGame(); };
    el('fName').addEventListener('input', () => { const n = cleanName(el('fName').value); if (n) { S.name = n; saveName(); } });
    el('fName').addEventListener('change', () => { el('fName').value = S.name; });
    for (const b of document.querySelectorAll('#fLook button')) b.onclick = () => { S.look = b.dataset.look === 'f' ? 'f' : 'm'; saveName(); refreshUI(); };
    el('fCode').addEventListener('input', () => { const c = normCode(el('fCode').value); if (c !== el('fCode').value) el('fCode').value = c; });
    el('fCode').addEventListener('keydown', e => { if (e.key === 'Enter') el('fJoin').click(); });
    el('fName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    el('fHost').onclick = async () => {
      if (typeof Sound !== 'undefined') Sound.init();
      try { await host(); } catch (e) { refreshUI(e.msg || errText(e)); }
    };
    el('fJoin').onclick = async () => {
      if (typeof Sound !== 'undefined') Sound.init();
      el('fCode').blur();
      try { await join(el('fCode').value); } catch (e) { refreshUI(e.msg || errText(e)); }
    };
    el('fLeave').onclick = () => { const guest = S.role === 'guest'; leave('left'); S.titleNote = ''; refreshUI(guest ? '已經離開房間' : '房間關掉了'); };
    el('fStartCont').onclick = () => { hidePanel(); el('title').classList.remove('hidden'); el('btnContinue').onclick(); };
    el('fStartNew').onclick = () => { hidePanel(); el('title').classList.remove('hidden'); el('btnNew').onclick(); };
    el('netDownQuit').onclick = () => leave('left');
    addEventListener('online', () => refreshUI());
    addEventListener('offline', () => refreshUI());
    refreshUI('');
  }

  // ---------- game.js 呼叫的 ----------
  // 回主選單（game.js 的 toTitle 一開始就呼叫，在蓋主選單的場景之前，朋友那邊才會馬上看不到你的人物）
  function onTitle() {
    if (S.role === 'guest') leave('quit');   // 客人回主選單就是離開房間（送「掰掰」，房主和其他人馬上拿掉你的人物）
    else if (S.role === 'host') {
      S.lastPing = now(); sendAll('_ping', awayPing());   // 房主的房間還開著：先說「不在遊戲裡了」，大家馬上藏起房主的人物
      if (S.pz.on) setPz(0, '');   // 房主在暫停選單回主選單：大家不用停著等
    }
    hideDown();
    refreshUI();
  }
  function onPause() { refreshUI(); }
  // 要做很久的事（蓋一個世界）之前先跟大家說一聲，對方才不會以為斷線了（game.js 的 applyWorld 呼叫）
  function busy(sec = 40) { if (S.role && (S.role === 'host' || S.joined)) sendAll('_ping', { ig: inGame() ? 1 : 0, busy: sec }); }

  // 介面要等 game.js 載入好（readProg、readSave、mode 都在 game.js）才綁
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
  else setTimeout(bindUI, 0);

  return {
    get active() { return !!S.role && (S.role === 'host' || S.joined); },
    get isHost() { return S.role === 'host'; },
    get guest() { return S.role === 'guest' && S.joined; },
    get ready() { return inGame() && (S.role === 'host' || (S.role === 'guest' && S.entered)); },
    get myId() { return S.myId; },
    get name() { return S.name; },
    get code() { return S.code; },
    get downed() { return !!S.downed; },
    get paused() { return S.role ? { on: !!S.pz.on, by: S.pz.by, name: S.pz.name, gone: !!S.pz.gone } : null; },
    friends: friendsList,
    roster: () => S.roster.map(r => ({ ...r, color: NET_COLORS[r.color], colorIdx: r.color, me: r.id === S.myId })),
    send(type, data) {
      if (typeof type !== 'string' || !type || type[0] === '_' || type[0] === '@') throw new Error('Net.send：type 不能是空的，也不能用 _ 或 @ 開頭');
      if (S.role && (S.role === 'host' || S.joined)) sendAll(type, data);
    },
    sendTo(id, type, data) {
      if (typeof type !== 'string' || !type || type[0] === '_' || type[0] === '@') throw new Error('Net.sendTo：type 不能是空的，也不能用 _ 或 @ 開頭');
      if (id && id !== S.myId && S.role && (S.role === 'host' || S.joined)) sendOne(id, type, data);
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    off(type, fn) { if (handlers.has(type)) handlers.get(type).delete(fn); },
    host, join, leave, available,
    // game.js 用的
    tick, clock, down, wake, onTitle, onPause, busy, pause,
    colors: NET_COLORS, test: NET_TEST,
  };
})();
