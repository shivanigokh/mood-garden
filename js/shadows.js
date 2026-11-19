// SHADOWS: hand shadow puppets that come alive.
// Make an animal shape with your hands and hold it; the animal jumps off your hand onto
// the wall and plays with you: it follows your hand, sniffs it, jumps for it, enjoys a
// stroke, swats, snaps, rears up or perches, and startles at a fast swipe.
// Hand tracking: MediaPipe Hand Landmarker, on-device. Sound: Web Audio.

import { Tracker } from './tracking.js?v=8';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, toScreen, Sfx, setupToggle } from './shared.js?v=8';
import { DRAW, SIZE, NAMES, FLIERS, restPose, tube } from './puppets.js?v=8';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('wall');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const hint = $('hint');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const mirror = $('mirror');
const guide = $('guide');

// shadows are drawn on their own layer, then laid on the wall softly blurred
const sh = document.createElement('canvas');
const sx = sh.getContext('2d');
const gcv = document.createElement('canvas'); // ghost of an animal taking shape
const gx = gcv.getContext('2d');
const bg = document.createElement('canvas');
const bx = bg.getContext('2d');
const SH_SCALE = 0.75;
const SHADOW = '#2a211c';
const LIGHT = '255,238,206';
const CAN_FILTER = 'filter' in ctx;

let W = 0, H = 0, DPR = 1, U = 1, GY = 0;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  U = Math.min(W, H) / 800;
  GY = H * 0.86;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const [cv, cx] of [[sh, sx], [gcv, gx]]) {
    cv.width = Math.round(W * SH_SCALE * DPR);
    cv.height = Math.round(H * SH_SCALE * DPR);
    cx.setTransform(SH_SCALE * DPR, 0, 0, SH_SCALE * DPR, 0, 0);
  }
  paintWall();
}

function paintWall() {
  bg.width = Math.round(W * DPR);
  bg.height = Math.round(H * DPR);
  bx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = bx.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.75);
  g.addColorStop(0, '#fbf1dc');
  g.addColorStop(0.35, '#f1dfbd');
  g.addColorStop(0.7, '#c9a982');
  g.addColorStop(1, '#6f5a45');
  bx.fillStyle = g;
  bx.fillRect(0, 0, W, H);
  const f = bx.createLinearGradient(0, GY, 0, H);
  f.addColorStop(0, 'rgba(120,92,64,0.28)');
  f.addColorStop(1, 'rgba(70,52,38,0.55)');
  bx.fillStyle = f;
  bx.fillRect(0, GY, W, H - GY);
  bx.strokeStyle = 'rgba(90,68,48,0.35)';
  bx.lineWidth = 1.5;
  bx.beginPath(); bx.moveTo(0, GY + 0.5); bx.lineTo(W, GY + 0.5); bx.stroke();
  const n = Math.round((W * H) / 900);
  for (let i = 0; i < n; i++) {
    bx.fillStyle = Math.random() < 0.5 ? 'rgba(90,70,50,0.05)' : 'rgba(255,250,240,0.06)';
    bx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
  }
}
window.addEventListener('resize', resize);
resize();

const sfx = new Sfx();
let tracker = null;

// ======================================================================
// Hands: landmarks are filtered and gently predicted between detections, so the
// shadow glides at the display frame rate instead of stepping at the model's rate.
// ======================================================================
let hands = [];
let nextHandId = 1;
let lastHandsRef = null;
let fakeHands = null; // test hook

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function describe(raw) {
  const size = d2(raw[0], raw[9]) || 1;
  const ext = (tip, pip) => d2(raw[0], raw[tip]) > d2(raw[0], raw[pip]) * 1.12;
  const fold = (tip, pip) => d2(raw[0], raw[tip]) < d2(raw[0], raw[pip]) * 1.05;
  const f = {
    I: ext(8, 6), M: ext(12, 10), R: ext(16, 14), P: ext(20, 18),
    fI: fold(8, 6), fM: fold(12, 10), fR: fold(16, 14), fP: fold(20, 18),
  };
  f.thumbOut = d2(raw[4], raw[5]) > size * 0.7 && d2(raw[4], raw[9]) > size * 0.85;
  f.ok = d2(raw[4], raw[8]) < size * 0.35;
  f.count = f.I + f.M + f.R + f.P;
  let pose = null;
  if (f.ok && f.M && f.R && f.P) pose = 'swan';
  else if (f.I && f.M && f.R && f.fP) pose = 'deer';
  else if (f.I && f.M && f.fR && f.fP) pose = 'rabbit';
  else if (f.I && f.P && f.fM && f.fR) pose = 'dog';
  else if (f.thumbOut && f.P && f.fI && f.fM && f.fR) pose = 'cat';
  else if (f.I && f.fM && f.fR && f.fP && !f.ok) pose = 'snake';
  else if (f.thumbOut && f.fI && f.fM && f.fR && f.fP) pose = 'elephant';
  return { raw, f, pose, open: clamp01((f.count - 1) / 3) };
}

function measure(h) {
  const p = h.pts;
  h.size = d2(p[0], p[9]) || 1;
  h.palm = { x: (p[0].x + p[5].x + p[9].x + p[13].x + p[17].x) / 5, y: (p[0].y + p[5].y + p[9].y + p[13].y + p[17].y) / 5 };
  let top = p[0];
  for (const q of p) if (q.y < top.y) top = q;
  h.top = top;
}

