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
    // 天使：飛出去的鈴聲、打中怪物的聖光
    angel() { [1046, 1318, 1568].forEach((f, i) => tone(f, 0.35, 'sine', 0.05, f * 1.01, i * 0.06)); noise(0.3, 0.06, 5000, 0, 1); },
    smite() { tone(880, 0.5, 'triangle', 0.1, 1760); tone(1320, 0.6, 'sine', 0.07, 2640, 0.05); noise(0.25, 0.2, 6000, 0, 1); },
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
  // 背景音樂
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

  // 音樂盒的一個音
  function musicBox(freq, t0, vol, dur = 1.8) {
    for (const [mult, v] of [[1, 1], [2, 0.3], [3.01, 0.1]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = freq * mult;
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

  // 詭異的搖籃曲（A 和聲小調）：[相對 A4 的半音, 拍數]，null 是休止
  const LULLABY = [
    [7, 1], [3, 1], [0, 1], [2, 1], [3, 1], [2, 1], [-1, 1], [-5, 2.5], [null, 4],
    [0, 1], [3, 1], [7, 1], [8, 1], [7, 1], [3, 1], [2, 1], [-1, 2.5], [null, 4],
    [7, 1], [8, 1], [7, 1], [3, 1], [2, 1], [0, 1], [-1, 1], [0, 3], [null, 6],
  ];
  const NIGHT_CHORDS = [[38, 39, 45], [36, 42, 43], [41, 42, 48], [33, 39, 40]];

  function scheduleNote(state, inten) {
    const [semi, beats] = LULLABY[seq % LULLABY.length];
    seq++;
    const night = state === 'night';
    const beat = state === 'day' ? 0.55 : state === 'title' ? 0.7 : 0.95 + inten * 0.3;
    if (semi !== null) {
      if (night) {
        // 壞掉的音樂盒：低八度、走音、會漏音
        if (Math.random() > 0.2 + inten * 0.4) {
          const cents = rnd(-25, 25) * (1 + inten * 2);
          const f = 440 * Math.pow(2, (semi - 12) / 12 + cents / 1200);
          musicBox(f, nextNote, 0.05, 2.4);
          if (Math.random() < inten * 0.35) musicBox(f * Math.pow(2, 1 / 12), nextNote + 0.03, 0.03, 2);
        }
      } else {
        musicBox(440 * Math.pow(2, semi / 12), nextNote, state === 'title' ? 0.04 : 0.045);
      }
    }
    nextNote += beats * beat * (semi === null && night ? 1 + inten : 1);
  }

  function music(state, inten = 0) {
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
    if (state !== curState) {
      curState = state; seq = 0;
      nextNote = now + 1; nextPad = now + 0.5; nextFx = now + rnd(3, 6);
    }
    if (nextNote < now - 1) nextNote = now + 0.1; // 分頁被暫停後重新接上
    if (nextPad < now - 1) nextPad = now + 0.1;
    if (nextFx < now - 1) nextFx = now + 0.5;
    while (nextNote < now + 0.25) scheduleNote(state, inten);

    if (nextPad < now + 0.25) {
      if (state === 'night') {
        const dur = rnd(10, 13);
        pad(NIGHT_CHORDS[Math.floor(Math.random() * NIGHT_CHORDS.length)], nextPad, dur, 0.035 + inten * 0.05, 350 + inten * 1100);
        nextPad += dur * rnd(0.55, 0.75);
      } else {
        const dur = 12;
        pad(state === 'title' ? [45, 48, 52] : [57, 60, 64], nextPad, dur, 0.018, 700);
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

  return {
    init,
    setStatic,
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
