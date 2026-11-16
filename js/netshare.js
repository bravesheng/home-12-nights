// ====================================================================
// 跟朋友一起玩：第一到第三世界「所有東西都同步」（設計師第六次紙條：燈泡也會同步！線上玩所有東西同步！！）
// 第四、五世界蓋房子那些有自己的同步（world4.js、world5.js），這裡管的是原本每台平板各自一份的東西：
//   門（開、關）、燈座上的燈泡、放下的燈、櫃子裡的東西、地上的東西、寶箱、第三世界的火爐、停電、第二世界的花、
//   商人的貨、寶藏星星。
// 做法：每 0.4 秒把這些東西各自整理成一小段文字（snap：名字 → 內容），跟上一次比，不一樣的那幾段送給大家；
// 收到的人把那一段套用到自己的遊戲裡。誰最後改的就照誰的（一起搜同一個櫃子，後按的那個人說了算）。
// 剛進房間、每天早上：每台平板自己亂數出來的東西（櫃子、寶箱的位置）不一樣，所以客人先不送，
// 跟房主要一整份（nsreq → nsfull）照著改，之後才開始送自己改的。
// 新的東西要同步：在 snap 加一段、在 apply 加怎麼套用就好（套用完再整理一次的內容要跟收到的一樣，不然會一直互相送）。
// ====================================================================
const NetShare = (() => {
  const TICK_MS = 400;
  const S = { known: new Map(), last: 0, wait: false, waitAt: 0, key: '' };
  const on = () => typeof Net !== 'undefined' && Net.active && Net.ready && G && curWorld <= 3 && (mode === 'play' || mode === 'modal' || mode === 'down' || mode === 'pause');
  const r2 = v => Math.round(v * 100) / 100;
  const uid = o => o.uid || (o.uid = Math.random().toString(36).slice(2, 10));

  // 現在的樣子：名字 → 內容（都是可以直接比的字串）
  function snap() {
    const m = new Map(), put = (k, v) => m.set(k, JSON.stringify(v));
    DOORS.forEach((d, i) => { if (!d.front) put('d' + i, d.closed ? 1 : 0); });
    for (const s of G.sockets) put('s' + s.id, s.bulb || 0);
    put('lamps', G.lamps.map(l => [l.type, l.x, l.y, l.bulb || 0]));
    for (const id in G.containers) put('c' + id, G.containers[id].items || []);
    for (const p of G.pickups) if (!p.got) put('p' + uid(p), [r2(p.x), r2(p.y), p.id, p.n || 1, p.keep ? 1 : 0]);
    put('pw', G.power ? 1 : 0);
    put('stock', G.stock || []);
    put('tr', G.treasure || 0);
    if (curWorld <= 2) put('chests', Object.keys(G.chests || {}).filter(k => G.chests[k]).sort());
    if (isW2()) put('fl', G.flowers.map(f => [f.x, f.y, f.lv, f.ptype || 'eye']));
    if (isW3()) {
      put('ch3', G.chests3.map(c => [c.x, c.y, c.lv, c.open ? 1 : 0, c.out ? 1 : 0]));
      put('fire', G.fire.queue.map(q => q.id));
    }
    return m;
  }
  // 把收到的一段套用到自己的遊戲裡（v 是 null：那個東西不見了）
  function apply(k, v) {
    const c = k[0], id = k.slice(1);
    if (k === 'lamps') { if (Array.isArray(v)) G.lamps = v.filter(l => inMap(l[1], l[2])).map(([type, x, y, bulb]) => G.lamps.find(o => o.type === type && o.x === x && o.y === y && (o.bulb || 0) === bulb) || { kind: 'lamp', type, x, y, bulb, dying: 0, room: roomGrid[y][x] }); return; }
    if (k === 'pw') { if (!!v !== !!G.power) { G.power = !!v; Sound.play(v ? 'powerUp' : 'lightsOff', 0.6); if (!v) toast('⚡ 停電了！', 'warn'); } return; }
    if (k === 'stock') { if (Array.isArray(v)) G.stock = v; return; }
    if (k === 'tr') { G.treasure = v && typeof v === 'object' ? v : null; return; }
    if (k === 'chests') { if (curWorld <= 2 && Array.isArray(v)) { G.chests = Object.fromEntries(v.map(x => [x, true])); syncTchests(); } return; }
    if (k === 'fl') {
      if (!isW2() || !Array.isArray(v)) return;
      G.flowers = v.filter(f => inMap(f[0], f[1])).map(([x, y, lv, pt]) => {
        const old = G.flowers.find(f => f.x === x && f.y === y && (f.ptype || 'eye') === pt);
        if (old) { if (old.lv !== lv) setLevel(old, plantKind(old), lv); return old; }
        const pl = newPlant(x, y, pt); setLevel(pl, plantKind(pl), lv || 1); pl.grow = 0.2; return pl;
      });
      return;
    }
    if (k === 'ch3') {
      if (!isW3() || !Array.isArray(v)) return;
      G.chests3 = v.filter(c => CHESTS3[c[2]] && inMap(c[0], c[1])).map(([x, y, lv, open, out]) => {
        const old = G.chests3.find(c => c.x === x && c.y === y && c.lv === lv);
        if (old) { old.open = !!open; old.out = !!out; return old; }
        return { x, y, lv, open: !!open, out: !!out, face: chestFace(x, y) };
      });
      rebuildChestGrid();
      return;
    }
    if (k === 'fire') { if (isW3() && Array.isArray(v)) G.fire.queue = v.filter(i => ITEMS[i] && ITEMS[i].kind === 'fuel').map((i, n) => (G.fire.queue[n] && G.fire.queue[n].id === i ? G.fire.queue[n] : { id: i, left: ITEMS[i].burn })); return; }
    if (c === 'd') { const d = DOORS[+id]; if (d && !d.front && !!v !== !!d.closed) { setDoor(d, !!v); Sound.play(v ? 'doorSlam' : 'door', 0.3); } return; }
    if (c === 's') { const s = G.sockets.find(o => String(o.id) === id); if (s && (s.bulb || 0) !== (v || 0)) { s.bulb = v || 0; s.dying = 0; s.eaten = 0; } return; }
    if (c === 'c') { if (G.containers[id] && Array.isArray(v)) G.containers[id].items = v; return; }
    if (c === 'p') {
      const i = G.pickups.findIndex(p => p.uid === id);
      if (!v) { if (i >= 0) G.pickups.splice(i, 1); return; }
      if (!ITEMS[v[2]]) return;
      if (i >= 0) Object.assign(G.pickups[i], { x: v[0], y: v[1], id: v[2], n: v[3] });
      else G.pickups.push({ uid: id, x: v[0], y: v[1], id: v[2], n: v[3], keep: v[4] ? 1 : undefined, t: Math.random() * 6, age: 0 });
    }
  }
  // 把一整份照著改（房主給的）
  function applyFull(list) {
    const have = new Set(list.map(([k]) => k));
    for (const k of snap().keys()) if (k[0] === 'p' && !have.has(k)) apply(k, null);   // 房主那邊沒有的地上的東西拿掉
    for (const [k, js] of list) { try { apply(k, JSON.parse(js)); } catch (e) { /* 壞掉的那一段不理 */ } }
    S.known = snap();
  }
  function tick() {
    if (!on()) { S.known.clear(); S.key = ''; S.wait = false; return; }
    const t = performance.now(), key = curWorld + '|' + G.day;
    if (key !== S.key) {
      // 換世界、換天：每台平板各自亂數出新的東西。客人等房主的那一份，房主把自己的當成大家的
      S.key = key; S.known = snap();
      if (Net.guest) { S.wait = true; S.waitAt = 0; }
      else Net.send('nsfull', { key, list: [...S.known] });
    }
    if (t - S.last < TICK_MS) return;
    S.last = t;
    if (S.wait) { if (t - S.waitAt > 3000) { S.waitAt = t; Net.send('nsreq', { key }); } S.known = snap(); return; }   // 還沒拿到房主的那一份：先不送自己的
    const cur = snap(), out = [];
    for (const [k, js] of cur) if (S.known.get(k) !== js) out.push([k, js]);
    for (const k of S.known.keys()) if (!cur.has(k)) out.push([k, 'null']);
    S.known = cur;
    if (out.length) Net.send('ns', { key, list: out });
  }
  function bind() {
    if (typeof Net === 'undefined') return;
    Net.on('ns', d => {
      if (!on() || !d || d.key !== S.key || S.wait || !Array.isArray(d.list)) return;
      for (const [k, js] of d.list) { try { apply(k, JSON.parse(js)); } catch (e) { /* 壞掉的那一段不理 */ } }
      const cur = snap();
      for (const [k] of d.list) { if (cur.has(k)) S.known.set(k, cur.get(k)); else S.known.delete(k); }   // 套用完的樣子記起來，才不會又送回去
    });
    Net.on('nsreq', (d, from) => { if (Net.isHost && on() && d && d.key === S.key) Net.sendTo(from, 'nsfull', { key: S.key, list: [...snap()] }); });
    Net.on('nsfull', d => {
      if (!Net.guest || !on() || !d || !Array.isArray(d.list)) return;
      if (d.key !== curWorld + '|' + G.day) return;
      S.key = d.key; applyFull(d.list); S.wait = false;
    });
  }
  bind();
  return { tick, snap, get waiting() { return S.wait; } };
})();