function updateHands(now, dt) {
  const list = fakeHands || tracker?.lastHands;
  if (!tracker?.running && !fakeHands) { hands = []; return; }
  if (list !== lastHandsRef) {
    lastHandsRef = list;
    const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    const fresh = (list || []).map((lm) => describe(lm.map((p) => toScreen(p, vw, vh, W, H))));
    const next = [];
    for (const f of fresh) {
      const fp = { x: (f.raw[0].x + f.raw[9].x) / 2, y: (f.raw[0].y + f.raw[9].y) / 2 };
      let best = null, bd = Infinity;
      for (const h of hands) {
        if (next.includes(h)) continue;
        const d = Math.hypot(h.palm.x - fp.x, h.palm.y - fp.y);
        if (d < bd) { bd = d; best = h; }
      }
      if (best && bd < 320 * U) {
        const fdt = Math.max((now - best.t) / 1000, 1 / 120);
        for (let i = 0; i < 21; i++) {
          const vx = (f.raw[i].x - best.raw[i].x) / fdt, vy = (f.raw[i].y - best.raw[i].y) / fdt;
          best.vel[i].x += (vx - best.vel[i].x) * 0.5;
          best.vel[i].y += (vy - best.vel[i].y) * 0.5;
        }
        Object.assign(best, f, { t: now });
        next.push(best);
      } else {
        const h = { id: nextHandId++, ...f, pts: f.raw.map((p) => ({ ...p })), vel: f.raw.map(() => ({ x: 0, y: 0 })), vx: 0, vy: 0, t: now, born: now, poseName: null, poseAt: now, spent: false };
        measure(h);
        next.push(h);
      }
    }
    hands = next;
  } else if (!fakeHands) {
    hands = hands.filter((h) => now - h.t < 500);
  }
  for (const h of hands) {
    const ahead = Math.min((now - h.t) / 1000, 0.07); // predict a little, never far
    const before = { x: h.palm?.x ?? 0, y: h.palm?.y ?? 0 };
    const sp = Math.hypot(h.vx, h.vy) / (1000 * U);
    const k = ease(dt, lerp(0.05, 0.018, clamp01(sp))); // one-euro style: steadier when still, snappier when moving
    for (let i = 0; i < 21; i++) {
      const tx = h.raw[i].x + h.vel[i].x * ahead, ty = h.raw[i].y + h.vel[i].y * ahead;
      h.pts[i].x += (tx - h.pts[i].x) * k;
      h.pts[i].y += (ty - h.pts[i].y) * k;
    }
    measure(h);
    if (dt > 0) {
      h.vx += ((h.palm.x - before.x) / dt - h.vx) * ease(dt, 0.08);
      h.vy += ((h.palm.y - before.y) / dt - h.vy) * ease(dt, 0.08);
    }
    h.speed = Math.hypot(h.vx, h.vy);
    h.age = (now - h.born) / 1000;
  }
}

