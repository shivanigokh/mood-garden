// STUDIO: play instruments with your hands in the air.
// Harmonium (squeeze the bellows), air drums and a theremin.
// Hand tracking: MediaPipe Hand Landmarker (on-device, in a worker). Sound: Web Audio.

import { Tracker } from './tracking.js?v=5';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const hint = $('hint');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const btnSkeleton = $('btn-skeleton');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

let W = 0, H = 0, DPR = 1, U = 1;
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

let tracker = null;
let instrument = 'harmonium';
let showSkeleton = true;

// ======================================================================
// Audio
// ======================================================================
const A = { ctx: null };
function initAudio() {
  if (A.ctx) { A.ctx.resume(); return; }
  const ac = (A.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }));
  A.master = ac.createDynamicsCompressor();
  A.master.threshold.value = -14;
  A.master.ratio.value = 4;
  A.master.connect(ac.destination);
  // small room reverb from a synthetic impulse
  const len = ac.sampleRate * 1.8;
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  A.verb = ac.createConvolver();
  A.verb.buffer = ir;
  const wet = ac.createGain();
  wet.gain.value = 0.25;
  A.verb.connect(wet).connect(A.master);
  A.dry = ac.createGain();
  A.dry.connect(A.master);
  A.dry.connect(A.verb);
  const n = ac.sampleRate * 1.5;
  A.noise = ac.createBuffer(1, n, ac.sampleRate);
  const nd = A.noise.getChannelData(0);
  for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;
  harmonium.build();
  theremin.build();
}

// ---------- harmonium: reeds that only sound while air moves ----------
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14];
const SARGAM = ['Sa', 'Re', 'Ga', 'Ma', 'Pa', 'Dha', 'Ni', 'Sa', 'Re'];
const BASE = 60; // middle C as Sa
const harmonium = {
  air: 0, noteIdx: 3, ext: null, extV: 0,
  build() {
    const ac = A.ctx;
    this.out = ac.createGain();
    this.out.gain.value = 0;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.Q.value = 0.8;
    const body = ac.createBiquadFilter(); // a little nasal reed resonance
    body.type = 'peaking';
    body.frequency.value = 1100;
    body.gain.value = 5;
    lp.connect(body).connect(this.out).connect(A.dry);
    this.lp = lp;
    const reed = (type, mult, gain, det) => {
      const o = ac.createOscillator();
      o.type = type;
      o.detune.value = det;
      const g = ac.createGain();
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start();
      return { o, mult };
    };
    this.reeds = [reed('sawtooth', 1, 0.32, -4), reed('sawtooth', 1, 0.22, 5), reed('square', 2, 0.07, 0), reed('sawtooth', 0.5, 0.18, 2)];
    // drone on Sa + Pa an octave down
    this.drone = ac.createGain();
    this.drone.gain.value = 0;
    const dlp = ac.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 900;
    dlp.connect(this.drone).connect(A.dry);
    for (const m of [BASE - 12, BASE - 5]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      const g = ac.createGain();
      g.gain.value = 0.12;
      o.connect(g).connect(dlp);
      o.start();
    }
    // breathy bellows noise
    const ns = ac.createBufferSource();
    ns.buffer = A.noise;
    ns.loop = true;
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 700;
    nf.Q.value = 0.6;
    this.breath = ac.createGain();
    this.breath.gain.value = 0;
    ns.connect(nf).connect(this.breath).connect(A.dry);
    ns.start();
    this.setNote(this.noteIdx, true);
  },
  setNote(i, now) {
    this.noteIdx = i;
    if (!A.ctx) return;
    const f = mtof(BASE + SCALE[i]);
    const t = A.ctx.currentTime;
    for (const r of this.reeds) r.o.frequency.setTargetAtTime(f * r.mult, t, now ? 0 : 0.012);
  },
  setAir(level, on) {
    if (!A.ctx) return;
    const t = A.ctx.currentTime;
    this.out.gain.setTargetAtTime(on ? level * 0.55 : 0, t, 0.04);
    this.drone.gain.setTargetAtTime(on ? level * 0.35 : 0, t, 0.08);
    this.breath.gain.setTargetAtTime(on ? level * 0.03 : 0, t, 0.05);
    this.lp.frequency.setTargetAtTime(1200 + level * 2600, t, 0.05);
  },
};

