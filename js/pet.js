// MIRROR PET: Pip copies your face, feature by feature.
// Every MediaPipe blendshape (each eye's blink, squint and gaze, each brow, cheeks,
// jaw, each mouth corner, pucker, funnel, lip shapes) drives a matching control on
// Pip's face continuously, with light low-latency smoothing. Head pose comes straight
// from the landmarks. Little reactions (hearts, tears, steam, sparkles) play on top.

import { Tracker } from './tracking.js?v=7';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, Sfx, setupToggle } from './shared.js?v=7';
import { tube } from './puppets.js?v=7';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('room');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const hint = $('hint');
const moodEl = $('mood');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const mirror = $('mirror');
const guide = $('guide');

let W = 0, H = 0, DPR = 1, R = 100, CX = 0, BASE = 0;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  R = Math.min(W, H) * 0.24;
  CX = W / 2;
  BASE = H * 0.84;
}
window.addEventListener('resize', resize);
resize();

const sfx = new Sfx();
let tracker = null;
let sim = null; // test hook: a dictionary of rig values that replaces the camera

// ======================================================================
// Reading the face into a rig
// ======================================================================
// Sided channels are in SCREEN terms: L is the left of the screen, which in a mirror is your left.
const SIDED = ['blink', 'squint', 'wide', 'browDown', 'browOuter', 'cheekSquint', 'smile', 'frown', 'stretch', 'dimple', 'upperUp', 'lowerDown', 'press', 'sneer'];
const SHARED = ['browInner', 'jaw', 'pucker', 'funnel', 'puff', 'shiftX', 'gazeX', 'gazeY', 'roll', 'yaw', 'pitch', 'rollLower', 'close'];
const rig = {}; // smoothed values Pip is drawn from
const target = {}; // latest measured values
for (const k of SIDED) { rig[k + 'L'] = rig[k + 'R'] = 0; target[k + 'L'] = target[k + 'R'] = 0; }
for (const k of SHARED) { rig[k] = target[k] = 0; }
let found = false;

const BS = {
  blink: 'eyeBlink', squint: 'eyeSquint', wide: 'eyeWide', browDown: 'browDown', browOuter: 'browOuterUp', cheekSquint: 'cheekSquint',
  smile: 'mouthSmile', frown: 'mouthFrown', stretch: 'mouthStretch', dimple: 'mouthDimple', upperUp: 'mouthUpperUp', lowerDown: 'mouthLowerDown',
  press: 'mouthPress', sneer: 'noseSneer',
};
// cartoon faces read better slightly exaggerated
const GAIN = { blink: 1.15, squint: 1.3, wide: 1.6, browDown: 1.6, browOuter: 1.7, cheekSquint: 1.4, smile: 1.35, frown: 2.2, stretch: 1.6, dimple: 1.5, upperUp: 1.5, lowerDown: 1.5, press: 1.4, sneer: 1.8, browInner: 1.7, jaw: 1.35, pucker: 1.4, funnel: 1.5, puff: 1.6, rollLower: 1.3, close: 1 };

const calib = { n: 0, sum: {}, base: null, pitch: null };
let swapEvidence = 0; // > 0: blendshape "Left" is your left; < 0: it is the image left
let swapped = false; // settled with hysteresis so noise can't flip sides
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const eyeBase = { l: 0, r: 0 };
function eyeGeo(lm, side) {
  // your left eye is landmarks 263/362/386/374; your right is 33/133/159/145
  const [o, i, t, b] = side === 'l' ? [263, 362, 386, 374] : [33, 133, 159, 145];
  const v = dist(lm[t], lm[b]) / (dist(lm[o], lm[i]) || 1);
  if (!eyeBase[side]) eyeBase[side] = v;
  if (v > eyeBase[side] * 0.8) eyeBase[side] += (v - eyeBase[side]) * 0.03;
  return clamp01((eyeBase[side] * 0.85 - v) / (eyeBase[side] * 0.55));
}