function drawHandShadow(c, h) {
  const p = h.pts, s = h.size;
  c.fillStyle = SHADOW;
  const P = (i) => [p[i].x, p[i].y];
  // forearm, widening as it reaches back from the wrist
  const ax = p[0].x - p[9].x, ay = p[0].y - p[9].y;
  const al = Math.hypot(ax, ay) || 1;
  tube(c, [P(0), [p[0].x + (ax / al) * s * 1.4, p[0].y + (ay / al) * s * 1.4], [p[0].x + (ax / al) * s * 3.2, p[0].y + (ay / al) * s * 3.2]], [s * 0.36, s * 0.44, s * 0.5]);
  // palm: a smooth closed curve through the knuckles and wrist
  const ring = [0, 1, 2, 5, 9, 13, 17].map((i) => p[i]);
  c.beginPath();
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (i === 0) c.moveTo(mx, my); else c.quadraticCurveTo(a.x, a.y, mx, my);
  }
  const a0 = ring[0], b0 = ring[1];
  c.quadraticCurveTo(a0.x, a0.y, (a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
  c.fill();
  tube(c, [P(0), P(9)], [s * 0.42, s * 0.4]);
  tube(c, [P(5), P(9), P(13), P(17)], [s * 0.16, s * 0.17, s * 0.16, s * 0.14]);
  // fingers taper to soft tips
  tube(c, [P(1), P(2), P(3), P(4)], [s * 0.2, s * 0.15, s * 0.125, s * 0.105]);
  for (const b of [5, 9, 13, 17]) {
    const k = b === 17 ? 0.85 : 1;
    tube(c, [P(b), P(b + 1), P(b + 2), P(b + 3)], [s * 0.135 * k, s * 0.12 * k, s * 0.105 * k, s * 0.09 * k]);
  }
}

// ======================================================================
// Sounds
// ======================================================================
const tone = (o) => sfx.tone(o);
const SOUND = {
  dog: { voice() { const p = 1 + (Math.random() - 0.5) * 0.15; tone({ type: 'sawtooth', freqs: [[0, 560 * p], [0.05, 640 * p], [0.14, 300 * p]], dur: 0.16, gain: 0.22, filter: 1100, q: 1.2 }); sfx.hiss({ dur: 0.1, gain: 0.08, freq: 1500 }); if (Math.random() < 0.5) tone({ type: 'sawtooth', freqs: [[0, 600], [0.04, 660], [0.12, 320]], dur: 0.14, gain: 0.18, filter: 1100, q: 1.2, delay: 0.19 }); }, happy() { tone({ type: 'triangle', freqs: [[0, 900], [0.15, 1300], [0.35, 1000]], dur: 0.4, gain: 0.07 }); }, word: 'woof' },
  rabbit: { voice() { tone({ type: 'sine', freqs: [[0, 1800], [0.06, 2600]], dur: 0.08, gain: 0.06 }); }, happy() { tone({ type: 'sine', freqs: [[0, 1500], [0.08, 2100]], dur: 0.12, gain: 0.06 }); }, word: 'squeak' },
  cat: { voice() { tone({ type: 'sawtooth', freqs: [[0, 480], [0.18, 820], [0.5, 520]], dur: 0.55, gain: 0.12, filter: 1300, q: 2.5 }); }, happy() { sfx.hiss({ dur: 1.1, gain: 0.18, type: 'lowpass', freq: 220, am: 24 }); }, word: 'meow' },
  deer: { voice() { tone({ type: 'triangle', freqs: [[0, 700], [0.15, 900], [0.4, 650]], dur: 0.45, gain: 0.08, filter: 1200, q: 2 }); }, happy() { tone({ type: 'sine', freqs: [[0, 900], [0.2, 1200]], dur: 0.25, gain: 0.06 }); }, word: 'mew' },
  elephant: { voice() { tone({ type: 'sawtooth', freqs: [[0, 330], [0.15, 520], [0.6, 480], [0.9, 360]], dur: 1.0, gain: 0.16, filter: 900, q: 3 }); tone({ type: 'square', freqs: [[0, 335], [0.15, 525], [0.6, 470]], dur: 0.8, gain: 0.04, filter: 1400, q: 4 }); }, happy() { sfx.hiss({ dur: 0.7, gain: 0.08, type: 'lowpass', freq: 160, am: 9 }); }, word: 'toot!' },
  snake: { voice() { sfx.hiss({ dur: 0.9, gain: 0.12, type: 'highpass', freq: 3500 }); }, happy() { sfx.hiss({ dur: 0.4, gain: 0.05, type: 'highpass', freq: 4500 }); }, word: 'sss' },
  croc: { voice() { sfx.hiss({ dur: 0.05, gain: 0.25, type: 'bandpass', freq: 1800, q: 1 }); tone({ type: 'sine', freqs: [[0, 160], [0.12, 60]], dur: 0.16, gain: 0.25 }); }, happy() { tone({ type: 'sawtooth', freqs: [[0, 90], [0.4, 80]], dur: 0.5, gain: 0.06, filter: 300, q: 2 }); }, word: 'chomp' },
  swan: { voice() { tone({ type: 'sawtooth', freqs: [[0, 420], [0.1, 470], [0.25, 380]], dur: 0.28, gain: 0.1, filter: 1300, q: 4 }); }, happy() { tone({ type: 'sine', freqs: [[0, 600], [0.15, 750]], dur: 0.2, gain: 0.05 }); }, word: 'honk' },
  bird: { voice() { for (let i = 0; i < 2 + (Math.random() * 2 | 0); i++) tone({ type: 'sine', freqs: [[0, 2600], [0.04, 3600], [0.09, 2900]], dur: 0.1, gain: 0.07, delay: i * 0.13 }); }, happy() { tone({ type: 'sine', freqs: [[0, 3000], [0.1, 4200], [0.2, 3200]], dur: 0.22, gain: 0.06 }); }, word: 'tweet' },
  butterfly: { voice() { [0, 0.07, 0.14].forEach((d, i) => tone({ type: 'sine', freqs: [[0, 2093 + i * 500]], dur: 0.3, gain: 0.03, delay: d })); }, happy() { tone({ type: 'sine', freqs: [[0, 2637]], dur: 0.4, gain: 0.03 }); }, word: '' },
};
function popSound() { tone({ type: 'sine', freqs: [[0, 260], [0.12, 880]], dur: 0.2, gain: 0.15 }); sfx.hiss({ dur: 0.2, gain: 0.05, freq: 3000 }); }
function sniffSound() { for (let i = 0; i < 3; i++) sfx.hiss({ dur: 0.06, gain: 0.06, type: 'highpass', freq: 2500, delay: i * 0.09 }); }

// ======================================================================
// Particles (drawn as light, not shadow)
// ======================================================================
let parts = [];
function emit(type, x, y, o = {}) { parts.push({ type, x, y, vx: o.vx ?? (Math.random() - 0.5) * 40, vy: o.vy ?? -60, g: o.g ?? 0, life: 0, max: o.max ?? 1.2, text: o.text, size: o.size ?? 1 }); }
function drawParticles(dt) {
  parts = parts.filter((p) => (p.life += dt) < p.max);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of parts) {
    p.vy += p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const k = p.life / p.max;
    const a = (1 - k) * Math.min(1, p.life * 6);
    ctx.save();
    ctx.shadowColor = `rgba(${LIGHT},${a})`;
    ctx.shadowBlur = 12;
    ctx.fillStyle = `rgba(${LIGHT},${a})`;
    if (p.type === 'heart') {
      ctx.translate(p.x, p.y);
      const z = p.size * U * (0.8 + k * 0.4);
      ctx.scale(z, z);
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.bezierCurveTo(-14, -4, -8, -16, 0, -8);
      ctx.bezierCurveTo(8, -16, 14, -4, 0, 6);
      ctx.fill();
    } else if (p.type === 'spark' || p.type === 'drop') {
      ctx.beginPath(); ctx.arc(p.x, p.y, (p.type === 'drop' ? 3.2 : 2.5) * U * p.size * (1 - k * 0.6), 0, Math.PI * 2); ctx.fill();
    } else if (p.type === 'puff') {
      ctx.fillStyle = `rgba(${LIGHT},${a * 0.5})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, (4 + k * 10) * U, 0, Math.PI * 2); ctx.fill();
    } else if (p.type === 'text') {
      ctx.font = `italic 500 ${Math.round(30 * U * p.size)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  }
}

// ======================================================================
// Animals
// ======================================================================
const G = () => 2600 * U;
let animals = [];
const MAX_ANIMALS = 6;
// speeds in body lengths per second; startle = hand speed (px/s at 800px) that scares it
const CFG = {
  dog: { walk: 1.1, run: 3.0, jump: true, gait: 'legs', startle: 2600, stride: 0.55 },
  cat: { walk: 0.8, run: 2.6, jump: true, gait: 'legs', startle: 2300, stride: 0.5 },
  deer: { walk: 0.9, run: 3.2, jump: true, gait: 'legs', startle: 1700, stride: 0.6 },
  elephant: { walk: 0.45, run: 0.9, jump: false, gait: 'legs', startle: 3400, stride: 0.45 },
  rabbit: { walk: 1.2, run: 3.0, jump: true, gait: 'hop', startle: 2000 },
  snake: { walk: 0.5, run: 1.3, jump: false, gait: 'slither', startle: 2600, stride: 0.35 },
  croc: { walk: 0.35, run: 1.0, jump: false, gait: 'crawl', startle: 3400, stride: 0.3 },
  swan: { walk: 0.5, run: 1.2, jump: false, gait: 'glide', startle: 2400 },
  bird: {}, butterfly: {},
};

function spawn(kind, x, y, from = null) {
  const s = SIZE[kind] * Math.min(W, H);
  const a = {
    ...restPose(), kind, x, y, s, vx: 0, vy: -s * 2.2, face: x < W / 2 ? 1 : -1, faceS: x < W / 2 ? 1 : -1,
    air: !FLIERS.has(kind), mode: FLIERS.has(kind) ? 'fly' : 'idle', pet: 0, startle: -1, fleeDir: 1, cool: 0.6, hopCool: 0,
    nextVoice: 1 + Math.random() * 2, nextThink: 0, wanderX: x, target: null, grow: 0, leaving: false, born: performance.now(),
    earV: 0, look: [0.6, -0.6], perchT: 0, groundT: 0, snapT: 0,
  };
  if (FLIERS.has(kind)) { a.vx = 0; a.vy = -s * 3; }
  if (from) {
    // walking in from the edge of the wall
    a.x = from < 0 ? -s : W + s;
    a.face = a.faceS = from < 0 ? 1 : -1;
    a.wanderX = W * (0.3 + Math.random() * 0.4);
    a.nextThink = performance.now() / 1000 + 3;
    a.grow = 1;
    if (FLIERS.has(kind)) { a.y = H * 0.3; a.vx = a.face * s * 3; } else { a.y = GY; a.air = false; a.vy = 0; }
  }
  animals.push(a);
  const alive = animals.filter((q) => !q.leaving);
  if (alive.length > MAX_ANIMALS) { alive[0].leaving = true; alive[0].fleeDir = alive[0].x < W / 2 ? -1 : 1; }
  if (!from) {
    for (let i = 0; i < 18; i++) emit('spark', x, y, { vx: (Math.random() - 0.5) * 420 * U, vy: (Math.random() - 0.9) * 360 * U, max: 0.8, size: 1 + Math.random() });
    popSound();
    emit('text', x, Math.max(96 * U, y - s * 0.9), { text: `a ${NAMES[kind]}!`, vx: 0, vy: -30, max: 1.6, size: 1.1 });
  }
  setTimeout(() => SOUND[kind].voice(), 220);
  return a;
}

function nearestHand(a) {
  let best = null, bd = Infinity;
  for (const h of hands) {
    const d = Math.abs(h.palm.x - a.x) + Math.abs(h.palm.y - (a.y - a.s * 0.5)) * 0.4;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

function voice(a, word = true) {
  SOUND[a.kind].voice();
  a.jaw = 1;
  const w = SOUND[a.kind].word;
  if (word && w) emit('text', a.x + a.face * a.s * 0.5, a.y - a.s * 1.05, { text: w, vx: a.face * 20, vy: -40, max: 1.1, size: 0.8 });
}

function startle(a, h) {
  a.startle = 1.2;
  a.fleeDir = Math.sign(a.x - h.palm.x) || 1;
  emit('text', a.x, a.y - a.s * 1.2, { text: '!', vx: 0, vy: -60, max: 0.9, size: 1.4 });
  if (FLIERS.has(a.kind)) { a.mode = 'fly'; a.vy = -a.s * 6; a.vx = a.fleeDir * a.s * 4; }
  else if (CFG[a.kind].jump && !a.air) { a.air = true; a.vy = -a.s * 2.5; }
  if (a.kind === 'swan') a.wingT = 1;
  voice(a, false);
}

function updateGround(a, dt, t) {
  const s = a.s, C = CFG[a.kind];
  a.cool -= dt; a.startle -= dt; a.hopCool -= dt; a.nextVoice -= dt; a.snapT -= dt;
  a.jaw = Math.max(0, a.jaw - dt * 4);
  const h = nearestHand(a);
  let want = 0, sitT = 0, headT = 0, earT = 0.5, crouchT = 0, reachT = 0, archT = 0, swatT = 0, earBackT = 0, sniffT = 0;
  let alertT = 0, trunkT = 0, tongueT = 0, wingT = a.wingT || 0, jawT = 0, tailDownT = 0;
  let petting = false;
  const run = s * C.run, walk = s * C.walk;
  let lookTarget = null;

  if (a.leaving) {
    want = a.fleeDir * run;
    a.face = a.fleeDir;
  } else if (a.startle > 0) {
    want = a.fleeDir * run * 1.2;
    a.face = a.fleeDir;
    earT = 1; earBackT = 1; alertT = 1; tailDownT = a.kind === 'dog' ? 1 : 0; wingT = 1;
    if (a.kind === 'snake') { reachT = 1; tongueT = 1; lookTarget = [0.5, -0.5]; }
    if (a.kind === 'croc') jawT = 1;
  } else if (h) {
    if (h.speed > C.startle * U && h.age > 0.4 && a.startle < -1 && Math.hypot(h.palm.x - a.x, h.palm.y - (a.y - s * 0.5)) < s * 2.2) startle(a, h);
    const dx = h.palm.x - a.x;
    const above = (GY - h.palm.y) / s; // hand height above the floor, in body lengths
    // stand so the head (not the body center) ends up under the hand
    const headOff = { dog: 0.5, cat: 0.42, deer: 0.5, elephant: 0.75, rabbit: 0.3, snake: 0.25, croc: 0.75, swan: 0.35 }[a.kind] * s;
    const shy = a.kind === 'deer' ? 0.6 * s : 0;
    // take turns: the closest animal comes right up, others queue on alternating sides
    const queue = animals.filter((o) => !FLIERS.has(o.kind) && !o.leaving && nearestHand(o) === h).sort((p, q) => Math.abs(p.x - h.palm.x) - Math.abs(q.x - h.palm.x));
    const rank = Math.max(0, queue.indexOf(a));
    const side = rank % 2 === 0 ? Math.sign(dx || 1) : -Math.sign(dx || 1);
    const back = Math.floor((rank + 1) / 2) * s * 0.95 + (rank ? s * 0.4 : 0);
    const goal = h.palm.x - side * (headOff + shy + back);
    const gdx = goal - a.x;
    lookTarget = [Math.abs(dx) / s, (h.palm.y - a.y) / s];
    if (Math.abs(gdx) > s * 0.18 && (Math.abs(dx) > headOff * 0.6 || rank > 0)) {
      want = Math.sign(gdx) * Math.min(Math.abs(dx) > s * 2 ? run : walk * 1.6, Math.abs(gdx) * 2.5);
      if (Math.abs(dx) > s * 0.1) a.face = Math.sign(dx);
      earT = 0.85; alertT = 0.6;
    } else if (rank > 0) {
      // waiting its turn: watch the hand
      if (Math.abs(dx) > s * 0.1) a.face = Math.sign(dx);
      earT = 1; alertT = 1; sitT = 0.6;
    } else {
      if (Math.abs(dx) > s * 0.1) a.face = Math.sign(dx);
      earT = 0.9; alertT = 1;
      const stroking = h.open > 0.5 && Math.abs(h.vx) > 70 * U && Math.abs(h.vx) < 2400 * U && h.palm.y > a.y - s * 1.7;
      if (above < 1.7) {
        // close and low
        reachT = 1; crouchT = 0.3; sniffT = 1;
        if (stroking) petting = true;
        if (a.kind === 'cat') { archT = 0.7; const tip = h.pts[8]; if (h.f.I && !stroking && Math.hypot(tip.x - (a.x + a.face * s * 0.45), tip.y - (a.y - s * 0.7)) < s * 0.8) swatT = 1; }
        if (a.kind === 'dog' && !petting && Math.random() < dt * 0.6) { sniffSound(); emit('puff', a.x + a.face * s * 0.75, a.y - s * 0.85, { vx: a.face * 30, vy: -20, max: 0.6 }); }
        if (a.kind === 'elephant' && Math.random() < dt * 0.4) { sniffSound(); }
        if (a.kind === 'snake') { tongueT = 1; }
        if (a.kind === 'croc') {
          jawT = 0.6 + Math.sin(t * 2) * 0.2;
          // a fast pass near the jaws gets snapped at
          if (h.speed > 600 * U && a.snapT <= 0 && Math.abs(dx) < s * 1.1) { a.snapT = 1.4; a.snap = 0.25; voice(a); }
        }
        if (a.kind === 'swan') { wingT = petting ? 0.5 : 0.1; }
      } else if (above < 4.6) {
        reachT = 1; earT = 1;
        if (C.jump && !a.air && a.cool <= 0) {
          const jumpH = Math.max(s * 0.5, GY - h.palm.y - s * (a.kind === 'rabbit' ? 0.4 : 0.8));
          a.vy = -Math.sqrt(2 * G() * Math.min(jumpH, s * (a.kind === 'deer' ? 3.5 : 2.6)));
          a.vx = clamp(dx * 2, -s * 2, s * 2);
          a.air = true;
          a.cool = 1.1 + Math.random() * 0.7;
          if (Math.random() < 0.55) voice(a);
        }
        if (a.kind === 'elephant') {
          trunkT = 1;
          if (a.nextVoice <= 0) { voice(a); a.nextVoice = 3 + Math.random() * 2; a.spray = 1.2; }
        }
        if (a.kind === 'snake') { tongueT = 1; }
        if (a.kind === 'croc') jawT = 1;
        if (a.kind === 'swan') wingT = 0.4 + Math.sin(t * 6) * 0.2;
      } else {
        sitT = 1; earT = 1; reachT = 0.6;
        if (a.kind === 'elephant') trunkT = 1;
        if (a.nextVoice <= 0) { voice(a); a.nextVoice = 2.5 + Math.random() * 2; }
      }
    }
  } else {
    // nobody around: wander, sit, sniff the floor
    if (t > a.nextThink) {
      const r = Math.random();
      a.wanderX = r < 0.55 ? clamp(a.x + (Math.random() - 0.5) * W * 0.5, s, W - s) : a.x;
      a.idleSit = r > 0.75;
      a.nextThink = t + 2.5 + Math.random() * 3.5;
    }
    const dx = a.wanderX - a.x;
    if (Math.abs(dx) > s * 0.1) { want = Math.sign(dx) * walk; a.face = Math.sign(dx); }
    else if (a.idleSit) sitT = 1;
    else { headT = 0.5; crouchT = 0.2; sniffT = 0.5; lookTarget = [0.9, 0]; }
    if (a.kind === 'elephant' && a.idleSit) trunkT = 0.5;
    if (a.nextVoice <= 0) { if (Math.random() < 0.35) voice(a); a.nextVoice = 4 + Math.random() * 5; }
  }

  if (a.kind === 'snake' && !a.leaving) { reachT = Math.max(reachT, 0.35); if (!lookTarget) lookTarget = [0.5, -0.32]; }
  // petting builds happiness
  if (petting) a.pet = Math.min(1.5, a.pet + dt * 2.2);
  else a.pet = Math.max(0, a.pet - dt * 0.8);
  a.happy += ((a.pet > 0.2 ? 1 : 0) - a.happy) * ease(dt, 0.4);
  if (a.pet > 0.25) {
    earBackT = a.kind === 'rabbit' ? 1 : 0.4;
    if (a.kind === 'dog') sitT = Math.max(sitT, 0.3);
    if (a.kind === 'snake') reachT = 0.5;
    if (Math.random() < dt * 4) emit('heart', a.x + (Math.random() - 0.3) * s * 0.6 * a.face, a.y - s * (0.9 + Math.random() * 0.3), { vx: (Math.random() - 0.5) * 40, vy: -70 * U, max: 1.4, size: 0.9 + Math.random() * 0.5 });
    if (a.nextVoice <= 0) { SOUND[a.kind].happy(); a.nextVoice = a.kind === 'cat' ? 1.1 : 1.6; }
  }

  // ----- motion -----
  if (a.air) {
    a.vy += G() * dt;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    if (a.y >= GY) {
      a.y = GY; a.air = false; a.vy = 0; a.vx *= 0.3;
      a.land = 1;
      for (let i = 0; i < 4; i++) emit('puff', a.x + (Math.random() - 0.5) * s * 0.6, GY - 4, { vx: (Math.random() - 0.5) * 60, vy: -15, max: 0.5 });
    }
  } else if (C.gait === 'hop') {
    if (Math.abs(want) > s * 0.2 && a.hopCool <= 0) {
      a.air = true;
      a.vy = -s * 3.4;
      a.vx = clamp(want * 1.3, -s * 4, s * 4);
      a.hopCool = 0.12;
      tone({ type: 'sine', freqs: [[0, 220], [0.1, 380]], dur: 0.1, gain: 0.03 });
    }
    a.vx *= Math.exp(-dt / 0.06);
    a.x += a.vx * dt;
  } else {
    const resp = C.gait === 'legs' ? 0.22 : 0.35;
    a.vx += (want - a.vx) * ease(dt, resp);
    a.x += a.vx * dt;
  }
  if (!a.leaving) a.x = clamp(a.x, s * 0.6, W - s * 0.6);

  const speed = Math.abs(a.vx);
  const moving = speed > s * 0.08 && !a.air;
  a.stride += ((moving ? clamp01(speed / (s * 1.2)) : 0) - a.stride) * ease(dt, 0.15);
  a.cycle = (a.cycle + (speed / s) * dt / (C.stride || 0.5)) % 1;
  if (moving || a.air) sitT = 0;
  // turning: flip through a narrow pose rather than snapping
  a.faceS += (a.face - a.faceS) * ease(dt, 0.09);
  const k = ease(dt, 0.14);
  a.sit += (sitT - a.sit) * ease(dt, 0.28);
  // where to look, in the animal's own unit space
  const lt = lookTarget || [0.9, -0.7];
  a.look[0] += (lt[0] - a.look[0]) * ease(dt, 0.12);
  a.look[1] += (lt[1] - a.look[1]) * ease(dt, 0.12);
  // head angle toward what it looks at (skull sits about here)
  const headPos = { dog: [0.5, -0.92], cat: [0.4, -0.7], deer: [0.47, -1.3], elephant: [0.45, -0.86], rabbit: [0.26, -0.47] }[a.kind] || [0.4, -0.5];
  const hang = Math.atan2(a.look[1] - headPos[1], Math.max(0.15, a.look[0] - headPos[0]));
  headT = lookTarget ? clamp(hang, -1.0, 0.9) * (a.kind === 'elephant' ? 0.4 : 1) : headT;
  a.head += ((a.air ? -0.35 : headT) - a.head) * k;
  a.ear += (earT - a.ear) * k;
  a.earBack += (earBackT - a.earBack) * k;
  a.crouch += (crouchT - a.crouch) * k;
  a.reach += (reachT - a.reach) * ease(dt, 0.2);
  a.arch += (archT - a.arch) * ease(dt, 0.3);
  a.swat += (swatT * (0.6 + 0.4 * Math.sin(t * 14)) - a.swat) * ease(dt, 0.05);
  a.sniff += (sniffT - a.sniff) * k;
  a.alert += (alertT - a.alert) * k;
  a.trunkUp += (trunkT - a.trunkUp) * ease(dt, 0.3);
  a.tongue = tongueT > 0 ? Math.max(0, Math.sin(t * 9)) * (Math.sin(t * 1.7) > 0 ? 1 : 0) : Math.max(0, a.tongue - dt * 5);
  a.wing += (wingT - a.wing) * ease(dt, 0.12);
  a.wingT = Math.max(0, (a.wingT || 0) - dt);
  a.tailDown += (tailDownT - a.tailDown) * k;
  if (a.snap > 0) { a.snap -= dt; jawT = a.snap > 0.12 ? 1 : 0; }
  a.jawS = (a.jawS || 0) + (jawT - (a.jawS || 0)) * ease(dt, a.snap > 0 ? 0.02 : 0.12);
  if (a.kind === 'croc') a.jaw = a.jawS;
  a.airK += ((a.air ? 1 : 0) - a.airK) * ease(dt, 0.06);
  // ears swing with a lag (secondary motion)
  const accel = (a.vx - (a.lastVx ?? a.vx)) / Math.max(dt, 1e-3);
  a.lastVx = a.vx;
  a.earV += (-a.earSwing * 120 - a.earV * 9 - accel / s * 0.4 * a.face + (a.air ? a.vy / s * 0.6 : 0)) * dt;
  a.earSwing = clamp(a.earSwing + a.earV * dt, -1, 1);
  if (a.kind === 'elephant') a.earSwing = clamp(a.earSwing + Math.sin(t * (a.happy > 0.3 ? 9 : 2.2)) * 0.02, -1, 1);
  a.wag = 0.25 + a.happy * 0.5 + (h && !a.leaving ? 0.25 : 0);
  // elephant spray
  if (a.spray > 0) {
    a.spray -= dt;
    const tip = [a.x + a.face * s * (0.6 + 0.2), a.y - s * 1.45];
    for (let i = 0; i < 3; i++) emit('drop', tip[0], tip[1], { vx: a.face * (80 + Math.random() * 160) * U, vy: -(250 + Math.random() * 200) * U, g: 900 * U, max: 1.2, size: 0.7 + Math.random() * 0.6 });
  }
  return a.leaving && (a.x < -s * 2 || a.x > W + s * 2);
}

function perchPoint(h) {
  return { x: h.top.x, y: h.top.y - h.size * 0.08 };
}

function updateFlier(a, dt, t) {
  const s = a.s;
  const bfly = a.kind === 'butterfly';
  a.startle -= dt; a.nextVoice -= dt;
  a.beak = Math.max(0, a.beak - dt * 4);
  if (a.peck > 0) a.peck = Math.max(0, a.peck - dt * 3);
  const h = nearestHand(a);
  if (a.leaving) {
    a.mode = 'fly';
    a.vx += (a.fleeDir * s * 6 - a.vx) * ease(dt, 0.4);
    a.vy += (-s * 2 - a.vy) * ease(dt, 0.4);
  } else if (a.mode === 'perch') {
    if (!h || h.speed > 1300 * U) {
      a.mode = 'fly';
      if (h) startle(a, h); else a.vy = -s * 4;
    } else {
      const p = perchPoint(h);
      a.x += (p.x - a.x) * ease(dt, 0.03);
      a.y += (p.y - a.y) * ease(dt, 0.03);
      a.vx = a.vy = 0;
      a.perchT += dt;
      const other = hands.find((o) => o !== h && o.open > 0.5 && Math.hypot(o.palm.x - a.x, o.palm.y - a.y) < s * 3 && Math.abs(o.vx) > 60 * U);
      if (other) { a.pet = Math.min(1.5, a.pet + dt * 2.2); if (Math.random() < dt * 4) emit('heart', a.x, a.y - s * 0.5, { vy: -70 * U, max: 1.3 }); }
      else a.pet = Math.max(0, a.pet - dt);
      if (a.nextVoice <= 0) { SOUND[a.kind].voice(); a.beak = 1; a.nextVoice = 1.8 + Math.random() * 2.5; }
      if (!bfly && Math.random() < dt * 0.4) a.face *= -1;
      a.wingUp = Math.max(0, Math.sin(t * 3) - 0.6);
    }
  } else if (a.mode === 'ground') {
    a.groundT -= dt;
    a.vx = a.vy = 0;
    a.y = GY;
    if (!bfly && Math.random() < dt * 1.2) a.peck = 1;
    if (!bfly && Math.random() < dt * 0.5) a.x += a.face * s * 0.2;
    if (!bfly && Math.random() < dt * 0.3) a.face *= -1;
    if (h || a.groundT <= 0) { a.mode = 'fly'; a.vy = -s * 4; a.vx = a.face * s * 1.5; }
  }
  if (a.mode === 'fly') {
    let tx, ty, slow = false;
    if (a.leaving) { tx = a.x + a.fleeDir * 100; ty = a.y - 40; }
    else if (a.startle > 0) { tx = a.x + a.fleeDir * s * 4; ty = H * 0.2; }
    else if (h) {
      const p = perchPoint(h);
      tx = p.x; ty = p.y;
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      slow = true;
      if (d < s * 0.7 && h.speed < 450 * U && h.age > 0.5) {
        a.mode = 'perch';
        a.perchT = 0;
        a.face = Math.sign(W / 2 - a.x) || 1;
        a.nextVoice = 0.2;
      }
      if (d > s * 2.5) ty -= s * 0.8;
    } else {
      if (!a.target || t > a.nextThink) {
        if (Math.random() < 0.3) a.target = { x: clamp(a.x + (Math.random() - 0.5) * W * 0.4, s, W - s), y: GY, land: true };
        else a.target = { x: s + Math.random() * (W - 2 * s), y: H * (0.15 + Math.random() * 0.45) };
        a.nextThink = t + 3 + Math.random() * 3;
      }
      tx = a.target.x; ty = a.target.y;
      if (a.target.land && Math.hypot(tx - a.x, ty - a.y) < s * 0.3) { a.mode = 'ground'; a.groundT = 3 + Math.random() * 4; a.y = GY; a.target = null; }
    }
    if (bfly) { tx += Math.sin(t * 2.3 + a.born) * s * 0.8; ty += Math.cos(t * 3.1 + a.born) * s * 0.6; }
    const dx = tx - a.x, dy = ty - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = Math.min(s * (a.startle > 0 ? 9 : bfly ? 4 : 5), d * (slow ? 3 : 1.5));
    a.vx += ((dx / d) * sp - a.vx) * ease(dt, bfly ? 0.5 : 0.3);
    a.vy += ((dy / d) * sp - a.vy) * ease(dt, bfly ? 0.5 : 0.3);
    a.vy += Math.sin(t * (bfly ? 7 : 4) + a.born) * s * (bfly ? 1.2 : 0.4) * dt * 10;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    if (!a.leaving) a.x = clamp(a.x, s * 0.5, W - s * 0.5);
    a.y = Math.min(a.y, GY);
    if (Math.abs(a.vx) > s * 0.3) a.face = Math.sign(a.vx);
    a.flap += dt * (bfly ? 16 : 13 + Math.min(10, Math.abs(a.vy) / s * 2));
    a.tilt += (clamp(a.vy / (s * 10), -0.4, 0.4) * a.face - a.tilt) * ease(dt, 0.2);
    if (a.nextVoice <= 0) { if (Math.random() < 0.5) { SOUND[a.kind].voice(); a.beak = 1; } a.nextVoice = 3 + Math.random() * 4; }
  } else a.tilt *= Math.exp(-dt / 0.2);
  a.faceS += (a.face - a.faceS) * ease(dt, 0.08);
  return a.leaving && (a.x < -s * 2 || a.x > W + s * 2);
}

function drawAnimal(c, a, t) {
  c.save();
  // land squash: a quick springy settle when touching down
  a.land = Math.max(0, (a.land || 0) - 0.06);
  const sq = Math.sin((1 - a.land) * Math.PI) * a.land * 0.12;
  c.translate(a.x, a.y);
  c.scale(a.faceS * a.s * a.grow * (1 + sq), a.s * a.grow * (1 - sq));
  c.fillStyle = SHADOW;
  c.strokeStyle = SHADOW;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  DRAW[a.kind](c, a, t);
  c.restore();
}

// ======================================================================
// Making shapes
// ======================================================================
const HOLD = 0.8; // seconds a shape must be held
const pair = { pose: null, at: 0, spent: false };
const forming = [];

function twoHandPose() {
  if (hands.length < 2) return null;
  const [a, b] = hands;
  const sz = (a.size + b.size) / 2;
  if (a.f.count < 3 || b.f.count < 3) return null;
  const dx = Math.abs(a.palm.x - b.palm.x), dy = Math.abs(a.palm.y - b.palm.y);
  const mid = { x: (a.palm.x + b.palm.x) / 2, y: (a.palm.y + b.palm.y) / 2 };
  if (dx < sz * 1.0 && dy > sz * 0.55 && dy < sz * 2.4) return { pose: 'croc', ...mid };
  if (d2(a.raw[0], b.raw[0]) < sz * 0.6) return { pose: 'butterfly', ...mid };
  if (d2(a.raw[4], b.raw[4]) < sz * 0.8 && dy < sz * 0.9) return { pose: 'bird', ...mid };
  return null;
}

function detectShapes(now) {
  forming.length = 0;
  const two = twoHandPose();
  const tp = two?.pose || null;
  if (tp !== pair.pose) { pair.pose = tp; pair.at = now; pair.spent = false; }
  if (tp && !pair.spent) {
    const c = clamp01(((now - pair.at) / 1000 - 0.15) / HOLD);
    if (c > 0) forming.push({ kind: tp, x: two.x, y: two.y, c });
    if (c >= 1) { spawn(tp, two.x, two.y); pair.spent = true; }
  }
  for (const h of hands) {
    const pose = tp ? null : h.pose;
    if (pose !== h.poseName) { h.poseName = pose; h.poseAt = now; h.spent = false; }
    if (!pose || h.spent) continue;
    const c = clamp01(((now - h.poseAt) / 1000 - 0.15) / HOLD);
    if (c > 0) forming.push({ kind: pose, x: h.palm.x, y: h.palm.y, c });
    if (c >= 1) {
      const a = spawn(pose, h.palm.x, h.palm.y);
      a.vx = (W / 2 - h.palm.x) * 0.3;
      h.spent = true;
    }
  }
}

function drawForming(t) {
  for (const f of forming) {
    const s = SIZE[f.kind] * Math.min(W, H);
    ctx.save();
    ctx.strokeStyle = `rgba(${LIGHT},${0.35 + f.c * 0.5})`;
    ctx.shadowColor = `rgba(${LIGHT},0.9)`;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 4 * U;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(f.x, f.y, Math.max(s * 0.75, 90 * U), -Math.PI / 2, -Math.PI / 2 + f.c * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(${LIGHT},${0.5 + f.c * 0.5})`;
    ctx.font = `italic 500 ${Math.round(26 * U)}px "Cormorant Garamond", Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${NAMES[f.kind]}…`, f.x, Math.max(96 * U, f.y - Math.max(s * 0.95, 110 * U)));
    ctx.restore();
    const ghost = { ...restPose(), kind: f.kind, x: f.x, y: f.y + s * 0.45, s, faceS: f.x < W / 2 ? 1 : -1, grow: 0.4 + f.c * 0.6, flap: t * 10, ear: 1, alert: 1, land: 0 };
    gx.clearRect(0, 0, W, H);
    drawAnimal(gx, ghost, t);
    ctx.save();
    ctx.globalAlpha = f.c * 0.6;
    if (CAN_FILTER) ctx.filter = 'blur(2px)';
    ctx.drawImage(gcv, 0, 0, W, H);
    ctx.restore();
  }
}

// ======================================================================
// Loop
// ======================================================================
function setStatus(st, text) { statusEl.dataset.state = st; statusText.textContent = text; }

let last = performance.now();
let flicker = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;
  if (tracker) tracker.update(now, dt);
  updateHands(now, dt);
  if (tracker?.running || fakeHands) detectShapes(now);
  for (const a of animals) a.grow = Math.min(1, a.grow + dt * 3);
  animals = animals.filter((a) => !(FLIERS.has(a.kind) ? updateFlier(a, dt, t) : updateGround(a, dt, t)));

  ctx.drawImage(bg, 0, 0, W, H);
  sx.clearRect(0, 0, W, H);
  for (const a of animals) drawAnimal(sx, a, t);
  for (const h of hands) drawHandShadow(sx, h);
  ctx.save();
  ctx.globalAlpha = 0.86;
  if (CAN_FILTER) ctx.filter = 'blur(2px)';
  ctx.drawImage(sh, 0, 0, W, H);
  ctx.restore();
  drawForming(t);
  drawParticles(dt);
  flicker += (Math.random() - 0.5) * dt * 2;
  flicker *= Math.exp(-dt * 2);
  const vig = 0.06 + Math.sin(t * 1.3) * 0.015 + flicker * 0.05;
  ctx.fillStyle = `rgba(40,28,18,${clamp(vig, 0, 0.15)})`;
  ctx.fillRect(0, 0, W, H);

  if (tracker?.running) {
    setStatus(hands.length ? 'active' : 'searching', hands.length ? `${hands.length} hand${hands.length > 1 ? 's' : ''} in the light` : 'show me your hands');
    hint.textContent = !hands.length
      ? (animals.length ? '' : 'Hold a hand up to the camera and its shadow appears on the wall.')
      : forming.length ? 'Hold still…'
      : !animals.length ? 'Make a shape and hold it (see the guide), or tap an animal below.' : '';
  }
}
requestAnimationFrame(frame);

// ======================================================================
// UI
// ======================================================================
setupToggle($('btn-mirror'), true, (v) => mirror.classList.toggle('hidden', !v));
setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
const guideToggle = setupToggle($('btn-guide'), true, (v) => guide.classList.toggle('hidden', !v));
$('guide-hide').addEventListener('click', () => guideToggle.set(false));
$('btn-reset').addEventListener('click', () => {
  for (const a of animals) { a.leaving = true; a.fleeDir = a.x < W / 2 ? -1 : 1; }
});
for (const b of document.querySelectorAll('.tray button')) {
  b.addEventListener('click', () => { sfx.init(); spawn(b.dataset.kind, 0, 0, Math.random() < 0.5 ? -1 : 1); });
}

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Lighting the lamp…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new Tracker(video, { face: false });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Hand tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

// testing hook
window.shadows = {
  get animals() { return animals; },
  get hands() { return hands; },
  get forming() { return forming; },
  spawn: (kind, x = W / 2, y = H / 2) => spawn(kind, x, y),
  setFakeHands(v) { fakeHands = v; },
  describe,
};