// ---------- theremin ----------
const theremin = {
  build() {
    const ac = A.ctx;
    this.o = ac.createOscillator();
    this.o.type = 'sine';
    this.o2 = ac.createOscillator();
    this.o2.type = 'triangle';
    const g2 = ac.createGain();
    g2.gain.value = 0.25;
    this.vib = ac.createOscillator();
    this.vib.frequency.value = 5.5;
    this.vibAmt = ac.createGain();
    this.vibAmt.gain.value = 0;
    this.vib.connect(this.vibAmt);
    this.vibAmt.connect(this.o.frequency);
    this.vibAmt.connect(this.o2.frequency);
    this.out = ac.createGain();
    this.out.gain.value = 0;
    const delay = ac.createDelay(1);
    delay.delayTime.value = 0.28;
    const fb = ac.createGain();
    fb.gain.value = 0.3;
    this.o.connect(this.out);
    this.o2.connect(g2).connect(this.out);
    this.out.connect(A.dry);
    this.out.connect(delay).connect(fb).connect(delay);
    fb.connect(A.dry);
    this.o.frequency.value = this.o2.frequency.value = 440;
    this.o.start(); this.o2.start(); this.vib.start();
  },
  set(freq, vol) {
    if (!A.ctx) return;
    const t = A.ctx.currentTime;
    this.o.frequency.setTargetAtTime(freq, t, 0.03);
    this.o2.frequency.setTargetAtTime(freq, t, 0.03);
    this.vibAmt.gain.setTargetAtTime(freq * 0.012, t, 0.2);
    this.out.gain.setTargetAtTime(vol * 0.35, t, 0.05);
  },
};

// ---------- drums ----------
function drum(kind, vel = 1) {
  if (!A.ctx) return;
  const ac = A.ctx, t = ac.currentTime + 0.002;
  const v = 0.35 + vel * 0.65;
  const env = (node, peak, decay) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak * v, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    node.connect(g).connect(A.dry);
    return g;
  };
  const noise = (dur) => { const s = ac.createBufferSource(); s.buffer = A.noise; s.start(t); s.stop(t + dur); return s; };
  const tone = (type, f0, f1, dur) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    o.start(t);
    o.stop(t + dur);
    return o;
  };
  const filt = (src, type, f, q = 1) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; src.connect(b); return b; };
  switch (kind) {
    case 'kick':
      env(tone('sine', 150, 42, 0.5), 1.1, 0.45);
      env(filt(noise(0.03), 'lowpass', 1500), 0.3, 0.03);
      break;
    case 'snare':
      env(tone('triangle', 240, 170, 0.15), 0.45, 0.12);
      env(filt(noise(0.25), 'highpass', 1200), 0.6, 0.2);
      break;
    case 'hihat':
      env(filt(filt(noise(0.08), 'highpass', 7000), 'bandpass', 10000, 0.8), 0.45, 0.06);
      break;
    case 'tom':
      env(tone('sine', 190, 95, 0.4), 0.8, 0.35);
      break;
    case 'crash':
      env(filt(noise(1.4), 'highpass', 4500), 0.45, 1.3);
      env(filt(noise(0.5), 'bandpass', 3200, 2), 0.2, 0.4);
      break;
  }
}

// ======================================================================
// Hands (screen space, mirrored)
// ======================================================================
let hands = []; // { id, pts, raw, palm, tip, vy, vx, open, t, seen }
let nextId = 1;
let lastHandsRef = null;
let fakeHands = null; // test hook: normalized landmark lists that replace the camera's

function toScreen(p, vw, vh) {
  const s = Math.max(W / vw, H / vh);
  const ox = (vw * s - W) / 2, oy = (vh * s - H) / 2;
  return { x: W - (p.x * vw * s - ox), y: p.y * vh * s - oy };
}

