// FEAST: steer with your head, open your mouth to eat the falling food.
// Reuses the Mood Garden face tracker (MediaPipe, on-device, in a worker).

import { Tracker } from './tracking.js?v=6';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('game');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const scoreEl = $('score');
const livesEl = $('lives');
const timerEl = $('timer');
const banner = $('banner');
const over = $('over');
const btnAudio = $('btn-audio');
const btnPause = $('btn-pause');

const ROUND = 60; // seconds
const LIVES = 3;
const FOODS = [
  { e: '🍓', pts: 10, col: '#e5707e', w: 10 },
  { e: '🍒', pts: 10, col: '#c94a5a', w: 8 },
  { e: '🍑', pts: 10, col: '#f2a38a', w: 7 },
  { e: '🍌', pts: 10, col: '#f3d36b', w: 7 },
  { e: '🍉', pts: 15, col: '#ef7d8a', w: 6 },
  { e: '🍪', pts: 15, col: '#c99560', w: 7 },
  { e: '🥐', pts: 15, col: '#dfa865', w: 6 },
  { e: '🍩', pts: 20, col: '#efa3c0', w: 5 },
  { e: '🧁', pts: 20, col: '#c9b2ea', w: 5 },
  { e: '🌟', pts: 50, col: '#f6d36a', w: 1.2, golden: true },
  { e: '💣', pts: 0, col: '#6b5960', w: 0, bomb: true },
];
const FOOD_WEIGHT = FOODS.reduce((a, f) => a + f.w, 0);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rr = (a, b) => a + Math.random() * (b - a);

let W = 0, H = 0, DPR = 1, U = 1; // U = size unit, scales with the screen
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  U = Math.min(W, H) / 800;
}
window.addEventListener('resize', resize);
resize();

// ---------- sound ----------
const sound = {
  ctx: null,
  on: true,
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.7;
    this.out.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.4;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  },
  tone(freq, dur, type = 'sine', vol = 0.15, when = 0, slide = 0) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  crunch(vol = 0.35) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = rr(1400, 2600);
    f.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    s.connect(f).connect(g).connect(this.out);
    s.start(t);
    s.stop(t + 0.15);
  },
  eat(combo) {
    this.crunch();
    setTimeout(() => this.crunch(0.25), 70);
    const scale = [0, 2, 4, 7, 9, 12, 14];
    this.tone(523 * Math.pow(2, scale[Math.min(combo - 1, 6)] / 12), 0.25, 'triangle', 0.08, 0.04);
  },
  golden() { [0, 4, 7, 12].forEach((n, i) => this.tone(659 * Math.pow(2, n / 12), 0.5, 'sine', 0.1, i * 0.07)); },
  bonk() { this.tone(260, 0.12, 'square', 0.04, 0, 0.6); },
  bomb() { this.tone(90, 0.6, 'sawtooth', 0.18, 0, 0.4); this.crunch(0.5); },
  tick(high) { this.tone(high ? 880 : 587, 0.15, 'sine', 0.1); },
};

// ---------- state ----------
let tracker = null;
let running = false; // a round is in progress
let paused = false;
let state;
const mouth = { x: 0, y: 0, w: 60, open: 0, isOpen: false, seen: false, chomp: 0, lastSeen: 0 };

function newState() {
  return {
    score: 0, lives: LIVES, time: ROUND, foods: [], bits: [], texts: [],
    spawnIn: 1.2, combo: 0, lastEat: -10, bestCombo: 0, eaten: 0, shake: 0, flash: 0, flashCol: '255,120,130',
    countdown: 3.2, lastTick: 4,
  };
}

function renderLives() {
  livesEl.innerHTML = '';
  for (let i = 0; i < LIVES; i++) {
    const s = document.createElement('span');
    s.className = 'heart' + (i >= state.lives ? ' lost' : '');
    s.textContent = '🌸';
    livesEl.appendChild(s);
  }
}

function setStatus(st, text) {
  statusEl.dataset.state = st;
  statusText.textContent = text;
}

function showBanner(text) {
  if (!text) { banner.hidden = true; return; }
  if (banner.textContent !== text) banner.textContent = text;
  banner.hidden = false;
}

// ---------- spawning ----------
function pickFood(progress) {
  // bombs get more common as the round goes on
  if (Math.random() < 0.07 + progress * 0.1) return FOODS.find((f) => f.bomb);
  let r = Math.random() * FOOD_WEIGHT;
  for (const f of FOODS) { if ((r -= f.w) <= 0) return f; }
  return FOODS[0];
}