function measure(lm, bs) {
  // personal neutral: average the first ~40 detections
  if (!calib.base) {
    calib.n++;
    for (const k in bs) calib.sum[k] = (calib.sum[k] || 0) + bs[k];
    if (calib.n >= 40) { calib.base = {}; for (const k in calib.sum) calib.base[k] = calib.sum[k] / calib.n; }
  }
  // until calibrated, treat the face so far as neutral so Pip starts relaxed
  const base = calib.base || Object.fromEntries(Object.entries(calib.sum).map(([k, v]) => [k, v / Math.max(calib.n, 1)]));
  const norm = (name, gain = 1, cap = 0.45) => {
    const b = Math.min(base[name] ?? 0, cap);
    return clamp01((((bs[name] ?? 0) - b) / (1 - b)) * gain);
  };
  // which blendshape side is your left? settle it from the landmarks (winks and lopsided smiles)
  const gl = eyeGeo(lm, 'l'), gr = eyeGeo(lm, 'r');
  const lipMid = (lm[13].y + lm[14].y) / 2;
  const liftL = lipMid - lm[291].y, liftR = lipMid - lm[61].y; // your left mouth corner is 291
  swapEvidence = swapEvidence * 0.995 + ((bs.eyeBlinkLeft ?? 0) - (bs.eyeBlinkRight ?? 0)) * (gl - gr) + ((bs.mouthSmileLeft ?? 0) - (bs.mouthSmileRight ?? 0)) * (liftL - liftR) * 20;
  if (swapEvidence < -0.15) swapped = true;
  else if (swapEvidence > 0.15) swapped = false;
  const youL = swapped ? 'Right' : 'Left';
  const youR = youL === 'Left' ? 'Right' : 'Left';
  // mirror: your left shows on the screen's left
  for (const k of SIDED) {
    const cap = k === 'blink' ? 0.35 : 0.45;
    target[k + 'L'] = norm(BS[k] + youL, GAIN[k], cap);
    target[k + 'R'] = norm(BS[k] + youR, GAIN[k], cap);
  }
  target.blinkL = Math.max(target.blinkL, gl);
  target.blinkR = Math.max(target.blinkR, gr);
  target.browInner = norm('browInnerUp', GAIN.browInner);
  target.jaw = norm('jawOpen', GAIN.jaw, 0.2);
  target.pucker = norm('mouthPucker', GAIN.pucker, 0.4);
  target.funnel = norm('mouthFunnel', GAIN.funnel, 0.3);
  target.puff = norm('cheekPuff', GAIN.puff, 0.3);
  target.rollLower = norm('mouthRollLower', GAIN.rollLower);
  target.close = norm('mouthClose', 1);
  target.shiftX = clamp(((bs['mouth' + youR] ?? 0) - (bs['mouth' + youL] ?? 0)) * 1.6, -1, 1);
  const g = (n) => bs[n] ?? 0;
  // looking toward your left means looking toward the screen's left
  target.gazeX = clamp((g('eyeLookIn' + youL) + g('eyeLookOut' + youR) - g('eyeLookOut' + youL) - g('eyeLookIn' + youR)) * 1.4, -1, 1);
  target.gazeY = clamp((g('eyeLookDownLeft') + g('eyeLookDownRight') - g('eyeLookUpLeft') - g('eyeLookUpRight')) * 0.9, -1, 1);

  // head pose straight from the landmarks, mirrored to screen terms
  const ax = tracker?.aspect || 4 / 3;
  const P = (i) => ({ x: (1 - lm[i].x) * ax, y: lm[i].y });
  const a = P(33), b = P(263);
  target.roll = clamp(Math.atan2(a.y - b.y, a.x - b.x), -0.7, 0.7);
  const cl = P(454), cr = P(234), nose = P(1);
  const fw = Math.hypot(cr.x - cl.x, cr.y - cl.y) || 1;
  target.yaw = clamp(((nose.x - (cl.x + cr.x) / 2) / fw) * 2.6, -1, 1);
  const eyeMidY = (lm[159].y + lm[386].y) / 2;
  const pr = (lm[1].y - eyeMidY) / ((lm[152].y - eyeMidY) || 1);
  if (calib.pitch == null) calib.pitch = pr;
  if (!calib.base) calib.pitch += (pr - calib.pitch) * 0.1;
  target.pitch = clamp((pr - calib.pitch) * 5, -1, 1);
}

function readFace(dt, now) {
  if (sim) {
    found = sim.found !== false;
    for (const k in target) target[k] = sim[k] ?? 0;
  } else if (tracker) {
    const s = tracker.update(now, dt);
    found = s.faceFound;
    if (s.newResult && found && tracker.lastFace && tracker.lastBlend) measure(tracker.lastFace, tracker.lastBlend);
    if (!found) for (const k in target) target[k] = 0;
  }
  // low-latency smoothing: eyelids fastest, mouth fast, head pose a touch softer
  for (const k in rig) {
    const tau = k.startsWith('blink') ? 0.022 : k === 'roll' || k === 'yaw' || k === 'pitch' ? 0.06 : k.startsWith('gaze') ? 0.05 : 0.04;
    rig[k] += (target[k] - rig[k]) * ease(dt, tau);
  }
}

// ======================================================================
// Pip's own state (reactions layered on top of the copied face)
// ======================================================================
const P = { hop: 0, hopV: 0, squash: 0, squashV: 0, earL: 0, earR: 0, earVL: 0, earVR: 0, sleep: 0, awayFor: 0, seenFor: 0, gloom: 0, hue: 0, wink: 0, arms: 0, lastRoll: 0, rollV: 0 };
const E = { smile: 0, sad: 0, angry: 0, surprise: 0, kiss: 0 };
const cool = {};
const ready = (k, now, ms) => { if ((cool[k] || 0) > now) return false; cool[k] = now + ms; return true; };
let parts = [];
function emit(type, x, y, o = {}) { parts.push({ type, x, y, vx: o.vx ?? 0, vy: o.vy ?? -40, life: 0, max: o.max ?? 1.5, text: o.text, size: o.size ?? 1, color: o.color, spin: Math.random() * 6 }); }

const S = {
  giggle() { [0, 0.09, 0.18, 0.27].forEach((d, i) => sfx.tone({ type: 'sine', freqs: [[0, 900 + i * 120], [0.06, 1250 + i * 120]], dur: 0.08, gain: 0.08, delay: d })); },
  oh() { sfx.tone({ type: 'triangle', freqs: [[0, 500], [0.18, 1100]], dur: 0.25, gain: 0.12 }); },
  grumble() { sfx.tone({ type: 'sawtooth', freqs: [[0, 120], [0.3, 95], [0.6, 110]], dur: 0.7, gain: 0.1, filter: 400, q: 2 }); },
  sniffle() { [0, 0.15].forEach((d) => sfx.hiss({ dur: 0.12, gain: 0.07, type: 'bandpass', freq: 1800, q: 2, delay: d })); sfx.tone({ type: 'sine', freqs: [[0, 700], [0.35, 420]], dur: 0.4, gain: 0.06, delay: 0.3 }); },
  mwah() { sfx.tone({ type: 'sine', freqs: [[0, 300], [0.05, 1100]], dur: 0.12, gain: 0.12 }); sfx.hiss({ dur: 0.05, gain: 0.05, freq: 3000, delay: 0.04 }); },
  ding() { sfx.tone({ type: 'sine', freqs: [[0, 1568]], dur: 0.5, gain: 0.08 }); sfx.tone({ type: 'sine', freqs: [[0, 2349]], dur: 0.6, gain: 0.05, delay: 0.08 }); },
  boop() { sfx.tone({ type: 'sine', freqs: [[0, 700], [0.15, 260]], dur: 0.18, gain: 0.14 }); },
  yawn() { sfx.tone({ type: 'triangle', freqs: [[0, 600], [0.4, 750], [1.0, 300]], dur: 1.1, gain: 0.07, filter: 900, q: 1 }); },
  happy() { sfx.tone({ type: 'sine', freqs: [[0, 800], [0.1, 1300]], dur: 0.15, gain: 0.08 }); sfx.tone({ type: 'sine', freqs: [[0, 1000], [0.1, 1600]], dur: 0.18, gain: 0.07, delay: 0.14 }); },
  pfff() { sfx.hiss({ dur: 0.5, gain: 0.1, type: 'lowpass', freq: 900 }); },
};