function updateHands(now) {
  const list = fakeHands || tracker?.lastHands;
  if (!tracker?.running) { hands = []; return false; }
  if (list === lastHandsRef) {
    // no new detection this frame: drop hands that have gone stale
    hands = hands.filter((h) => now - h.t < 350);
    return false;
  }
  lastHandsRef = list;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const fresh = (list || []).map((lm) => {
    const raw = lm.map((p) => toScreen(p, vw, vh));
    const palmIdx = [0, 5, 9, 13, 17];
    const palm = { x: 0, y: 0 };
    for (const i of palmIdx) { palm.x += raw[i].x / 5; palm.y += raw[i].y / 5; }
    const size = Math.hypot(raw[0].x - raw[9].x, raw[0].y - raw[9].y) || 1;
    let reach = 0;
    for (const i of [8, 12, 16, 20]) reach += Math.hypot(raw[i].x - raw[0].x, raw[i].y - raw[0].y) / size;
    return { raw, palm, size, open: clamp01((reach / 4 - 1.1) / 0.75) };
  });
  // match to previous hands by nearest palm so velocities make sense
  const next = [];
  for (const f of fresh) {
    let best = null, bd = Infinity;
    for (const h of hands) {
      if (next.includes(h)) continue;
      const d = Math.hypot(h.palm.x - f.palm.x, h.palm.y - f.palm.y);
      if (d < bd) { bd = d; best = h; }
    }
    if (best && bd < 260 * U) {
      const dt = Math.max((now - best.t) / 1000, 1 / 120);
      best.vx = (f.raw[8].x - best.raw[8].x) / dt;
      best.vy = (f.raw[8].y - best.raw[8].y) / dt;
      Object.assign(best, f, { t: now });
      next.push(best);
    } else {
      next.push({ id: nextId++, ...f, pts: f.raw.map((p) => ({ ...p })), vx: 0, vy: 0, t: now, armed: true, lastHit: 0 });
    }
  }
  hands = next;
  return true;
}

function smoothDrawPoints(dt) {
  const k = 1 - Math.exp(-dt / 0.035);
  for (const h of hands) for (let i = 0; i < 21; i++) {
    h.pts[i].x += (h.raw[i].x - h.pts[i].x) * k;
    h.pts[i].y += (h.raw[i].y - h.pts[i].y) * k;
  }
}

const CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
function drawSkeletons(color = 'rgba(255,250,240,0.9)') {
  if (!showSkeleton) return;
  for (const h of hands) {
    ctx.lineWidth = 3 * U;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of CONN) { ctx.moveTo(h.pts[a].x, h.pts[a].y); ctx.lineTo(h.pts[b].x, h.pts[b].y); }
    ctx.stroke();
    ctx.fillStyle = '#fffaf0';
    for (const p of h.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5 * U, 0, Math.PI * 2); ctx.fill(); }
  }
}

// ======================================================================
// Instruments: update + draw
// ======================================================================
const H_STATE = { air: 0, ext: null, noteIdx: 3, label: '', pulse: 0 };

function playHarmonium(dt, now, fresh) {
  const twoHands = hands.length >= 2;
  let air = 0;
  if (twoHands) {
    const [a, b] = [...hands].sort((p, q) => p.palm.x - q.palm.x);
    const ext = Math.hypot(b.palm.x - a.palm.x, b.palm.y - a.palm.y);
    if (fresh) {
      if (H_STATE.ext != null) {
        const dts = Math.max((now - (H_STATE.extT || now)) / 1000, 1 / 120);
        const speed = Math.abs(ext - H_STATE.ext) / dts / W; // screen widths per second
        H_STATE.pump = clamp01(speed / 0.55);
      }
      H_STATE.ext = ext;
      H_STATE.extT = now;
    }
    // pitch: the height of your hands picks a note (top = high)
    const midY = (a.palm.y + b.palm.y) / 2;
    const band = Math.floor(clamp01(1 - (midY - H * 0.08) / (H * 0.84)) * SCALE.length);
    const idx = Math.max(0, Math.min(SCALE.length - 1, band));
    if (idx !== H_STATE.noteIdx) { H_STATE.noteIdx = idx; harmonium.setNote(idx); }
    air = H_STATE.pump || 0;
    H_STATE.a = a; H_STATE.b = b;
  } else {
    H_STATE.ext = null;
    H_STATE.pump = 0;
  }
  if (!fresh) H_STATE.pump = (H_STATE.pump || 0) * Math.exp(-dt / 0.25);
  // the bellows hold a little air, so notes sustain briefly after you stop
  H_STATE.air += (air - H_STATE.air) * (1 - Math.exp(-dt / (air > H_STATE.air ? 0.05 : 0.45)));
  harmonium.setAir(H_STATE.air, twoHands);
  hint.textContent = twoHands
    ? (H_STATE.air < 0.08 ? 'Pump the bellows: move your hands apart and together. Raise or lower them to change the note.' : '')
    : 'Hold up both hands, palms facing each other, as if holding a harmonium.';
}