function spawn() {
  const progress = 1 - state.time / ROUND;
  const kind = pickFood(progress);
  const size = (kind.golden ? 64 : kind.bomb ? 60 : rr(56, 72)) * U * 1.15;
  const speed = (150 + progress * 170) * U * 1.2;
  const mode = Math.random() < 0.25 + progress * 0.2 ? 'arc' : Math.random() < 0.3 ? 'drift' : 'fall';
  const f = { kind, size, rot: rr(-0.5, 0.5), vr: rr(-2, 2), age: 0, bounced: false, phase: rr(0, 6), mode };
  if (mode === 'arc') {
    // tossed in from a side, flying up and over
    const fromLeft = Math.random() < 0.5;
    f.x = fromLeft ? -size : W + size;
    f.y = H * rr(0.55, 0.85);
    f.vx = (fromLeft ? 1 : -1) * rr(160, 300) * U * (W / H > 1 ? 1.3 : 0.8);
    f.vy = -rr(520, 720) * U;
    f.g = 520 * U;
  } else {
    f.x = rr(W * 0.12, W * 0.88);
    f.y = -size;
    f.vx = mode === 'drift' ? rr(-60, 60) * U : 0;
    f.vy = speed * rr(0.8, 1.15);
    f.g = mode === 'drift' ? 0 : 40 * U;
    f.sway = mode === 'drift' ? rr(50, 110) * U : rr(10, 30) * U;
  }
  state.foods.push(f);
}

// ---------- mouth from face landmarks ----------
function toScreen(p, vw, vh) {
  // the video is drawn mirrored with object-fit: cover
  const s = Math.max(W / vw, H / vh);
  const ox = (vw * s - W) / 2, oy = (vh * s - H) / 2;
  return { x: W - (p.x * vw * s - ox), y: p.y * vh * s - oy };
}

function updateMouth(dt, now) {
  const lm = tracker?.lastFace;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  if (!lm || !tracker.running) {
    if (now - mouth.lastSeen > 900) mouth.seen = false;
    return;
  }
  mouth.lastSeen = now;
  const top = toScreen(lm[13], vw, vh), bot = toScreen(lm[14], vw, vh);
  const l = toScreen(lm[61], vw, vh), r = toScreen(lm[291], vw, vh);
  const cx = (top.x + bot.x + l.x + r.x) / 4, cy = (top.y + bot.y) / 2;
  const w = Math.hypot(l.x - r.x, l.y - r.y);
  const gap = Math.hypot(top.x - bot.x, top.y - bot.y);
  const ratio = gap / (w || 1);
  const k = mouth.seen ? 1 - Math.exp(-dt / 0.05) : 1;
  mouth.x += (cx - mouth.x) * k;
  mouth.y += (cy - mouth.y) * k;
  mouth.w += (w - mouth.w) * k;
  mouth.open += (clamp01((ratio - 0.08) / 0.4) - mouth.open) * (1 - Math.exp(-dt / 0.04));
  mouth.gap = gap;
  // hysteresis so the mouth state doesn't flicker at the threshold
  if (!mouth.isOpen && ratio > 0.3) mouth.isOpen = true;
  else if (mouth.isOpen && ratio < 0.18) mouth.isOpen = false;
  mouth.seen = true;
}