function update(dt, now) {
  const t = now / 1000;
  const r = rig;
  const k = (tau) => ease(dt, tau);
  if (found) { P.awayFor = 0; P.seenFor += dt; } else { P.awayFor += dt; P.seenFor = 0; }
  const wantSleep = P.awayFor > 7 ? 1 : 0;
  if (P.sleep > 0.6 && found && P.seenFor > 0.3 && ready('wake', now, 4000)) { S.yawn(); emit('text', CX, BASE - R * 2.6, { text: '!', vy: -50, max: 1, size: 1.4 }); P.hopV = -R * 3; }
  P.sleep += (wantSleep - P.sleep) * k(wantSleep ? 1.2 : 0.3);

  // emotions, read from the copied face
  const smile = (r.smileL + r.smileR) / 2, frown = (r.frownL + r.frownR) / 2, browDown = (r.browDownL + r.browDownR) / 2;
  const brows = (r.browInner + (r.browOuterL + r.browOuterR) / 2) / 2;
  E.smile = clamp01(smile);
  E.sad = clamp01((frown * 0.7 + r.browInner * 0.5 * (1 - browDown) - smile) * 1.1);
  E.angry = clamp01((browDown * 0.9 + (r.sneerL + r.sneerR) * 0.25 - smile * 0.8 - brows * 0.4) * 1.1);
  E.surprise = clamp01(Math.min(brows * 1.4, r.jaw * 1.6));
  E.kiss = clamp01(r.pucker * (1 - smile));
  const awake = found && P.sleep < 0.3;
  const cx = CX, top = BASE - R * 2.2;
  if (awake) {
    const wl = r.blinkL > 0.6 && r.blinkR < 0.3, wr = r.blinkR > 0.6 && r.blinkL < 0.3;
    if (wl || wr) {
      P.wink += dt;
      if (P.wink > 0.12 && ready('wink', now, 1200)) {
        const sx = wl ? -1 : 1;
        for (let i = 0; i < 6; i++) emit('star', cx + sx * R * 0.7, BASE - R * 1.25, { vx: (Math.random() - 0.5) * 120 + sx * 70, vy: -80 - Math.random() * 80, max: 1.1, size: 0.7 + Math.random() * 0.6 });
        S.ding();
      }
    } else P.wink = 0;
    if (E.smile > 0.55) {
      if (ready('giggle', now, r.jaw > 0.35 ? 1400 : 3200)) { S.giggle(); P.hopV = -R * (r.jaw > 0.35 ? 3.2 : 2); if (r.jaw > 0.35) emit('text', cx + R * 1.2, top + R * 0.3, { text: 'hehe', vx: 30, vy: -40, max: 1.3 }); }
      if (Math.random() < dt * 2.5 * E.smile) emit('heart', cx + (Math.random() - 0.5) * R * 2.4, top + R * 0.3, { vx: (Math.random() - 0.5) * 40, vy: -70, max: 2, size: 0.7 + Math.random() * 0.5, color: '238,160,176' });
    }
    if (E.surprise > 0.6 && ready('oh', now, 2500)) { S.oh(); P.hopV = -R * 3.4; emit('text', cx, top - R * 0.1, { text: '!', vy: -60, max: 1, size: 1.6 }); }
    if (E.angry > 0.4) {
      if (ready('grumble', now, 3000)) S.grumble();
      if (Math.random() < dt * 6 * E.angry) { const sd = Math.random() < 0.5 ? -1 : 1; emit('steam', cx + sd * R * 0.8, top + R * 0.45, { vx: sd * 50, vy: -90, max: 1.1 }); }
    }
    if (E.sad > 0.4) {
      if (ready('sniffle', now, 4500)) S.sniffle();
      if (Math.random() < dt * 2.5 * E.sad) { const sd = Math.random() < 0.5 ? -1 : 1; emit('tear', cx + sd * R * 0.42 + r.yaw * R * 0.2, BASE - R * 1.05, { vx: sd * 6, vy: 30, max: 1.4 }); }
    }
    P.gloom += ((E.sad > 0.5 ? 1 : 0) - P.gloom) * k(E.sad > 0.5 ? 1.2 : 0.6);
    if (E.kiss > 0.5 && ready('mwah', now, 900)) {
      S.mwah();
      for (let i = 0; i < 3; i++) emit('heart', cx + (Math.random() - 0.5) * R * 0.4, BASE - R * 0.75, { vx: (Math.random() - 0.5) * 80, vy: -90 - Math.random() * 40, max: 1.8, size: 0.9 + Math.random() * 0.6, color: '232,120,150' });
    }
    if (r.puff > 0.5) cool.puffed = true;
    if (cool.puffed && r.puff < 0.2) { cool.puffed = false; S.pfff(); for (let i = 0; i < 8; i++) emit('puff', cx + R * 0.15, BASE - R * 0.7, { vx: 60 + Math.random() * 120, vy: (Math.random() - 0.5) * 60, max: 0.8 }); }
  } else P.gloom *= Math.exp(-dt / 0.6);
  if (P.sleep > 0.7 && Math.random() < dt * 0.8) emit('text', cx + R * 0.8, top + R * 0.2, { text: 'z', vx: 25, vy: -35, max: 2.2, size: 0.8 + Math.random() * 0.5 });
  if (!found && P.awayFor > 1 && P.awayFor < 6 && ready('where', now, 3500)) emit('text', cx + R * 1.1, top + R * 0.2, { text: '?', vy: -30, max: 1.6, size: 1.2 });

  // ears on springs: brows lift them, sadness and sleep droop them, head motion swings them
  P.rollV = (r.roll - P.lastRoll) / Math.max(dt, 1e-3);
  P.lastRoll = r.roll;
  for (const sd of ['L', 'R']) {
    const brow = (r['browOuter' + sd] + r.browInner) / 2 - r['browDown' + sd] * 0.6;
    const tgt = clamp(0.15 + brow * 0.9 + E.surprise * 0.4 - E.sad * 1.1 - P.sleep * 0.9 - E.angry * 0.5, -1, 1);
    const kick = P.rollV * 0.04 * (sd === 'L' ? 1 : -1) - P.hopV / R * 0.02;
    P['earV' + sd] += ((tgt - P['ear' + sd]) * 110 - P['earV' + sd] * 10 + kick * 60) * dt;
    P['ear' + sd] += P['earV' + sd] * dt;
  }
  P.arms += ((E.smile > 0.6 ? 1 : E.surprise > 0.5 ? 0.8 : 0) - P.arms) * k(0.2);
  P.hopV += 2600 * (R / 120) * dt;
  P.hop += P.hopV * dt;
  if (P.hop > 0) { if (P.hopV > R * 0.8) P.squashV += P.hopV * 0.004; P.hop = 0; P.hopV = 0; }
  P.squashV += (-P.squash * 160 - P.squashV * 10) * dt;
  P.squash += P.squashV * dt;
  P.hue += ((E.angry - E.sad * 0.6) - P.hue) * k(0.4);
}