function drawHarmonium(now) {
  // note bands down the right edge
  const bandH = (H * 0.84) / SCALE.length;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SCALE.length; i++) {
    const y = H * 0.08 + (SCALE.length - 1 - i) * bandH + bandH / 2;
    const active = i === H_STATE.noteIdx && hands.length >= 2;
    ctx.globalAlpha = active ? 1 : 0.55;
    ctx.fillStyle = active ? 'rgba(246,205,110,0.95)' : 'rgba(250,247,240,0.55)';
    const w = active ? 120 * U : 74 * U;
    ctx.beginPath();
    ctx.roundRect(W - w - 12, y - bandH * 0.38, w, bandH * 0.76, 10 * U);
    ctx.fill();
    ctx.fillStyle = '#2f3b33';
    ctx.font = `${active ? 500 : 400} ${Math.round(20 * U * 1.1)}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillText(SARGAM[i], W - 24, y);
    // faint guide line so you can see where each note lives
    ctx.strokeStyle = 'rgba(255,250,240,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + bandH / 2); ctx.lineTo(W - w - 20, y + bandH / 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (hands.length < 2 || !H_STATE.a) return;
  const a = H_STATE.a, b = H_STATE.b;
  const ax = a.palm.x, ay = a.palm.y, bx = b.palm.x, by = b.palm.y;
  const len = Math.hypot(bx - ax, by - ay);
  const ang = Math.atan2(by - ay, bx - ax);
  const hgt = Math.max(a.size, b.size) * 2.4;
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(ang);
  const board = Math.min(36 * U, len * 0.15);
  // pleated bellows
  const folds = 12;
  const inner = len - board * 2;
  const breathe = 1 + H_STATE.air * 0.04 * Math.sin(now / 60);
  ctx.globalAlpha = 0.92;
  for (let i = 0; i < folds; i++) {
    const x0 = board + (inner * i) / folds, x1 = board + (inner * (i + 1)) / folds;
    const pinch = 0.86;
    ctx.fillStyle = i % 2 ? '#7a2b33' : '#943a42';
    ctx.beginPath();
    ctx.moveTo(x0, -hgt / 2 * breathe);
    ctx.lineTo((x0 + x1) / 2, -hgt / 2 * pinch * breathe);
    ctx.lineTo(x1, -hgt / 2 * breathe);
    ctx.lineTo(x1, hgt / 2 * breathe);
    ctx.lineTo((x0 + x1) / 2, hgt / 2 * pinch * breathe);
    ctx.lineTo(x0, hgt / 2 * breathe);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,196,120,0.75)';
    ctx.lineWidth = 1.5 * U;
    ctx.beginPath();
    ctx.moveTo((x0 + x1) / 2, -hgt / 2 * pinch * breathe);
    ctx.lineTo((x0 + x1) / 2, hgt / 2 * pinch * breathe);
    ctx.stroke();
  }
  // wooden end boards held in each hand
  for (const x of [0, len - board]) {
    const grd = ctx.createLinearGradient(x, 0, x + board, 0);
    grd.addColorStop(0, '#6b4a33');
    grd.addColorStop(0.5, '#9a6b47');
    grd.addColorStop(1, '#5c3e2b');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.roundRect(x, -hgt / 2 - 6 * U, board, hgt + 12 * U, 6 * U);
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,196,120,0.9)';
    ctx.lineWidth = 2 * U;
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  // a glowing note name floating above
  if (H_STATE.air > 0.08) {
    ctx.textAlign = 'center';
    ctx.font = `italic 500 ${Math.round(40 * U)}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillStyle = `rgba(255,240,200,${0.4 + H_STATE.air * 0.6})`;
    ctx.fillText(SARGAM[H_STATE.noteIdx], (ax + bx) / 2, Math.max(100 * U, Math.min(ay, by) - hgt * 0.75));
  }
}

// ---------- air drums ----------
const PADS = [
  { kind: 'hihat', label: 'Hi-hat', x: 0.17, y: 0.44, r: 0.12, col: '246,214,140' },
  { kind: 'snare', label: 'Snare', x: 0.33, y: 0.7, r: 0.13, col: '239,199,204' },
  { kind: 'kick', label: 'Kick', x: 0.5, y: 0.84, r: 0.13, col: '195,184,227' },
  { kind: 'tom', label: 'Tom', x: 0.67, y: 0.7, r: 0.12, col: '157,179,154' },
  { kind: 'crash', label: 'Crash', x: 0.83, y: 0.42, r: 0.13, col: '247,236,196' },
];
for (const p of PADS) p.flash = 0;
const padPos = (p) => ({ x: p.x * W, y: p.y * H, r: p.r * Math.min(W, H) * 1.05 });

