'use strict';
// ===== 音效與背景音樂：全部用 WebAudio 即時合成，不需要任何音檔 =====
const Sound = (() => {
  let ac = null, master = null, drone = null, muted = false;
  let out = null; // 目前音效要接到哪裡（用來調整單一音效的音量）
  const MASTER_VOL = 0.55, MUSIC_VOL = 0.9;

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = muted ? 0 : MASTER_VOL;
    master.connect(ac.destination);
  }
  const rnd = (a, b) => a + Math.random() * (b - a);

  function tone(freq, dur, type = 'sine', vol = 0.2, slideTo = null, delay = 0) {
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(out || master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function noise(dur, vol = 0.2, freq = 800, delay = 0, q = 1, dest = null) {
    const t0 = ac.currentTime + delay;
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(dest || out || master);
    src.start(t0);
  }

  const sfx = {
    // 第四世界：放板子、怪物打牆、板子被打破、賣場的燈熄掉／亮起來、廣播、神秘店員的鈴鐺、酸雨、店員、奶昔、紅涎偽人、Hubert、燼皇
    plank() { noise(0.08, 0.35, 400, 0, 2); tone(140, 0.12, 'triangle', 0.15, 90); },
    wallHit() { noise(0.15, 0.45, 250, 0, 1.5); noise(0.05, 0.2, 2500, 0.02, 3); },
    plankBreak() { for (let i = 0; i < 4; i++) noise(0.07, 0.35, 1200 + i * 400, i * 0.04, 2); tone(90, 0.3, 'sawtooth', 0.12, 50); },
    lightsOff() { noise(0.25, 0.5, 120, 0, 1); tone(60, 0.6, 'sawtooth', 0.08, 40); tone(120, 0.5, 'square', 0.03, 100, 0.05); },
    lightsOn() { for (let i = 0; i < 4; i++) noise(0.03, 0.2, 3000, i * 0.12, 4); tone(100, 0.8, 'sawtooth', 0.03, 120, 0.4); },
    pa() { tone(784, 0.6, 'sine', 0.12); tone(622, 0.9, 'sine', 0.12, null, 0.45); noise(1.2, 0.08, 500, 1.0, 1); },
    // 口哨：兩聲往上滑的口哨（第四世界吹了會看到紅點、藍點）
    whistle() { tone(1900, 0.22, 'sine', 0.12, 2500); tone(2100, 0.45, 'sine', 0.12, 2900, 0.28); noise(0.5, 0.03, 3000, 0, 2); },
    bell() { tone(1568, 0.5, 'sine', 0.08); tone(2093, 0.4, 'sine', 0.05, null, 0.02); tone(1568, 0.5, 'sine', 0.06, null, 0.18); },
    acid() { noise(0.6, 0.15, 5000, 0, 0.8); },
    rain() { for (let i = 0; i < 8; i++) noise(0.05, 0.08, rnd(2500, 4500), rnd(0, 0.6), 2); },
    staffAlert() { tone(110, 0.6, 'sawtooth', 0.12, 90); tone(220, 0.4, 'triangle', 0.06, 180, 0.05); noise(0.3, 0.1, 300, 0, 1); },
    step() { noise(0.08, 0.3, 180, 0, 1.2); },
    punch() { noise(0.12, 0.6, 150, 0, 1); tone(80, 0.15, 'sine', 0.3, 40); },
    squirt() { noise(0.25, 0.3, 1800, 0, 0.6); tone(600, 0.2, 'sine', 0.05, 200); },
    mimicScreech() { tone(900, 0.6, 'sawtooth', 0.12, 1400); tone(1300, 0.5, 'square', 0.06, 700, 0.05); noise(0.5, 0.2, 2500, 0, 3); },
    friendCall() { tone(330, 0.35, 'triangle', 0.08, 440); tone(440, 0.5, 'triangle', 0.07, 300, 0.35); noise(0.6, 0.03, 800, 0, 1); },
    hubertRaise() { tone(200, 0.9, 'sawtooth', 0.06, 600); noise(0.9, 0.12, 3500, 0, 6); },
    emberRain() { noise(1.2, 0.25, 600, 0, 0.7); for (let i = 0; i < 10; i++) noise(0.03, 0.15, 4000, rnd(0, 1.2), 5); },
    pickup() { tone(660, 0.08, 'square', 0.08); tone(990, 0.12, 'square', 0.07, null, 0.07); },
    empty() { tone(220, 0.12, 'triangle', 0.1); },
    click() { noise(0.04, 0.3, 3000, 0, 2); tone(1200, 0.05, 'square', 0.05); },
    install() { noise(0.04, 0.3, 3000, 0, 2); tone(440, 0.4, 'sine', 0.08, 880, 0.05); },
    eat() { for (let i = 0; i < 3; i++) noise(0.06, 0.25, 1500, i * 0.12, 3); },
    knock() { for (let i = 0; i < 3; i++) { tone(90, 0.18, 'sine', 0.5, 50, i * 0.28); noise(0.08, 0.4, 300, i * 0.28, 2); } },
    thump() { tone(70, 0.25, 'sine', 0.45, 40); noise(0.12, 0.3, 200, 0, 2); },
    pop() { noise(0.15, 0.6, 2500, 0, 1); tone(1800, 0.1, 'square', 0.05, 200); },
    powerDown() { tone(220, 1.2, 'sawtooth', 0.12, 30); noise(0.3, 0.4, 600, 0, 1); },
    powerUp() { noise(0.1, 0.5, 400, 0, 2); tone(60, 0.8, 'sawtooth', 0.08, 120, 0.1); tone(120, 0.8, 'sine', 0.08, 240, 0.1); },
    hurt() { noise(0.35, 0.5, 400, 0, 0.7); tone(150, 0.3, 'sawtooth', 0.15, 60); },
    ring() { for (let i = 0; i < 6; i++) tone(i % 2 ? 480 : 440, 0.08, 'square', 0.06, null, i * 0.09); },
    whisper() { for (let i = 0; i < 5; i++) noise(0.4, 0.12, 2500 + Math.random() * 2000, i * 0.25, 4); },
    heartbeat() { tone(55, 0.15, 'sine', 0.5, 40); tone(50, 0.15, 'sine', 0.4, 38, 0.22); },
    dissolve() { noise(0.5, 0.25, 1200, 0, 0.8); tone(300, 0.5, 'sine', 0.05, 80); },
    tall() { tone(45, 2.5, 'sawtooth', 0.12, 35); tone(47, 2.5, 'sawtooth', 0.1, 33); noise(1.5, 0.15, 150, 0, 1); },
    dawn() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.6, 'sine', 0.08, null, i * 0.15)); },
    dusk() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.7, 'triangle', 0.08, null, i * 0.2)); if (musicIn) bell(ac.currentTime + 0.9, 0.12); },
    place() { tone(300, 0.1, 'triangle', 0.12); noise(0.05, 0.2, 800); },
    breaker() { noise(0.06, 0.6, 1500, 0, 2); tone(80, 0.1, 'square', 0.2); },
    win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.9, 'triangle', 0.1, null, i * 0.18)); },
    // 血淚女：啜泣、竊笑、尖叫
    sob() {
      for (let i = 0; i < 3; i++) { noise(0.16, 0.2, 1100, i * 0.22, 3); tone(520 - i * 30, 0.2, 'triangle', 0.06, 430 - i * 30, i * 0.22); }
      tone(480, 1.4, 'sine', 0.06, 290, 0.75); noise(1.2, 0.08, 900, 0.75, 2);
    },
    giggle() { for (let i = 0; i < 5; i++) { tone(900 - i * 40, 0.09, 'triangle', 0.06, 760 - i * 40, i * 0.11); noise(0.07, 0.07, 2600, i * 0.11, 3); } },
    scream() {
      tone(700, 0.9, 'sawtooth', 0.2, 1400); tone(745, 0.9, 'square', 0.1, 1300);
      noise(0.9, 0.5, 1800, 0, 0.6); tone(90, 0.5, 'sine', 0.5, 40);
    },
    // 黑球：吸燈、吞下去、彈跳
    slurp() { for (let i = 0; i < 3; i++) noise(0.25, 0.3, 350 + i * 220, i * 0.18, 5); tone(95, 0.6, 'sine', 0.2, 60); },
    gulp() { tone(160, 0.25, 'sine', 0.45, 55); noise(0.12, 0.4, 500, 0.05, 2); tone(900, 0.08, 'square', 0.05, 200, 0.25); },
    plop() { tone(230, 0.15, 'sine', 0.25, 90); noise(0.08, 0.2, 700, 0, 3); },
    // 眼球花尖叫
    shriek() { tone(1100, 0.9, 'sawtooth', 0.12, 1900); tone(1150, 0.9, 'square', 0.06, 1700); noise(0.8, 0.3, 3000, 0, 1); },
    // 火柴人：開心的口哨（越開心越可怕）、被燒掉
    whistle() { [784, 659, 784, 659, 1047].forEach((f, i) => tone(f, 0.2, 'sine', 0.07, f * 1.03, i * 0.22)); },
    burn() { for (let i = 0; i < 8; i++) noise(0.05, 0.3, 2500 + Math.random() * 2000, i * 0.07, 2); noise(0.8, 0.15, 800, 0, 0.5); },
    // 鳥腳女：跳躍落地、咯咯笑
    hop() { tone(80, 0.18, 'sine', 0.4, 45); noise(0.08, 0.25, 250, 0, 2); },
    cackle() { for (let i = 0; i < 6; i++) tone(1400 - i * 60, 0.07, 'square', 0.05, 900 - i * 40, i * 0.09); noise(0.5, 0.1, 2000, 0, 2); },
    // 爬行女：骨頭喀喀響
    crawl() { for (let i = 0; i < 3; i++) noise(0.025, 0.35, 3500, i * 0.06 + Math.random() * 0.03, 4); },
    tvOn() { noise(0.5, 0.35, 2500, 0, 0.5); tone(8000, 0.6, 'sine', 0.02); },
    // 小丑：笑聲、刀
    laugh() { for (let i = 0; i < 4; i++) { tone(330 - i * 12, 0.16, 'triangle', 0.09, 260 - i * 12, i * 0.2); noise(0.14, 0.12, 900, i * 0.2, 2); } },
    stab() { noise(0.12, 0.5, 4000, 0, 1); tone(200, 0.2, 'sawtooth', 0.15, 80, 0.05); },
    // 火焰燈泡：射出火球、打中怪物
    fireball() { noise(0.3, 0.3, 700, 0, 0.8); tone(200, 0.3, 'sawtooth', 0.06, 90); },
    fireHit() { tone(90, 0.3, 'sine', 0.45, 40); noise(0.25, 0.4, 1200, 0, 0.7); },
    // 天使：飛出去的鈴聲、打中怪物的聖光
    angel() { [1046, 1318, 1568].forEach((f, i) => tone(f, 0.35, 'sine', 0.05, f * 1.01, i * 0.06)); noise(0.3, 0.06, 5000, 0, 1); },
    smite() { tone(880, 0.5, 'triangle', 0.1, 1760); tone(1320, 0.6, 'sine', 0.07, 2640, 0.05); noise(0.25, 0.2, 6000, 0, 1); },
    // 武器
    swish() { noise(0.14, 0.3, 900, 0, 0.8); noise(0.12, 0.2, 1800, 0.03, 1.2); },
    clang() {
      noise(0.05, 0.6, 3000, 0, 1); tone(520, 0.55, 'triangle', 0.22, 505);
      tone(1310, 0.4, 'sine', 0.1, 1290); tone(2150, 0.3, 'sine', 0.05, 2120); tone(90, 0.15, 'sine', 0.3, 50);
    },
    twang() { tone(190, 0.2, 'triangle', 0.22, 95); noise(0.05, 0.3, 2200, 0, 2); },
    tick() { tone(1900, 0.05, 'square', 0.05, 1400); noise(0.04, 0.35, 4200, 0, 3); },
    salt() { for (let i = 0; i < 7; i++) noise(0.05, 0.25, 4500 + Math.random() * 3000, i * 0.035, 3); noise(0.45, 0.15, 7000, 0.08, 1); },
    spray() { noise(0.6, 0.35, 3200, 0, 0.6); noise(0.5, 0.15, 900, 0.05, 1); },
    fuse() { noise(1.0, 0.14, 6000, 0, 2); for (let i = 0; i < 5; i++) noise(0.02, 0.2, 3500, 0.1 + i * 0.17, 3); },
    bang() {
      tone(65, 0.7, 'sine', 0.8, 30); noise(0.6, 0.9, 900, 0, 0.5); noise(0.3, 0.6, 3000, 0, 0.8);
      for (let i = 0; i < 8; i++) noise(0.03, 0.4, 2500 + Math.random() * 2500, 0.12 + i * 0.05 + Math.random() * 0.03, 2);
    },
    // 拿到燈泡的燈泡卡：稀有、史詩、傳奇越來越華麗
    card() { tone(880, 0.08, 'square', 0.05); tone(1320, 0.14, 'square', 0.05, null, 0.06); },
    cardEpic() { [660, 880, 1320].forEach((f, i) => tone(f, 0.3, 'triangle', 0.08, null, i * 0.07)); noise(0.4, 0.08, 6000, 0.1, 1); },
    cardLegend() {
      [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.5, 'triangle', 0.09, null, i * 0.07));
      tone(2093, 0.9, 'sine', 0.05, 2100, 0.35); noise(0.6, 0.1, 7000, 0.3, 1);
    },
    heal() { [784, 988, 1175].forEach((f, i) => tone(f, 0.4, 'sine', 0.06, null, i * 0.09)); },
    // 第二世界：跳、落地
    jump() { tone(300, 0.16, 'sine', 0.1, 620); noise(0.05, 0.12, 900, 0, 2); },
    land() { tone(95, 0.12, 'sine', 0.25, 50); noise(0.06, 0.2, 500, 0, 2); },
    // 草叢人：沙沙聲、從草裡站起來、抓住腳
    rustle() { for (let i = 0; i < 4; i++) noise(0.08, 0.16, 3200 + Math.random() * 2500, i * 0.07, 1.4); },
    grassRise() { noise(0.35, 0.3, 1800, 0, 0.8); tone(150, 0.4, 'sawtooth', 0.07, 320); },
    grab() { noise(0.25, 0.5, 600, 0, 1); tone(110, 0.35, 'square', 0.12, 65); tone(240, 0.25, 'sawtooth', 0.06, 120, 0.05); },
    // 向日葵眼：吐種子、種子打到你；踩爛眼睛種子
    spit() { tone(520, 0.07, 'square', 0.06, 200); noise(0.05, 0.25, 2200, 0, 3); },
    seedHit() { tone(1300, 0.05, 'square', 0.05, 600); noise(0.05, 0.35, 3000, 0, 3); },
    stomp() { noise(0.1, 0.5, 1100, 0, 1); tone(160, 0.12, 'sine', 0.22, 70); },
    // 千眼菇：滴水、撒孢子
    drip() { tone(1500, 0.08, 'sine', 0.08, 700); tone(950, 0.07, 'sine', 0.05, 480, 0.1); },
    spore() { noise(0.9, 0.2, 5000, 0, 0.7); tone(600, 0.9, 'sine', 0.03, 950); },
    // 大嘴觸角蟲：咬下去、縮起來
    chomp() { for (let i = 0; i < 2; i++) { tone(120, 0.15, 'square', 0.22, 55, i * 0.2); noise(0.12, 0.55, 900, i * 0.2, 1); } },
    squish() { noise(0.3, 0.3, 500, 0, 3); tone(210, 0.25, 'sine', 0.15, 110); },
    // 眼花女孩：有點走音的哼歌
    hum() {
      const base = 330, notes = [0, 3, 7, 5, 3, 2];
      notes.forEach((n, i) => tone(base * Math.pow(2, n / 12) * (1 + (Math.random() - 0.5) * 0.02), 0.42, 'triangle', 0.05, null, i * 0.34));
    },
    // 萬物甦醒、破關動畫開門
    awaken() {
      [392, 466, 587, 740, 932].forEach((f, i) => tone(f, 1.6, 'sine', 0.05, f * 0.98, i * 0.18));
      for (let i = 0; i < 5; i++) noise(0.5, 0.08, 2500 + Math.random() * 2000, 0.4 + i * 0.25, 4);
    },
    doorOpen() {
      tone(170, 1.3, 'sawtooth', 0.05, 110); noise(1.1, 0.12, 900, 0, 6);
      [1046, 1318, 1568, 2093].forEach((f, i) => tone(f, 1.4, 'sine', 0.05, null, 0.7 + i * 0.16));
    },
    // ---------- 第三世界：列車 ----------
    clack() { noise(0.05, 0.5, 700, 0, 1.2); noise(0.04, 0.4, 500, 0.11, 1.2); tone(70, 0.08, 'sine', 0.25, 50); },
    whistle() { for (const f of [392, 466]) { tone(f, 1.6, 'sawtooth', 0.06, f * 1.01, 0.05); tone(f * 2, 1.6, 'sine', 0.03, f * 2, 0.05); } noise(1.8, 0.12, 3000, 0, 0.8); },
    steam() { noise(1.4, 0.2, 2500, 0, 0.5); noise(0.9, 0.12, 900, 0.1, 0.8); },
    doorSlam() { noise(0.1, 0.6, 400, 0, 1); tone(60, 0.25, 'sine', 0.5, 35); noise(0.3, 0.3, 1800, 0.05, 2); },
    fuelIn() { noise(0.25, 0.4, 600, 0, 1); for (let i = 0; i < 6; i++) noise(0.05, 0.3, 2500 + Math.random() * 2500, 0.1 + i * 0.08, 2); tone(90, 0.3, 'sine', 0.2, 60, 0.05); },
    trainSlow() { tone(120, 2.5, 'sawtooth', 0.08, 30); noise(2.5, 0.25, 1200, 0, 0.6); },
    trainStop() { tone(45, 1.8, 'sine', 0.5, 25); noise(1.2, 0.5, 300, 0, 1); for (let i = 0; i < 4; i++) noise(0.08, 0.4, 2200, 0.5 + i * 0.12, 2); },
    trainStart() { for (let i = 0; i < 6; i++) { noise(0.3, 0.35, 2000, i * 0.55 * (1 - i * 0.08), 0.6); tone(60, 0.2, 'sine', 0.3, 40, i * 0.55 * (1 - i * 0.08)); } },
    pound() { tone(55, 0.3, 'sine', 0.6, 35); noise(0.15, 0.5, 250, 0, 1.5); noise(0.4, 0.2, 90, 0.05, 1); },
    wind() { noise(2.5, 0.14, 500, 0, 0.4); noise(2.0, 0.08, 1500, 0.6, 0.6); },
    // 時鐘倒轉（蕈裂刺中你）
    clockBack() { for (let i = 0; i < 8; i++) tone(1800 - i * 150, 0.05, 'square', 0.05, 2400 - i * 150, i * 0.07); tone(300, 0.6, 'sawtooth', 0.06, 900); noise(0.5, 0.15, 4000, 0, 1); },
    // 蕈裂：咯咯笑、長矛刺、孢子
    kcackle() { for (let i = 0; i < 6; i++) { tone(260 + i * 25, 0.08, 'square', 0.06, 200 + i * 20, i * 0.1); noise(0.06, 0.1, 1400, i * 0.1, 3); } },
    spear() { noise(0.12, 0.4, 2600, 0, 1.5); tone(180, 0.2, 'sawtooth', 0.12, 70); },
    // 熔岩暴君：跺腳、熔岩嘶聲、岩石碎掉
    stompBig() { tone(40, 0.6, 'sine', 0.8, 25); noise(0.4, 0.6, 180, 0, 1); noise(0.2, 0.3, 900, 0.05, 1.5); },
    hiss() { noise(1.2, 0.4, 5000, 0, 0.7); noise(0.8, 0.2, 2000, 0.2, 1); tone(400, 0.8, 'sine', 0.03, 120); },
    crack() { noise(0.08, 0.6, 1800, 0, 1); for (let i = 0; i < 5; i++) noise(0.04, 0.4, 2800 + Math.random() * 2000, 0.08 + i * 0.05, 2); tone(110, 0.25, 'sine', 0.3, 50); },
    // 墮落戰神：鐵甲、劍磨地、揮劍
    armor() { noise(0.06, 0.35, 2500, 0, 3); noise(0.05, 0.3, 1800, 0.08, 3); tone(90, 0.15, 'sine', 0.25, 60); },
    swordDrag() { noise(0.7, 0.14, 3600, 0, 1.2); for (let i = 0; i < 4; i++) noise(0.03, 0.2, 5000 + Math.random() * 3000, 0.1 + i * 0.15, 3); },
    swordSwing() { noise(0.25, 0.5, 1400, 0, 0.7); noise(0.2, 0.35, 3000, 0.05, 1); tone(200, 0.3, 'sawtooth', 0.1, 60); },
    // 檮杌：咆哮加上很多人在低語
    roar() { tone(70, 1.6, 'sawtooth', 0.25, 45); tone(73, 1.6, 'square', 0.1, 48); noise(1.4, 0.4, 350, 0, 0.8); for (let i = 0; i < 6; i++) noise(0.5, 0.08, 2200 + Math.random() * 2500, 0.3 + i * 0.2, 4); },
    // 大白：抱住你
    hug() { tone(220, 1.2, 'sine', 0.05, 330); tone(330, 1.2, 'sine', 0.04, 440, 0.3); noise(0.8, 0.05, 1200, 0, 0.8); },
    // 寶箱：打開、跑出怪物
    chestOpen() { noise(0.4, 0.2, 700, 0, 2); tone(140, 0.5, 'sawtooth', 0.06, 90); [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.4, 'sine', 0.05, null, 0.4 + i * 0.08)); },
    chestMonster() { noise(0.6, 0.6, 500, 0, 0.6); tone(60, 0.5, 'sine', 0.5, 30); tone(500, 0.5, 'sawtooth', 0.12, 1000, 0.1); noise(0.4, 0.3, 2500, 0.2, 1); },
  };

  // 夜晚的低頻嗡嗡聲
  function setDrone(level) {
    if (!ac) return;
    if (!drone) {
      const o1 = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
      o1.type = 'sine'; o1.frequency.value = 48;
      o2.type = 'sine'; o2.frequency.value = 51.5;
      g.gain.value = 0;
      o1.connect(g); o2.connect(g); g.connect(master);
      o1.start(); o2.start();
      drone = g;
    }
    drone.gain.setTargetAtTime(level * 0.18, ac.currentTime, 0.8);
  }

  // ==================================================================
  // 背景音樂：每個世界不一樣（設計師的要求）
  //   第一世界（和主選單）：白天是音樂盒的搖籃曲、晚上是壞掉的音樂盒
  //   第二世界：白天〈月亮升起〉（Rise the Moon）輕快的圓舞曲、晚上〈扭曲的夢境〉：同一首放慢、走音、音會往下滑
  //   第三世界：白天是葛利格《皮爾金》的〈清晨〉（長笛）、晚上是老唱片放的〈恭喜恭喜〉（有沙沙聲、轉速忽快忽慢，古老的感覺）
  // ==================================================================
  let musicIn = null, musicOut = null, musicOn = -1;
  let curState = '', nextNote = 0, nextPad = 0, nextFx = 0, seq = 0;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // 帶回音的音樂匯流排
  function ensureMusic() {
    if (musicIn) return;
    musicIn = ac.createGain();
    musicOut = ac.createGain(); musicOut.gain.value = 0;
    const delay = ac.createDelay(2); delay.delayTime.value = 0.43;
    const fb = ac.createGain(); fb.gain.value = 0.42;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600;
    musicIn.connect(musicOut);
    musicIn.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(musicOut);
    musicOut.connect(master);
  }

  // 音樂盒的一個音；warpTo 有給的話，音會在響的時候慢慢滑到那個頻率（扭曲的夢境）
  function musicBox(freq, t0, vol, dur = 1.8, warpTo = null) {
    for (const [mult, v] of [[1, 1], [2, 0.3], [3.01, 0.1]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(freq * mult, t0);
      if (warpTo) o.frequency.exponentialRampToValueAtTime(warpTo * mult, t0 + dur * 0.8);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * v, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / Math.sqrt(mult));
      o.connect(g); g.connect(musicIn);
      o.start(t0); o.stop(t0 + dur + 0.1);
    }
  }
  // 慢慢湧起的陰暗和弦
  function pad(midis, t0, dur, vol, cutoff) {
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.4);
    out.gain.setValueAtTime(vol, t0 + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(cutoff * 0.5, t0);
    f.frequency.linearRampToValueAtTime(cutoff, t0 + dur * 0.5);
    f.frequency.linearRampToValueAtTime(cutoff * 0.4, t0 + dur);
    f.connect(out); out.connect(musicIn);
    for (const m of midis) for (const det of [-8, 8]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t0); o.stop(t0 + dur + 0.1);
    }
  }
  // 遠處像小提琴的尖細哀鳴
  function wail(t0, vol) {
    const base = rnd(900, 1500), dur = rnd(2.5, 4);
    const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(base, t0);
    o.frequency.exponentialRampToValueAtTime(base * rnd(0.55, 0.8), t0 + dur);
    lfo.frequency.value = rnd(5, 7); lg.gain.value = base * 0.015;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(musicIn);
    o.start(t0); lfo.start(t0); o.stop(t0 + dur + 0.1); lfo.stop(t0 + dur + 0.1);
  }
  // 遠處的悶響
  function boom(t0, vol) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(55, t0); o.frequency.exponentialRampToValueAtTime(28, t0 + 1.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8);
    o.connect(g); g.connect(musicIn);
    o.start(t0); o.stop(t0 + 2);
  }
  // 低沉的鐘聲
  function bell(t0, vol) {
    for (const [mult, v, d] of [[1, 1, 5], [2, 0.5, 3.5], [2.76, 0.35, 2.5], [5.4, 0.15, 1.5]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = 98 * mult;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * v, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); g.connect(musicIn);
      o.start(t0); o.stop(t0 + d + 0.1);
    }
  }

  // ---------- 曲子：[相對 A4 的半音, 拍數]，null 是休止 ----------
  // 第一世界（和主選單）：詭異的搖籃曲（A 和聲小調）
  const LULLABY = [
    [7, 1], [3, 1], [0, 1], [2, 1], [3, 1], [2, 1], [-1, 1], [-5, 2.5], [null, 4],
    [0, 1], [3, 1], [7, 1], [8, 1], [7, 1], [3, 1], [2, 1], [-1, 2.5], [null, 4],
    [7, 1], [8, 1], [7, 1], [3, 1], [2, 1], [0, 1], [-1, 1], [0, 3], [null, 6],
  ];
  // 第二世界白天：〈月亮升起〉（Rise the Moon）——自己寫的 D 大調圓舞曲，輕飄飄的夢核花園；晚上同一首變成〈扭曲的夢境〉
  const RISE = [
    [5, 1], [7, 1], [9, 2], [12, 1], [9, 1], [7, 2], [5, 1], [2, 1], [0, 3], [null, 1],
    [5, 1], [7, 1], [9, 2], [14, 1], [12, 1], [9, 2], [7, 1], [9, 1], [5, 3], [null, 1],
    [12, 1], [14, 1], [17, 2], [14, 1], [12, 1], [9, 2], [7, 1], [5, 1], [2, 2], [0, 2], [null, 2],
    [2, 1], [5, 1], [7, 2], [9, 1], [7, 1], [5, 2], [2, 1], [0, 1], [-3, 3], [null, 3],
  ];
  // 第三世界晚上：〈恭喜恭喜〉（1946 年陳歌辛寫的老歌，A 小調；照記憶簡化的版本）用老唱片放，有古老的感覺
  const GONGXI = [
    [3, 1], [3, 1], [3, 1], [3, 1], [2, 1], [3, 2], [7, 1], [7, 1], [7, 1], [7, 1], [5, 1], [7, 2],
    [12, 1], [12, 1], [12, 1], [12, 1], [10, 1], [12, 2], [12, 1], [10, 1], [7, 1], [5, 1], [3, 1], [0, 2], [null, 2],
    [0, 1], [0, 1], [0, 1], [0, 1], [3, 1], [3, 1], [2, 1], [0, 2], [null, 1], [0, 1], [0, 1], [0, 1], [0, 1], [3, 1], [2, 1], [0, 3], [null, 3],
  ];
  // 第三世界白天：葛利格《皮爾金》的〈清晨〉（E 大調、6/8 拍，長笛的主題；照記憶簡化的版本）
  const MORNING = [
    [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [11, 1], [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [11, 1],
    [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [9, 1], [7, 1], [9, 1],
    [11, 3], [null, 1], [14, 1], [16, 1], [14, 2], [11, 1], [9, 1], [7, 3], [null, 3],
    [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [11, 1], [11, 1], [9, 1], [7, 1], [9, 1], [11, 1], [11, 1],
    [14, 1], [11, 1], [9, 1], [11, 1], [14, 1], [14, 1], [16, 1], [14, 1], [11, 1], [9, 1], [7, 3], [null, 4],
  ];
  const NIGHT_CHORDS = [[38, 39, 45], [36, 42, 43], [41, 42, 48], [33, 39, 40]];
  // 白天的和弦（跟著各世界的曲子的調）：第一世界 A 小調、第二世界 D 大調、第三世界 E 大調
  const DAY_CHORDS = { 1: [57, 60, 64], 2: [50, 54, 57], 3: [52, 56, 59] };

  // 長笛（〈清晨〉）：正弦波加一點抖音，起音慢
  function flute(freq, t0, vol, dur) {
    const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    lfo.frequency.value = 5.5; lg.gain.value = freq * 0.006;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.07);
    g.gain.setValueAtTime(vol, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(musicIn);
    o.start(t0); lfo.start(t0); o.stop(t0 + dur + 0.05); lfo.stop(t0 + dur + 0.05);
  }
  // 老唱片（〈恭喜恭喜〉）：悶悶的三角波，轉速忽快忽慢（音會輕輕飄）
  function gramo(freq, t0, vol, dur) {
    const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain(), f = ac.createBiquadFilter();
    o.type = 'triangle'; o.frequency.value = freq;
    lfo.frequency.value = 0.7; lg.gain.value = 14;   // 轉速不穩：±14 音分
    lfo.connect(lg); lg.connect(o.detune);
    f.type = 'lowpass'; f.frequency.value = 1500; f.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(f); f.connect(g); g.connect(musicIn);
    o.start(t0); lfo.start(t0); o.stop(t0 + dur + 0.05); lfo.stop(t0 + dur + 0.05);
  }
  // 唱片的沙沙聲和劈啪聲
  function crackle(t0, vol) {
    noise(0.03, vol, 3500, t0 - ac.currentTime, 2, musicIn);
    if (Math.random() < 0.5) noise(0.02, vol * 0.7, 5000, t0 - ac.currentTime + rnd(0.1, 0.4), 3, musicIn);
  }

  function scheduleNote(state, inten, world) {
    const night = state === 'night', title = state === 'title';
    const tune = title || world === 1 ? LULLABY : world === 3 ? (night ? GONGXI : MORNING) : RISE;
    const [semi, beats] = tune[seq % tune.length];
    seq++;
    let beat;
    if (title) beat = 0.7;
    else if (world === 3) beat = night ? 0.6 + inten * 0.15 : 0.3;     // 老唱片慢慢放；〈清晨〉是 6/8 的八分音符，流動感
    else if (world === 2) beat = night ? 0.85 + inten * 0.3 : 0.4;     // 圓舞曲輕快；扭曲的夢境慢
    else beat = state === 'day' ? 0.55 : 0.95 + inten * 0.3;
    if (semi !== null) {
      if (world === 3 && !night && !title) flute(mtof(69 + semi), nextNote, 0.04, beats * beat * 1.15);
      else if (world === 3 && !title) {
        // 老唱片：低八度、每個音都有一點走音；越緊張越走音、沙沙聲越多
        const cents = rnd(-10, 10) * (1 + inten * 2);
        gramo(440 * Math.pow(2, (semi - 12) / 12 + cents / 1200), nextNote, 0.055, beats * beat * 1.7);
        if (Math.random() < 0.4 + inten * 0.4) crackle(nextNote + rnd(0, beat), 0.04 + inten * 0.05);
      } else if (world === 2 && night && !title) {
        // 扭曲的夢境：〈月亮升起〉低八度、走音、會漏音，音還會往下滑（像錄音帶被拉慢）
        if (Math.random() > 0.15 + inten * 0.35) {
          const cents = rnd(-30, 30) * (1 + inten * 2);
          const f = 440 * Math.pow(2, (semi - 12) / 12 + cents / 1200);
          musicBox(f, nextNote, 0.05, 2.6, Math.random() < 0.45 + inten * 0.4 ? f * rnd(0.7, 0.9) : null);
          if (Math.random() < inten * 0.3) musicBox(f * Math.pow(2, -1 / 12), nextNote + 0.05, 0.03, 2);
        }
      } else if (world === 2 && !title) {
        const f = 440 * Math.pow(2, semi / 12);
        musicBox(f, nextNote, 0.045);
        if (Math.random() < 0.4) flute(f * 2, nextNote + 0.02, 0.012, beats * beat * 1.2);   // 高八度輕輕跟著吹
      } else if (night && !title) {
        // 壞掉的音樂盒：低八度、走音、會漏音
        if (Math.random() > 0.2 + inten * 0.4) {
          const cents = rnd(-25, 25) * (1 + inten * 2);
          const f = 440 * Math.pow(2, (semi - 12) / 12 + cents / 1200);
          musicBox(f, nextNote, 0.05, 2.4);
          if (Math.random() < inten * 0.35) musicBox(f * Math.pow(2, 1 / 12), nextNote + 0.03, 0.03, 2);
        }
      } else {
        musicBox(440 * Math.pow(2, semi / 12), nextNote, title ? 0.04 : 0.045);
      }
    }
    nextNote += beats * beat * (semi === null && night && !title ? 1 + inten : 1);
  }

  // state：day／night／title／off；world：現在的世界（主選單傳 1）
  function music(state, inten = 0, world = 1) {
    if (!ac) return;
    ensureMusic();
    const now = ac.currentTime;
    const on = state === 'off' ? 0 : 1;
    if (on !== musicOn) {
      musicOn = on;
      musicOut.gain.cancelScheduledValues(now);
      musicOut.gain.setTargetAtTime(on * MUSIC_VOL, now, on ? 1.2 : 0.4);
    }
    if (!on) { curState = ''; return; }
    const key = state + ':' + world;
    if (key !== curState) {
      curState = key; seq = 0;
      nextNote = now + 1; nextPad = now + 0.5; nextFx = now + rnd(3, 6);
    }
    if (nextNote < now - 1) nextNote = now + 0.1; // 分頁被暫停後重新接上
    if (nextPad < now - 1) nextPad = now + 0.1;
    if (nextFx < now - 1) nextFx = now + 0.5;
    while (nextNote < now + 0.25) scheduleNote(state, inten, world);

    if (nextPad < now + 0.25) {
      if (state === 'night') {
        const dur = rnd(10, 13);
        pad(NIGHT_CHORDS[Math.floor(Math.random() * NIGHT_CHORDS.length)], nextPad, dur, 0.035 + inten * 0.05, 350 + inten * 1100);
        nextPad += dur * rnd(0.55, 0.75);
      } else {
        const dur = 12;
        pad(state === 'title' ? [45, 48, 52] : DAY_CHORDS[world] || DAY_CHORDS[1], nextPad, dur, 0.018, 700);
        nextPad += rnd(14, 20);
      }
    }
    if (state === 'night' && nextFx < now + 0.25) {
      if (Math.random() < 0.45 + inten * 0.3) wail(nextFx, 0.018 + inten * 0.025);
      else boom(nextFx, 0.25 + inten * 0.2);
      nextFx += rnd(5, 10) * (1 - inten * 0.5);
    }
  }

  // 電視的雜訊聲（持續播放，音量隨距離變化）
  let staticG = null;
  function setStatic(level) {
    if (!ac) return;
    if (!staticG) {
      const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 0.5;
      staticG = ac.createGain(); staticG.gain.value = 0;
      src.connect(f); f.connect(staticG); staticG.connect(master);
      src.start();
    }
    staticG.gain.setTargetAtTime(level * 0.1, ac.currentTime, 0.1);
  }

  // 火爐燃燒的劈啪聲（持續播放，音量隨距離和火力變化）
  let fireG = null;
  function setFire(level) {
    if (!ac) return;
    if (!fireG) {
      const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.004 ? 1 : 0.25);
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
      fireG = ac.createGain(); fireG.gain.value = 0;
      src.connect(f); f.connect(fireG); fireG.connect(master);
      src.start();
    }
    fireG.gain.setTargetAtTime(level * 0.25, ac.currentTime, 0.15);
  }

  return {
    init,
    setStatic,
    setFire,
    play(name, vol = 1) {
      if (!ac || muted || !sfx[name]) return;
      if (vol !== 1) { out = ac.createGain(); out.gain.value = vol; out.connect(master); }
      sfx[name]();
      out = null;
    },
    setDrone,
    music,
    isMuted: () => muted,
    toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : MASTER_VOL; return muted; },
  };
})();