// ======================================================================
// Drawing
// ======================================================================
const motes = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), r: 2 + Math.random() * 5, s: 0.2 + Math.random() * 0.6, p: Math.random() * 6 }));
function drawRoom(t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#dfe8d9');
  g.addColorStop(0.62, '#f3efe3');
  g.addColorStop(1, '#e5dccb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const blobs = [[0.15, 0.25, 0.22, '207,195,234'], [0.85, 0.3, 0.2, '242,205,212'], [0.72, 0.12, 0.12, '246,226,160'], [0.3, 0.6, 0.16, '190,210,180']];
  for (const [bx, by, br, c] of blobs) {
    const x = bx * W + Math.sin(t * 0.2 + bx * 9) * 20, y = by * H + Math.cos(t * 0.17 + by * 7) * 16;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, br * Math.max(W, H));
    rg.addColorStop(0, `rgba(${c},0.45)`);
    rg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
  const fl = ctx.createRadialGradient(CX, BASE + R * 0.2, 0, CX, BASE + R * 0.2, W * 0.6);
  fl.addColorStop(0, 'rgba(170,160,130,0.18)');
  fl.addColorStop(1, 'rgba(170,160,130,0)');
  ctx.fillStyle = fl;
  ctx.fillRect(0, BASE - R * 0.6, W, H);
  if (P.gloom > 0.02) { ctx.fillStyle = `rgba(110,125,150,${P.gloom * 0.18})`; ctx.fillRect(0, 0, W, H); }
  if (E.smile > 0.02) { ctx.fillStyle = `rgba(250,225,150,${E.smile * 0.1})`; ctx.fillRect(0, 0, W, H); }
  if (E.angry > 0.02) { ctx.fillStyle = `rgba(230,140,130,${E.angry * 0.1})`; ctx.fillRect(0, 0, W, H); }
  for (const m of motes) {
    const x = ((m.x + t * 0.01 * m.s) % 1) * W, y = ((m.y - t * 0.012 * m.s + 1) % 1) * H;
    ctx.fillStyle = `rgba(255,252,240,${0.35 + Math.sin(t + m.p) * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, m.r, 0, Math.PI * 2); ctx.fill();
  }
}

// Pip's head-body: a soft, slightly pear-shaped bean; puff bulges the cheeks.
function bodyPath(w, h, puff) {
  const top = -h, bot = h * 0.92;
  const wc = w * (1 + puff * 0.14);
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.bezierCurveTo(w * 0.59, top, wc, -h * 0.55, wc, h * 0.18);
  ctx.bezierCurveTo(wc, h * 0.62, w * 0.62, bot, 0, bot);
  ctx.bezierCurveTo(-w * 0.62, bot, -wc, h * 0.62, -wc, h * 0.18);
  ctx.bezierCurveTo(-wc, -h * 0.55, -w * 0.59, top, 0, top);
  ctx.closePath();
}

function drawEar(sd, t, depthX) {
  const s = sd === 'L' ? -1 : 1;
  const e = P['ear' + sd];
  const ang = s * (0.32 - e * 0.28 + E.angry * 0.55 + P.sleep * 0.5) + (e < 0 ? s * -e * 1.0 : 0) + Math.sin(t * 1.3 + s) * 0.03;
  ctx.save();
  ctx.translate(s * R * 0.5 + depthX, -R * 0.78);
  ctx.rotate(ang);
  const len = R * (1.0 + e * 0.1);
  const g = ctx.createLinearGradient(0, 0, 0, -len);
  g.addColorStop(0, '#cdbfea');
  g.addColorStop(1, '#e4dcf6');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-R * 0.17, 0);
  ctx.bezierCurveTo(-R * 0.26, -len * 0.55, -R * 0.12, -len, 0, -len);
  ctx.bezierCurveTo(R * 0.12, -len, R * 0.26, -len * 0.55, R * 0.17, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(242,190,205,0.9)';
  ctx.beginPath();
  ctx.moveTo(-R * 0.08, -len * 0.12);
  ctx.bezierCurveTo(-R * 0.14, -len * 0.55, -R * 0.06, -len * 0.86, 0, -len * 0.86);
  ctx.bezierCurveTo(R * 0.06, -len * 0.86, R * 0.14, -len * 0.55, R * 0.08, -len * 0.12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function lidPath(rx, yTop, yBot) {
  const open = yBot - yTop, m = (yTop + yBot) / 2;
  ctx.beginPath();
  ctx.moveTo(-rx * 1.05, m);
  ctx.bezierCurveTo(-rx * 1.05, yTop + open * 0.05, -rx * 0.55, yTop, 0, yTop);
  ctx.bezierCurveTo(rx * 0.55, yTop, rx * 1.05, yTop + open * 0.05, rx * 1.05, m);
}

function drawEye(sd, t) {
  const s = sd === 'L' ? -1 : 1;
  const r = rig;
  const yawK = 1 - s * r.yaw * 0.25; // the eye on the side you turn toward narrows
  const rx = R * 0.15 * yawK, ry = R * 0.19;
  const ex = s * R * 0.4, ey = -R * 0.1;
  const blink = Math.max(clamp01(r['blink' + sd]), P.sleep);
  const wide = r['wide' + sd];
  const lower = clamp01(Math.max(r['cheekSquint' + sd], r['squint' + sd] * 0.7, r['smile' + sd] * 0.45));
  // the top lid falls with a blink and lifts when wide; the lower lid rises with a squint
  const yBot = ry * (1 - lower * 0.75);
  const yTop = lerp(-ry * (1 + wide * 0.18) + r['squint' + sd] * ry * 0.3 + r['browDown' + sd] * ry * 0.35, yBot - ry * 0.02, blink);
  const open = yBot - yTop;
  ctx.save();
  ctx.translate(ex, ey);
  ctx.strokeStyle = '#2f2838';
  ctx.lineCap = 'round';
  if (open < ry * 0.14) {
    ctx.lineWidth = R * 0.04;
    const happy = lower > 0.4;
    const y = (yTop + yBot) / 2;
    ctx.beginPath();
    ctx.moveTo(-rx, y + (happy ? ry * 0.15 : 0));
    ctx.quadraticCurveTo(0, y + (happy ? -ry * 0.55 : ry * 0.35), rx, y + (happy ? ry * 0.15 : 0));
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * rx * 0.95, y); ctx.lineTo(s * rx * 1.25, y - ry * 0.18); ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.save();
  lidPath(rx, yTop, yBot);
  const m = (yTop + yBot) / 2;
  ctx.bezierCurveTo(rx * 1.05, yBot - open * 0.05, rx * 0.55, yBot, 0, yBot);
  ctx.bezierCurveTo(-rx * 0.55, yBot, -rx * 1.05, yBot - open * 0.05, -rx * 1.05, m);
  ctx.closePath();
  ctx.clip();
  const gx = (r.gazeX * 0.55 + r.yaw * 0.3) * rx * 0.4, gy = (r.gazeY * 0.6 + r.pitch * 0.2) * ry * 0.3;
  const ig = ctx.createRadialGradient(gx, gy + ry * 0.35, ry * 0.1, gx, gy, ry * 1.1);
  ig.addColorStop(0, '#7a6596');
  ig.addColorStop(0.55, '#3c3150');
  ig.addColorStop(1, '#231c2e');
  ctx.fillStyle = ig;
  ctx.beginPath(); ctx.ellipse(gx * 0.3, gy * 0.3, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#17121e';
  ctx.beginPath(); ctx.ellipse(gx, gy, rx * 0.5 * (1 - wide * 0.15), ry * 0.5 * (1 - wide * 0.15), 0, 0, Math.PI * 2); ctx.fill();
  const shine = 1 + E.sad * 0.35;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath(); ctx.ellipse(gx - rx * 0.35, gy - ry * 0.4, rx * 0.3 * shine, ry * 0.26 * shine, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(gx + rx * 0.32, gy + ry * 0.3, rx * 0.12 * shine, 0, Math.PI * 2); ctx.fill();
  if (E.sad > 0.3) { ctx.fillStyle = `rgba(170,205,240,${E.sad * 0.55})`; ctx.beginPath(); ctx.ellipse(0, yBot, rx * 1.1, ry * 0.3, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  // lash line along the top lid, with a flick at the outer corner
  ctx.lineWidth = R * 0.03;
  lidPath(rx, yTop, yBot);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s * rx * 0.95, yTop + open * 0.2); ctx.lineTo(s * rx * 1.28, yTop - ry * 0.05); ctx.stroke();
  ctx.restore();
}

function drawBrow(sd) {
  const s = sd === 'L' ? -1 : 1;
  const r = rig;
  const down = r['browDown' + sd], outer = r['browOuter' + sd], inner = r.browInner;
  const baseY = -R * 0.44;
  const innerX = s * R * (0.24 - down * 0.04), outerX = s * R * 0.56;
  const innerY = baseY - inner * R * 0.16 + down * R * 0.17;
  const outerY = baseY - outer * R * 0.14 + down * R * 0.02 - inner * R * 0.03;
  const midY = (innerY + outerY) / 2 - R * 0.035 - (inner * 0.6 + outer * 0.4) * R * 0.02;
  ctx.fillStyle = 'rgba(132,104,156,0.9)';
  tube(ctx, [[innerX, innerY], [(innerX + outerX) / 2, midY], [outerX, outerY]], [R * 0.032, R * 0.028, R * 0.016], 6);
}

function drawMouth() {
  const r = rig;
  const shift = r.shiftX * R * 0.08;
  const narrow = clamp01(r.pucker * 0.8 + r.funnel * 0.6);
  const half = (sd) => R * 0.17 * (1 + r['stretch' + sd] * 0.4 + r['smile' + sd] * 0.35 + r['dimple' + sd] * 0.1 - narrow * 0.6);
  const cyOf = (sd) => -r['smile' + sd] * R * 0.1 + r['frown' + sd] * R * 0.09 - r['dimple' + sd] * R * 0.02;
  const L = [-half('L') + shift, cyOf('L')], Rt = [half('R') + shift, cyOf('R')];
  const upper = -(r.upperUpL + r.upperUpR) / 2 * R * 0.06;
  const open = clamp01(r.jaw - r.close * 0.6);
  const lowerDrop = open * R * 0.34 + (r.lowerDownL + r.lowerDownR) / 2 * R * 0.06;
  const curve = ((r.smileL + r.smileR) / 2 - (r.frownL + r.frownR) / 2) * R * 0.09;
  const press = (r.pressL + r.pressR) / 2;
  ctx.save();
  ctx.translate(0, R * 0.32);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (lowerDrop + Math.abs(upper) < R * 0.035 && narrow < 0.45) {
    // closed: one soft curve, a little cat-like "w" at rest
    ctx.strokeStyle = '#3a3242';
    ctx.lineWidth = R * (0.035 - press * 0.01);
    const dip = curve * 0.9 + R * 0.025;
    ctx.beginPath();
    ctx.moveTo(L[0], L[1]);
    ctx.bezierCurveTo(L[0] * 0.55, L[1] * 0.4 + dip, shift - R * 0.03, dip * 0.6, shift, R * 0.005 + curve * 0.25);
    ctx.bezierCurveTo(shift + R * 0.03, dip * 0.6, Rt[0] * 0.55, Rt[1] * 0.4 + dip, Rt[0], Rt[1]);
    ctx.stroke();
  } else if (narrow >= 0.45 && open < 0.35) {
    // pucker / funnel: little round lips
    const w = R * (0.07 + r.funnel * 0.02), h = R * (0.07 + r.funnel * 0.05 + open * 0.08);
    ctx.fillStyle = '#d97a92';
    ctx.beginPath(); ctx.ellipse(shift, R * 0.02, w * 1.35, h * 1.25, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5a2d3e';
    ctx.beginPath(); ctx.ellipse(shift, R * 0.02, w * (0.5 + r.funnel * 0.3), h * (0.35 + r.funnel * 0.4 + open * 0.3), 0, 0, Math.PI * 2); ctx.fill();
  } else {
    // open mouth: corners, a top lip that can lift, a jaw that drops
    const topY = upper - curve * 0.15;
    const botY = Math.max(topY + R * 0.04, lowerDrop + curve * 0.35);
    ctx.beginPath();
    ctx.moveTo(L[0], L[1]);
    ctx.bezierCurveTo(L[0] * 0.5, topY - curve * 0.1, Rt[0] * 0.5, topY - curve * 0.1, Rt[0], Rt[1]);
    ctx.bezierCurveTo(Rt[0] * 0.9, botY * 0.9, Rt[0] * 0.45, botY * 1.25, shift, botY * 1.25);
    ctx.bezierCurveTo(L[0] * 0.45, botY * 1.25, L[0] * 0.9, botY * 0.9, L[0], L[1]);
    ctx.closePath();
    ctx.fillStyle = '#5a2d3e';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#ef8fa3';
    ctx.beginPath(); ctx.ellipse(shift, botY * 1.25, (Rt[0] - L[0]) * 0.33, Math.max(botY * 0.45, R * 0.03), 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fffaf2';
    const tw = R * 0.045;
    ctx.beginPath(); ctx.roundRect(shift - tw - R * 0.004, topY - R * 0.02, tw, R * 0.05, R * 0.012); ctx.fill();
    ctx.beginPath(); ctx.roundRect(shift + R * 0.004, topY - R * 0.02, tw, R * 0.05, R * 0.012); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(58,50,66,0.7)';
    ctx.lineWidth = R * 0.02;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPip(t) {
  const r = rig;
  const breathe = 1 + Math.sin(t * (P.sleep > 0.5 ? 1.4 : 2.2)) * (0.01 + P.sleep * 0.015);
  const sq = clamp(P.squash, -0.25, 0.25);
  const shakeX = E.angry > 0.5 ? Math.sin(t * 50) * R * 0.012 * E.angry : 0;
  const bodyY = BASE - R * 1.0 + P.hop;
  const puff = r.puff;
  ctx.fillStyle = `rgba(80,90,70,${0.16 * (1 + P.hop / (R * 2))})`;
  ctx.beginPath(); ctx.ellipse(CX, BASE - R * 0.04, R * 0.95 * (1 + puff * 0.15) * (1 + P.hop / (R * 6)), R * 0.13, 0, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.translate(CX + shakeX + r.yaw * R * 0.05, bodyY);
  // the tilt pivots near the feet so the whole body leans with you
  ctx.translate(0, R * 0.9);
  ctx.rotate(r.roll * 0.9);
  ctx.translate(0, -R * 0.9);
  ctx.scale(breathe * (1 + sq) * (1 + puff * 0.06), breathe * (1 - sq) * (1 + puff * 0.04));
  const yawShift = r.yaw * R * 0.22; // features slide with a turn; ears and body lag behind
  ctx.fillStyle = '#e7b0bd';
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * R * 0.42, R * 0.86, R * 0.24, R * 0.12, 0, 0, Math.PI * 2); ctx.fill(); }
  drawEar('L', t, -yawShift * 0.35);
  drawEar('R', t, -yawShift * 0.35);
  const g = ctx.createRadialGradient(-R * 0.35 + yawShift * 0.3, -R * 0.45, R * 0.1, 0, 0, R * 1.15);
  g.addColorStop(0, '#fff1f2');
  g.addColorStop(0.45, '#f7d3da');
  g.addColorStop(0.85, '#eab4c1');
  g.addColorStop(1, '#de9fb0');
  ctx.fillStyle = g;
  bodyPath(R * 1.02, R, puff);
  ctx.fill();
  if (P.hue > 0.03) { ctx.fillStyle = `rgba(232,96,96,${P.hue * 0.3})`; bodyPath(R * 1.02, R, puff); ctx.fill(); }
  if (P.hue < -0.03) { ctx.fillStyle = `rgba(130,160,210,${-P.hue * 0.3})`; bodyPath(R * 1.02, R, puff); ctx.fill(); }
  const sh = ctx.createRadialGradient(-R * 0.4, -R * 0.55, 0, -R * 0.4, -R * 0.55, R * 0.55);
  sh.addColorStop(0, 'rgba(255,255,255,0.45)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh;
  bodyPath(R * 1.02, R, puff);
  ctx.fill();
  const bg = ctx.createRadialGradient(0, R * 0.5, 0, 0, R * 0.5, R * 0.6);
  bg.addColorStop(0, 'rgba(255,250,244,0.85)');
  bg.addColorStop(1, 'rgba(255,250,244,0)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.ellipse(yawShift * 0.3, R * 0.52, R * 0.6, R * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // a soft tuft on top
  ctx.strokeStyle = '#eab4c1';
  ctx.lineWidth = R * 0.05;
  ctx.lineCap = 'round';
  for (const [dx, h, c] of [[-0.06, 0.16, -0.12], [0.03, 0.2, 0.1], [0.1, 0.13, 0.22]]) {
    ctx.beginPath(); ctx.moveTo(dx * R + yawShift * 0.5, -R * 0.96); ctx.quadraticCurveTo((dx + c * 0.4) * R + yawShift * 0.5, -R * (0.96 + h * 0.8), (dx + c) * R + yawShift * 0.5, -R * (0.96 + h)); ctx.stroke();
  }
  // little arms wave when happy or surprised
  ctx.fillStyle = '#efc0cb';
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * R * 0.9, R * 0.3);
    ctx.rotate(s * (0.5 + P.arms * (0.9 + Math.sin(t * 10) * 0.25)));
    ctx.beginPath(); ctx.ellipse(0, R * 0.08, R * 0.11, R * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // face
  ctx.save();
  ctx.translate(yawShift, r.pitch * R * 0.12);
  for (const sd of ['L', 'R']) {
    const s = sd === 'L' ? -1 : 1;
    const lift = Math.max(r['cheekSquint' + sd], r['smile' + sd] * 0.8);
    const blush = 0.22 + lift * 0.35 + E.kiss * 0.25 + E.angry * 0.3;
    const y = R * 0.16 - lift * R * 0.06;
    const cg = ctx.createRadialGradient(s * R * 0.6, y, 0, s * R * 0.6, y, R * 0.22 * (1 + puff * 0.5));
    cg.addColorStop(0, `rgba(240,128,150,${blush})`);
    cg.addColorStop(1, 'rgba(240,128,150,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.ellipse(s * R * 0.6, y, R * 0.24 * (1 + puff * 0.5), R * 0.17 * (1 + puff * 0.4), 0, 0, Math.PI * 2); ctx.fill();
  }
  drawEye('L', t);
  drawEye('R', t);
  drawBrow('L');
  drawBrow('R');
  // nose; a sneer lifts it and adds little crinkles
  const sneer = (r.sneerL + r.sneerR) / 2;
  const ny = R * 0.12 - sneer * R * 0.04;
  ctx.fillStyle = '#b8677d';
  ctx.beginPath();
  ctx.moveTo(-R * 0.05, ny); ctx.quadraticCurveTo(0, ny - R * 0.02, R * 0.05, ny); ctx.quadraticCurveTo(R * 0.01, ny + R * 0.06, 0, ny + R * 0.065); ctx.quadraticCurveTo(-R * 0.01, ny + R * 0.06, -R * 0.05, ny);
  ctx.fill();
  if (sneer > 0.25) {
    ctx.strokeStyle = `rgba(160,96,120,${sneer})`;
    ctx.lineWidth = R * 0.012;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * R * 0.07, ny - R * 0.05); ctx.quadraticCurveTo(s * R * 0.1, ny - R * 0.03, s * R * 0.08, ny); ctx.stroke(); }
  }
  drawMouth();
  if (E.angry > 0.35) {
    ctx.save();
    ctx.translate(R * 0.62, -R * 0.66);
    ctx.strokeStyle = `rgba(214,70,80,${E.angry})`;
    ctx.lineWidth = R * 0.03;
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.moveTo(a * R * 0.03, b * R * 0.09); ctx.quadraticCurveTo(a * R * 0.03, b * R * 0.03, a * R * 0.09, b * R * 0.03); ctx.stroke(); }
    ctx.restore();
  }
  ctx.restore();
  ctx.restore();

  if (P.gloom > 0.05) {
    const cx = CX + Math.sin(t * 0.8) * R * 0.15, cy = BASE - R * 2.75;
    ctx.save();
    ctx.globalAlpha = P.gloom;
    ctx.fillStyle = '#b8c0cc';
    for (const [dx, dy, rr] of [[-0.35, 0.05, 0.25], [0, -0.1, 0.32], [0.35, 0.05, 0.24], [0.1, 0.12, 0.25], [-0.15, 0.12, 0.22]]) { ctx.beginPath(); ctx.arc(cx + dx * R, cy + dy * R, rr * R, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = 'rgba(140,170,210,0.8)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const x = cx - R * 0.4 + i * R * 0.2, y0 = cy + R * 0.3 + ((t * 160 + i * 37) % (R * 0.8));
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x - 2, y0 + 9); ctx.stroke();
    }
    ctx.restore();
  }
}

function heartPath(s) {
  ctx.beginPath();
  ctx.moveTo(0, 6 * s);
  ctx.bezierCurveTo(-14 * s, -4 * s, -8 * s, -16 * s, 0, -8 * s);
  ctx.bezierCurveTo(8 * s, -16 * s, 14 * s, -4 * s, 0, 6 * s);
}

function drawParticles(dt) {
  parts = parts.filter((p) => (p.life += dt) < p.max);
  const u = R / 120;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of parts) {
    if (p.type === 'tear') p.vy += 260 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const k = p.life / p.max;
    const a = (1 - k) * Math.min(1, p.life * 8);
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.type === 'heart') {
      ctx.fillStyle = `rgba(${p.color || '238,160,176'},${a})`;
      ctx.rotate(Math.sin(p.life * 3 + p.spin) * 0.25);
      heartPath(p.size * u * 1.2);
      ctx.fill();
    } else if (p.type === 'star') {
      ctx.fillStyle = `rgba(246,205,110,${a})`;
      ctx.rotate(p.life * 3 + p.spin);
      const s = 10 * u * p.size;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const rr = i % 2 ? s * 0.42 : s; const ang = (i / 10) * Math.PI * 2; ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr); }
      ctx.closePath();
      ctx.fill();
    } else if (p.type === 'tear') {
      ctx.fillStyle = `rgba(150,190,235,${a})`;
      ctx.beginPath(); ctx.moveTo(0, -7 * u); ctx.quadraticCurveTo(6 * u, 3 * u, 0, 6 * u); ctx.quadraticCurveTo(-6 * u, 3 * u, 0, -7 * u); ctx.fill();
    } else if (p.type === 'steam' || p.type === 'puff') {
      ctx.fillStyle = p.type === 'steam' ? `rgba(255,255,255,${a * 0.75})` : `rgba(250,240,240,${a * 0.8})`;
      ctx.beginPath(); ctx.arc(0, 0, (6 + k * 16) * u, 0, Math.PI * 2); ctx.fill();
    } else if (p.type === 'text') {
      ctx.fillStyle = `rgba(80,70,100,${a})`;
      ctx.font = `italic 500 ${Math.round(30 * u * p.size)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillText(p.text, 0, 0);
    }
    ctx.restore();
  }
}

function moodWord() {
  const r = rig;
  if (P.sleep > 0.6) return 'sleepy';
  if (!found) return P.awayFor > 1 ? 'where did you go?' : '';
  if (P.wink > 0.1) return 'winking';
  if (E.surprise > 0.55) return 'surprised!';
  if (r.puff > 0.45) return 'puffed up';
  if (E.kiss > 0.45) return 'kissy';
  if (E.angry > 0.4) return 'grumpy';
  if (E.sad > 0.4) return 'sad';
  if (E.smile > 0.55) return r.jaw > 0.35 ? 'giggly' : 'happy';
  if (E.smile > 0.25) return 'content';
  if (r.jaw > 0.4) return 'ahh';
  return 'copying you';
}

// ======================================================================
// Loop + UI
// ======================================================================
function setStatus(st, text) { statusEl.dataset.state = st; statusText.textContent = text; }
let last = performance.now();
let lastMood = '';
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;
  readFace(dt, now);
  update(dt, now);
  drawRoom(t);
  drawPip(t);
  drawParticles(dt);
  if (tracker?.running || sim) {
    const m = moodWord();
    if (m !== lastMood) { moodEl.textContent = m; lastMood = m; }
    if (tracker?.running) {
      setStatus(found ? 'active' : 'searching', found ? (calib.base ? 'Pip can see you' : 'learning your face…') : 'looking for your face');
      hint.textContent = found ? '' : 'Look at the camera so Pip can see you.';
    }
  }
}
requestAnimationFrame(frame);