function playDrums(dt, now, fresh) {
  for (const p of PADS) p.flash = Math.max(0, p.flash - dt * 3.5);
  hint.textContent = hands.length ? '' : 'Raise a hand and strike down through a pad with your fingertips.';
  if (!fresh) return;
  const thresh = 700 * U; // px/s downward
  for (const h of hands) {
    const tip = h.raw[8];
    // re-arm once the hand lifts or slows down
    if (h.vy < 120 * U) h.armed = true;
    if (!h.armed || h.vy < thresh || now - h.lastHit < 110) continue;
    for (const p of PADS) {
      const P = padPos(p);
      if (Math.hypot(tip.x - P.x, (tip.y - P.y) * 1.25) < P.r * 1.1) {
        const vel = clamp01((h.vy - thresh) / (2400 * U));
        drum(p.kind, vel);
        p.flash = 0.6 + vel * 0.4;
        p.hitAt = now;
        h.armed = false;
        h.lastHit = now;
        break;
      }
    }
  }
}

function drawDrums(now) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of PADS) {
    const P = padPos(p);
    const f = p.flash;
    const ry = P.r * 0.8;
    ctx.save();
    ctx.translate(P.x, P.y);
    ctx.fillStyle = `rgba(${p.col},${0.28 + f * 0.5})`;
    ctx.strokeStyle = `rgba(255,250,240,${0.7 + f * 0.3})`;
    ctx.lineWidth = (2 + f * 4) * U;
    ctx.beginPath();
    ctx.ellipse(0, 0, P.r * (1 + f * 0.06), ry * (1 + f * 0.06), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // ripple ring on hit
    if (p.hitAt && now - p.hitAt < 500) {
      const k = (now - p.hitAt) / 500;
      ctx.strokeStyle = `rgba(255,250,240,${(1 - k) * 0.8})`;
      ctx.lineWidth = 3 * U;
      ctx.beginPath();
      ctx.ellipse(0, 0, P.r * (1 + k * 0.5), ry * (1 + k * 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40,48,42,0.85)';
    ctx.font = `500 ${Math.round(22 * U * 1.1)}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillText(p.label, 0, 0);
    ctx.restore();
  }
  // drumstick glow on each index fingertip
  for (const h of hands) {
    const t = h.pts[8];
    const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, 26 * U);
    g.addColorStop(0, h.armed ? 'rgba(255,240,200,0.95)' : 'rgba(255,240,200,0.5)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 26 * U, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- theremin ----------
const T_STATE = { freq: 440, vol: 0, trail: [] };
const T_LOW = 48, T_HIGH = 84; // C3..C6
function playTheremin(dt, now) {
  let pitchHand = null, volHand = null;
  if (hands.length >= 2) {
    const s = [...hands].sort((p, q) => p.palm.x - q.palm.x);
    volHand = s[0];
    pitchHand = s[1];
  } else if (hands.length === 1) pitchHand = hands[0];
  let vol = 0;
  if (pitchHand) {
    const k = clamp01(1 - (pitchHand.pts[8].y - H * 0.12) / (H * 0.74));
    const m = lerp(T_LOW, T_HIGH, k);
    T_STATE.freq = mtof(m);
    T_STATE.midi = m;
    vol = volHand ? clamp01(1 - (volHand.palm.y - H * 0.15) / (H * 0.7)) : 0.25 + pitchHand.open * 0.6;
  }
  T_STATE.vol += (vol - T_STATE.vol) * (1 - Math.exp(-dt / 0.06));
  theremin.set(T_STATE.freq, T_STATE.vol);
  if (pitchHand) {
    T_STATE.trail.push({ x: pitchHand.pts[8].x, y: pitchHand.pts[8].y, t: now, v: T_STATE.vol });
  }
  T_STATE.trail = T_STATE.trail.filter((p) => now - p.t < 1200);
  hint.textContent = !hands.length
    ? 'Raise your right hand to play: higher is higher pitch. Your left hand sets the volume (higher is louder).'
    : hands.length === 1 ? 'Add your left hand to control volume, or open and close this hand.' : '';
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function drawTheremin(now) {
  // pitch scale on the right, volume scale on the left
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(15 * U * 1.1)}px Inter, sans-serif`;
  for (let m = T_LOW; m <= T_HIGH; m++) {
    if ([1, 3, 6, 8, 10].includes(m % 12)) continue;
    const y = H * 0.12 + (1 - (m - T_LOW) / (T_HIGH - T_LOW)) * H * 0.74;
    ctx.strokeStyle = m % 12 === 0 ? 'rgba(255,250,240,0.4)' : 'rgba(255,250,240,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W * 0.55, y); ctx.lineTo(W - 46, y); ctx.stroke();
    if (m % 12 === 0) {
      ctx.fillStyle = 'rgba(255,250,240,0.8)';
      ctx.textAlign = 'right';
      ctx.fillText('C' + (m / 12 - 1), W - 14, y);
    }
  }
  // glowing trail of the pitch hand
  for (let i = 1; i < T_STATE.trail.length; i++) {
    const p0 = T_STATE.trail[i - 1], p1 = T_STATE.trail[i];
    const age = (now - p1.t) / 1200;
    ctx.strokeStyle = `rgba(195,184,227,${(1 - age) * (0.25 + p1.v * 0.75)})`;
    ctx.lineWidth = (2 + p1.v * 10) * U * (1 - age);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
  }
  if (hands.length && T_STATE.midi) {
    const m = Math.round(T_STATE.midi);
    ctx.textAlign = 'center';
    ctx.font = `italic 500 ${Math.round(46 * U)}px "Cormorant Garamond", Georgia, serif`;
    ctx.fillStyle = `rgba(255,245,225,${0.35 + T_STATE.vol * 0.65})`;
    ctx.fillText(NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1), W / 2, H * 0.16);
  }
  // volume meter on the left
  const mh = H * 0.5;
  ctx.fillStyle = 'rgba(250,247,240,0.35)';
  ctx.beginPath(); ctx.roundRect(18, H * 0.25, 10 * U, mh, 6); ctx.fill();
  ctx.fillStyle = 'rgba(246,205,110,0.95)';
  ctx.beginPath(); ctx.roundRect(18, H * 0.25 + mh * (1 - T_STATE.vol), 10 * U, mh * T_STATE.vol, 6); ctx.fill();
}

// ======================================================================
// Loop, UI
// ======================================================================
function setStatus(st, text) {
  statusEl.dataset.state = st;
  statusText.textContent = text;
}

function selectInstrument(name) {
  instrument = name;
  for (const b of document.querySelectorAll('.picker button')) b.setAttribute('aria-selected', String(b.dataset.inst === name));
  // silence the others
  harmonium.setAir(0, false);
  H_STATE.air = 0;
  theremin.set(T_STATE.freq, 0);
  T_STATE.vol = 0;
  try { localStorage.setItem('studio-inst', name); } catch {}
}
for (const b of document.querySelectorAll('.picker button')) b.addEventListener('click', () => { initAudio(); selectInstrument(b.dataset.inst); });
window.addEventListener('keydown', (e) => {
  const map = { 1: 'harmonium', 2: 'drums', 3: 'theremin' };
  if (map[e.key]) selectInstrument(map[e.key]);
});
try { const saved = localStorage.getItem('studio-inst'); if (saved) selectInstrument(saved); } catch {}

btnSkeleton.addEventListener('click', () => {
  showSkeleton = !showSkeleton;
  btnSkeleton.setAttribute('aria-pressed', String(showSkeleton));
  btnSkeleton.title = showSkeleton ? 'Hide hand outlines' : 'Show hand outlines';
});

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
      return 'The studio could not start the camera. ' + (err?.message || '');
  }
}

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Tuning up…';
  initAudio(); // must happen inside the click so the browser allows sound
  note.classList.remove('error');
  try {
    tracker ||= new Tracker(video, { face: false });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    selectInstrument(instrument);
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Hand tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (tracker) tracker.update(now, dt);
  const fresh = updateHands(now);
  smoothDrawPoints(dt);
  if (tracker?.running) setStatus(hands.length ? 'active' : 'searching', hands.length ? `${hands.length} hand${hands.length > 1 ? 's' : ''} tracked` : 'show me your hands');

  if (A.ctx && tracker?.running) {
    if (instrument === 'harmonium') playHarmonium(dt, now, fresh);
    else if (instrument === 'drums') playDrums(dt, now, fresh);
    else playTheremin(dt, now);
  }

  ctx.clearRect(0, 0, W, H);
  if (!tracker?.running) return;
  if (instrument === 'harmonium') drawHarmonium(now);
  else if (instrument === 'drums') drawDrums(now);
  else drawTheremin(now);
  drawSkeletons(instrument === 'drums' ? 'rgba(255,240,200,0.85)' : 'rgba(255,250,240,0.85)');
}
requestAnimationFrame(frame);

// testing hook
window.studio = { get hands() { return hands; }, set hands(v) { hands = v; }, drum, harmonium, theremin, H_STATE, T_STATE, PADS, selectInstrument, setFakeHands(v) { fakeHands = v; } };