// ---------- game loop ----------
function update(dt, now) {
  if (tracker) tracker.update(now, dt);
  updateMouth(dt, now);
  mouth.chomp = Math.max(0, mouth.chomp - dt * 4);

  if (tracker?.running) {
    setStatus(mouth.seen ? 'active' : 'searching', mouth.seen ? (mouth.isOpen ? 'mouth open' : 'face tracking active') : 'looking for you');
  }
  if (!running || paused) return;

  if (!mouth.seen) { showBanner('Show me your face'); return; }
  if (banner.textContent === 'Show me your face' && state.countdown <= 0) showBanner('');

  if (state.countdown > 0) {
    state.countdown -= dt;
    const n = Math.ceil(state.countdown);
    if (n !== state.lastTick && n > 0) { state.lastTick = n; sound.tick(false); }
    showBanner(state.countdown > 0.2 ? (n > 0 ? String(n) : 'Eat!') : 'Eat!');
    if (state.countdown <= 0) { sound.tick(true); setTimeout(() => !paused && running && showBanner(''), 500); }
    return;
  }

  state.time -= dt;
  timerEl.textContent = Math.max(0, Math.ceil(state.time));
  timerEl.parentElement.classList.toggle('low', state.time < 10);
  if (state.time <= 0) return endRound('time');

  const progress = 1 - state.time / ROUND;
  state.spawnIn -= dt;
  if (state.spawnIn <= 0) {
    spawn();
    if (Math.random() < progress * 0.35) spawn(); // occasional pairs later on
    state.spawnIn = rr(0.65, 1.05) * (1 - progress * 0.5);
  }
  if (now / 1000 - state.lastEat > 2.2) state.combo = 0;

  const catchR = Math.max(mouth.w * 0.55, 34 * U);
  for (let i = state.foods.length - 1; i >= 0; i--) {
    const f = state.foods[i];
    f.age += dt;
    f.vy += f.g * dt;
    f.x += (f.vx + (f.sway ? Math.cos(f.age * 2.4 + f.phase) * f.sway : 0)) * dt;
    f.y += f.vy * dt;
    f.rot += f.vr * dt;

    const d = Math.hypot(f.x - mouth.x, f.y - mouth.y);
    if (d < catchR + f.size * 0.3) {
      if (mouth.isOpen) {
        eat(f, now);
        state.foods.splice(i, 1);
        if (!running) return;
        continue;
      } else if (!f.bounced && !f.kind.bomb) {
        // closed mouth: it bonks off your lips
        f.bounced = true;
        f.vy = -Math.abs(f.vy) * 0.45 - 120 * U;
        f.vx = (f.x < mouth.x ? -1 : 1) * rr(120, 220) * U;
        f.g = Math.max(f.g, 600 * U);
        f.vr *= 3;
        sound.bonk();
        floatText('bonk', f.x, f.y - f.size * 0.6, '#7a6a70', 0.8);
      }
    }
    if (f.y > H + f.size * 1.5 || f.x < -f.size * 3 || f.x > W + f.size * 3) {
      state.foods.splice(i, 1);
      if (!f.kind.bomb) state.combo = 0;
    }
  }

  for (let i = state.bits.length - 1; i >= 0; i--) {
    const b = state.bits[i];
    b.life -= dt;
    b.vy += 900 * U * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.life <= 0) state.bits.splice(i, 1);
  }
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    t.life -= dt;
    t.y -= 60 * U * dt;
    if (t.life <= 0) state.texts.splice(i, 1);
  }
  state.shake = Math.max(0, state.shake - dt * 3);
  state.flash = Math.max(0, state.flash - dt * 2.5);
}

function eat(f, now) {
  mouth.chomp = 1;
  burst(f.x, f.y, f.kind.col, f.kind.golden ? 26 : 14);
  if (f.kind.bomb) {
    state.lives--;
    state.combo = 0;
    state.shake = 1;
    state.flash = 1;
    state.flashCol = '230,110,120';
    sound.bomb();
    floatText('ouch!', f.x, f.y - 30 * U, '#b0505e', 1.2);
    renderLives();
    if (state.lives <= 0) endRound('lives');
    return;
  }
  state.combo = now / 1000 - state.lastEat < 2.2 ? Math.min(state.combo + 1, 6) : 1;
  state.lastEat = now / 1000;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  const pts = f.kind.pts * state.combo;
  state.score += pts;
  state.eaten++;
  scoreEl.textContent = state.score;
  floatText(`+${pts}${state.combo > 1 ? `  ×${state.combo}` : ''}`, f.x, f.y - 30 * U, f.kind.golden ? '#c99a1c' : '#2f3b33', 1);
  if (f.kind.golden) { sound.golden(); state.flash = 0.6; state.flashCol = '255,230,150'; } else sound.eat(state.combo);
}

function burst(x, y, col, n) {
  for (let i = 0; i < n; i++) {
    const a = rr(0, Math.PI * 2), s = rr(120, 380) * U;
    state.bits.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 200 * U, life: rr(0.4, 0.8), r: rr(3, 7) * U, col });
  }
}

function floatText(text, x, y, col, life) {
  state.texts.push({ text, x, y, col, life, max: life });
}