canvas.addEventListener('pointerdown', (e) => {
  const dx = e.clientX - CX, dy = e.clientY - (BASE - R);
  if (Math.hypot(dx, dy) > R * 1.3) return;
  sfx.init();
  P.squashV += 6;
  P.hopV = -R * 2.5;
  S.boop();
  for (let i = 0; i < 4; i++) emit('heart', e.clientX, e.clientY, { vx: (Math.random() - 0.5) * 120, vy: -80 - Math.random() * 60, max: 1.4, size: 0.7 + Math.random() * 0.4 });
  emit('text', e.clientX, e.clientY - R * 0.4, { text: 'boop', vy: -50, max: 1.2, size: 0.9 });
});

setupToggle($('btn-mirror'), true, (v) => mirror.classList.toggle('hidden', !v));
setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
const guideToggle = setupToggle($('btn-guide'), true, (v) => guide.classList.toggle('hidden', !v));
$('guide-hide').addEventListener('click', () => guideToggle.set(false));

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Waking Pip…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new Tracker(video, { hands: false });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    S.happy();
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Face tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

// testing hook: window.pet.simulate({ smileL: 1, smileR: 1, jaw: 0.5 }) drives Pip without a camera
window.pet = {
  rig, target, P, E,
  get found() { return found; },
  get swap() { return { evidence: swapEvidence, swapped }; },
  simulate(v) { sim = { ...v }; },
  stopSimulating() { sim = null; },
};