// ---------- drawing ----------
function draw(now) {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (state?.shake) ctx.translate(rr(-1, 1) * 14 * state.shake, rr(-1, 1) * 14 * state.shake);

  if (mouth.seen) drawMouth(now);

  if (state) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of state.foods) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      if (f.kind.golden || f.kind.bomb) {
        ctx.shadowColor = f.kind.golden ? 'rgba(255,215,100,0.9)' : 'rgba(120,40,60,0.6)';
        ctx.shadowBlur = 24 * U;
      } else {
        ctx.shadowColor = 'rgba(40,40,40,0.25)';
        ctx.shadowBlur = 10 * U;
        ctx.shadowOffsetY = 4 * U;
      }
      ctx.font = `${f.size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      ctx.fillText(f.kind.e, 0, 0);
      ctx.restore();
    }
    for (const b of state.bits) {
      ctx.globalAlpha = clamp01(b.life / 0.5);
      ctx.fillStyle = b.col;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const t of state.texts) {
      ctx.globalAlpha = clamp01(t.life / t.max * 1.5);
      ctx.font = `italic 500 ${Math.round(34 * U * 1.1)}px "Cormorant Garamond", Georgia, serif`;
      ctx.lineWidth = 5 * U;
      ctx.strokeStyle = 'rgba(255,250,240,0.85)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.col;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    if (state.combo > 1) {
      ctx.font = `italic 500 ${Math.round(26 * U * 1.1)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillStyle = 'rgba(47,59,51,0.85)';
      ctx.fillText(`combo ×${state.combo}`, mouth.x, mouth.y + mouth.w * 0.9 + 26 * U);
    }
  }
  ctx.restore();

  if (state?.flash) {
    ctx.fillStyle = `rgba(${state.flashCol},${state.flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawMouth(now) {
  const r = Math.max(mouth.w * 0.55, 34 * U);
  const open = mouth.isOpen;
  const pulse = 1 + Math.sin(now / 180) * 0.04 + mouth.chomp * 0.25;
  ctx.save();
  ctx.translate(mouth.x, mouth.y);
  // catch zone
  const grd = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.25 * pulse);
  grd.addColorStop(0, open ? 'rgba(255,240,200,0.35)' : 'rgba(255,255,255,0.0)');
  grd.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.25 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = (open ? 4 : 2) * U * 1.3;
  ctx.strokeStyle = open ? 'rgba(246,205,110,0.95)' : 'rgba(255,250,240,0.7)';
  ctx.setLineDash(open ? [] : [6 * U, 8 * U]);
  ctx.beginPath();
  ctx.arc(0, 0, r * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------- flow ----------
function startRound() {
  state = newState();
  running = true;
  paused = false;
  btnPause.classList.remove('paused');
  scoreEl.textContent = '0';
  timerEl.textContent = ROUND;
  timerEl.parentElement.classList.remove('low');
  renderLives();
  over.classList.add('gone');
}

function endRound(reason) {
  running = false;
  showBanner('');
  let best = 0;
  try { best = +localStorage.getItem('feast-best') || 0; } catch {}
  const isBest = state.score > best;
  if (isBest) try { localStorage.setItem('feast-best', String(state.score)); } catch {}
  $('final-score').textContent = state.score;
  $('final-detail').textContent =
    (reason === 'lives' ? 'Three bombs is too many. ' : '') +
    `You ate ${state.eaten} treat${state.eaten === 1 ? '' : 's'}, best combo ×${state.bestCombo || 1}. ` +
    (isBest ? 'A new personal best!' : `Your best is ${best}.`);
  over.classList.remove('gone');
  if (isBest) sound.golden();
}

function cameraErrorMessage(err) {
  if (!window.isSecureContext) return 'Camera access needs a secure page. Open this over https:// or from http://localhost.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this page in your browser’s address bar or site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect a webcam and try again.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it and try again.';
    default:
      return 'The game could not start the camera. ' + (err?.message || '');
  }
}

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Setting the table…';
  sound.init();
  note.classList.remove('error');
  try {
    tracker ||= new Tracker(video);
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    setStatus('searching', 'looking for you');
    startRound();
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'The face tracking models could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

$('again').addEventListener('click', () => { sound.init(); startRound(); });

btnAudio.addEventListener('click', () => {
  sound.init();
  sound.on = !sound.on;
  btnAudio.setAttribute('aria-pressed', String(sound.on));
});

function togglePause(force) {
  if (!running) return;
  paused = force ?? !paused;
  btnPause.classList.toggle('paused', paused);
  btnPause.title = paused ? 'Resume' : 'Pause';
  showBanner(paused ? 'Paused' : '');
}
btnPause.addEventListener('click', () => togglePause());
window.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'p') { e.preventDefault(); togglePause(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  update(dt, now);
  draw(now);
}
requestAnimationFrame(frame);

// testing hook: window.feast.mouth lets you fake a mouth without a camera
window.feast = { mouth, get state() { return state; }, startRound, spawn };
