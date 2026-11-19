// MIRROR PET: Pip copies your face and reacts to it.
// Face tracking: MediaPipe Face Landmarker (on-device). Sound: Web Audio.

import { Tracker } from './tracking.js?v=6';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, Sfx, setupToggle } from './shared.js?v=6';

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
  R = Math.min(W, H) * 0.19;
  CX = W / 2;
  BASE = H * 0.78;
}
window.addEventListener('resize', resize);
resize();

const sfx = new Sfx();
let tracker = null;
let sim = null; // test hook: replaces the tracker's signals

// ======================================================================
// Reading the face
// ======================================================================
const eyeBase = { L: 0, R: 0 };
const face = {
  found: false, smile: 0, brow: 0, mouth: 0, angry: 0, sad: 0, roll: 0, yaw: 0, pitch: 0, fx: 0, fy: 0,
  eyeL: 0, eyeR: 0, pucker: 0, puff: 0,
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// per-eye closure from the landmarks; the pet's screen-left eye mirrors your left eye
function eyeClosure(lm, side) {
  const [o, i, t, b] = side === 'L' ? [263, 362, 386, 374] : [33, 133, 159, 145];
  const v = dist(lm[t], lm[b]) / (dist(lm[o], lm[i]) || 1);
  if (!eyeBase[side]) eyeBase[side] = v;
  if (v > eyeBase[side] * 0.8) eyeBase[side] += (v - eyeBase[side]) * 0.03;
  return clamp01((eyeBase[side] * 0.85 - v) / (eyeBase[side] * 0.5));
}

function readFace(dt, now) {
  if (sim) { Object.assign(face, sim); return; }
  if (!tracker) { face.found = false; return; }
  const s = tracker.update(now, dt);
  face.found = s.faceFound;
  for (const k of ['smile', 'brow', 'mouth', 'angry', 'sad', 'roll', 'yaw', 'pitch', 'fx', 'fy']) face[k] = s[k];
  const lm = tracker.lastFace;
  const bs = tracker.lastBlend || {};
  const k = ease(dt, 0.04);
  if (lm && s.faceFound) {
    face.eyeL += (eyeClosure(lm, 'L') - face.eyeL) * k;
    face.eyeR += (eyeClosure(lm, 'R') - face.eyeR) * k;
    // fold in the blink blendshapes when both eyes close together
    const both = Math.min(bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0);
    if (both > 0.5) { face.eyeL = Math.max(face.eyeL, both); face.eyeR = Math.max(face.eyeR, both); }
    face.pucker += (clamp01(((bs.mouthPucker ?? 0) - 0.35) / 0.45) * (1 - face.smile) - face.pucker) * ease(dt, 0.12);
    face.puff += (clamp01(((bs.cheekPuff ?? 0) - 0.2) / 0.45) - face.puff) * ease(dt, 0.12);
  } else {
    face.eyeL += (0 - face.eyeL) * k;
    face.eyeR += (0 - face.eyeR) * k;
    face.pucker *= Math.exp(-dt / 0.2);
    face.puff *= Math.exp(-dt / 0.2);
  }
}

// ======================================================================
// Pip's state
// ======================================================================
const P = {
  roll: 0, lookX: 0, lookY: 0, eyeL: 1, eyeR: 1, mouth: 0, smile: 0, sad: 0, angry: 0, brow: 0, pucker: 0, puff: 0,
  ear: 0, earV: 0, earWig: 0, squash: 0, squashV: 0, hop: 0, hopV: 0, shake: 0, blush: 0, sleep: 0, surprise: 0,
  awayFor: 0, seenFor: 0, gloom: 0, wink: { side: null, t: 0 }, lastBlinkL: 0, lastBlinkR: 0, hue: 0,
};
const cool = {}; // reaction cooldowns
const ready = (k, now, ms) => { if ((cool[k] || 0) > now) return false; cool[k] = now + ms; return true; };
let parts = [];
function emit(type, x, y, o = {}) { parts.push({ type, x, y, vx: o.vx ?? 0, vy: o.vy ?? -40, life: 0, max: o.max ?? 1.5, text: o.text, size: o.size ?? 1, color: o.color, spin: Math.random() * 6 }); }

// sounds
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
  const f = face;
  const k = (tau) => ease(dt, tau);

  // presence: look for you, then doze off
  if (f.found) { P.awayFor = 0; P.seenFor += dt; } else { P.awayFor += dt; P.seenFor = 0; }
  const wantSleep = P.awayFor > 7 ? 1 : 0;
  if (P.sleep > 0.6 && f.found && P.seenFor > 0.3) {
    // waking up
    if (ready('wake', now, 4000)) { S.yawn(); emit('text', CX, BASE - R * 2.5, { text: '!', vy: -50, max: 1, size: 1.4 }); P.hopV = -R * 3; }
  }
  P.sleep += (wantSleep - P.sleep) * k(wantSleep ? 1.2 : 0.3);

  const live = f.found ? 1 : 0;
  // mirror pose
  P.roll += ((f.found ? f.roll * 0.9 : Math.sin(t * 0.7) * 0.12 * (1 - P.sleep)) - P.roll) * k(0.12);
  const lx = f.found ? -f.yaw * 1.1 + f.fx * 0.25 : Math.sin(t * 0.9) * 0.7 * (1 - P.sleep);
  const ly = f.found ? f.pitch * 0.8 - f.fy * 0.15 : 0.1;
  P.lookX += (clamp(lx, -1, 1) - P.lookX) * k(0.1);
  P.lookY += (clamp(ly, -1, 1) - P.lookY) * k(0.1);

  // eyes copy yours, one by one (so winks come through)
  const openL = 1 - (f.found ? f.eyeL : 0), openR = 1 - (f.found ? f.eyeR : 0);
  P.eyeL += (Math.min(openL, 1 - P.sleep) - P.eyeL) * k(0.035);
  P.eyeR += (Math.min(openR, 1 - P.sleep) - P.eyeR) * k(0.035);

  for (const key of ['smile', 'sad', 'angry', 'brow', 'pucker', 'puff']) P[key] += ((f[key] || 0) * live - P[key]) * k(0.12);
  P.mouth += ((f.mouth || 0) * live - P.mouth) * k(0.06);
  P.surprise += ((live && f.brow > 0.45 && f.mouth > 0.35 ? 1 : 0) - P.surprise) * k(0.1);
  P.blush += (Math.max(P.smile, P.pucker, P.angry * 0.8) - P.blush) * k(0.3);

  // ---- reactions ----
  const cx = CX, top = BASE - R * 2.1;
  if (f.found && P.sleep < 0.3) {
    // wink: one eye shut, the other open
    const wl = f.eyeL > 0.55 && f.eyeR < 0.25, wr = f.eyeR > 0.55 && f.eyeL < 0.25;
    if (wl || wr) {
      P.wink.t += dt;
      if (P.wink.t > 0.12 && ready('wink', now, 1200)) {
        const ex = cx + (wl ? -1 : 1) * R * 0.38;
        for (let i = 0; i < 6; i++) emit('star', ex + (wl ? -1 : 1) * R * 0.3, BASE - R * 1.15, { vx: (Math.random() - 0.5) * 120 + (wl ? -60 : 60), vy: -80 - Math.random() * 80, max: 1.1, size: 0.7 + Math.random() * 0.6 });
        S.ding();
      }
    } else P.wink.t = 0;

    if (P.smile > 0.55) {
      if (ready('giggle', now, f.mouth > 0.35 ? 1400 : 3200)) { S.giggle(); P.hopV = -R * (f.mouth > 0.35 ? 3.5 : 2.2); if (f.mouth > 0.35) emit('text', cx + R * 1.1, top + R * 0.3, { text: 'hehe', vx: 30, vy: -40, max: 1.3 }); }
      if (Math.random() < dt * 2.5 * P.smile) emit('heart', cx + (Math.random() - 0.5) * R * 2.2, top + R * 0.4, { vx: (Math.random() - 0.5) * 40, vy: -70, max: 2, size: 0.7 + Math.random() * 0.5, color: '238,160,176' });
    }
    if (P.surprise > 0.6 && ready('oh', now, 2500)) {
      S.oh();
      P.hopV = -R * 3.8;
      emit('text', cx, top - R * 0.1, { text: '!', vy: -60, max: 1, size: 1.6 });
    }
    if (P.angry > 0.4) {
      if (ready('grumble', now, 3000)) S.grumble();
      if (Math.random() < dt * 6 * P.angry) {
        const side = Math.random() < 0.5 ? -1 : 1;
        emit('steam', cx + side * R * 0.75, top + R * 0.35, { vx: side * 50, vy: -90, max: 1.1 });
      }
      P.shake = P.angry;
    } else P.shake = 0;
    if (P.sad > 0.35) {
      if (ready('sniffle', now, 4500)) S.sniffle();
      if (Math.random() < dt * 2.5 * P.sad) {
        const side = Math.random() < 0.5 ? -1 : 1;
        emit('tear', cx + side * R * 0.38 + P.lookX * R * 0.15, BASE - R * 0.95, { vx: side * 6, vy: 30, max: 1.4 });
      }
    }
    P.gloom += ((P.sad > 0.5 ? 1 : 0) - P.gloom) * k(P.sad > 0.5 ? 1.2 : 0.6);
    if (P.pucker > 0.5 && ready('mwah', now, 900)) {
      S.mwah();
      for (let i = 0; i < 3; i++) emit('heart', cx + (Math.random() - 0.5) * R * 0.5, BASE - R * 0.8, { vx: (Math.random() - 0.5) * 80, vy: -90 - Math.random() * 40, max: 1.8, size: 0.9 + Math.random() * 0.6, color: '232,120,150' });
    }
    if (P.puff > 0.5) cool.puffed = true;
    if (cool.puffed && P.puff < 0.2) {
      cool.puffed = false;
      S.pfff();
      for (let i = 0; i < 8; i++) emit('puff', cx + R * 0.1, BASE - R * 0.75, { vx: 60 + Math.random() * 120, vy: (Math.random() - 0.5) * 60, max: 0.8 });
    }
  } else P.gloom *= Math.exp(-dt / 0.6);
  if (P.sleep > 0.7 && Math.random() < dt * 0.8) emit('text', cx + R * 0.7, top + R * 0.2, { text: 'z', vx: 25, vy: -35, max: 2.2, size: 0.8 + Math.random() * 0.5 });
  if (!f.found && P.awayFor > 1 && P.awayFor < 6 && ready('where', now, 3500)) emit('text', cx + R * 1.0, top + R * 0.2, { text: '?', vy: -30, max: 1.6, size: 1.2 });

  // ears: perk with brows and surprise, droop with sadness or sleep, wiggle when happy
  const earT = clamp(0.2 + P.brow * 0.8 + P.surprise * 0.5 - P.sad * 1.2 - P.sleep * 0.9 - P.angry * 0.4, -1, 1);
  P.earV += ((earT - P.ear) * 90 - P.earV * 9) * dt;
  P.ear += P.earV * dt;
  P.earWig = Math.sin(t * 9) * 0.12 * P.smile;

  // body: springy squash and little hops
  P.hopV += 2600 * (R / 120) * dt;
  P.hop += P.hopV * dt;
  if (P.hop > 0) { if (P.hopV > R * 0.8) P.squashV += P.hopV * 0.004; P.hop = 0; P.hopV = 0; }
  P.squashV += (-P.squash * 160 - P.squashV * 10) * dt;
  P.squash += P.squashV * dt;
  P.hue += ((P.angry * 1 - P.sad * 0.6) - P.hue) * k(0.4);
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
  // soft bokeh blobs in the palette
  const blobs = [[0.15, 0.25, 0.22, '207,195,234'], [0.85, 0.3, 0.2, '242,205,212'], [0.72, 0.12, 0.12, '246,226,160'], [0.3, 0.6, 0.16, '190,210,180']];
  for (const [bx, by, br, c] of blobs) {
    const x = bx * W + Math.sin(t * 0.2 + bx * 9) * 20, y = by * H + Math.cos(t * 0.17 + by * 7) * 16;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, br * Math.max(W, H));
    rg.addColorStop(0, `rgba(${c},0.45)`);
    rg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
  // floor
  ctx.fillStyle = 'rgba(160,150,120,0.12)';
  ctx.beginPath();
  ctx.ellipse(CX, BASE + R * 0.35, W * 0.7, R * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  // mood light
  if (P.gloom > 0.02) { ctx.fillStyle = `rgba(110,125,150,${P.gloom * 0.18})`; ctx.fillRect(0, 0, W, H); }
  if (P.smile > 0.02) { ctx.fillStyle = `rgba(250,225,150,${P.smile * 0.12})`; ctx.fillRect(0, 0, W, H); }
  if (P.angry > 0.02) { ctx.fillStyle = `rgba(230,140,130,${P.angry * 0.12})`; ctx.fillRect(0, 0, W, H); }
  for (const m of motes) {
    const x = ((m.x + t * 0.01 * m.s) % 1) * W, y = ((m.y - t * 0.012 * m.s + 1) % 1) * H;
    ctx.fillStyle = `rgba(255,252,240,${0.35 + Math.sin(t + m.p) * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, m.r, 0, Math.PI * 2); ctx.fill();
  }
}

const BODY = ['#fbe6e8', '#f2c9d0', '#e3aab6'];
function fluffyPath(r, wob, t) {
  ctx.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const rr = r * (1 + 0.016 * Math.sin(a * 13 + t * 1.5) + wob * Math.sin(a * 3 + t * 6));
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function drawEar(side, t) {
  const droop = P.ear; // -1 droop .. 1 perked
  const base = side * 0.5 + side * P.angry * 0.35;
  const ang = side * (0.35 - droop * 0.25 + P.angry * 0.9 + P.sleep * 0.6) + P.earWig * side;
  ctx.save();
  ctx.translate(side * R * 0.45, -R * 0.78);
  ctx.rotate(ang + (droop < 0 ? side * -droop * 1.1 : 0));
  const len = R * (0.95 + droop * 0.12);
  ctx.fillStyle = '#d7cbef';
  ctx.beginPath();
  ctx.ellipse(0, -len * 0.5, R * 0.2, len * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2c3cf';
  ctx.beginPath();
  ctx.ellipse(0, -len * 0.48, R * 0.1, len * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return base;
}

function drawEye(side, open, t) {
  const ex = side * R * 0.37, ey = -R * 0.12;
  const rx = R * 0.13 * (1 + P.surprise * 0.12), ry = R * 0.17 * (1 + P.brow * 0.12 + P.surprise * 0.2);
  // happy squint when smiling hard
  const squint = clamp01((P.smile - 0.55) / 0.35);
  const o = clamp01(open) * (1 - squint * 0.75);
  ctx.save();
  ctx.translate(ex, ey);
  if (o < 0.2) {
    // closed: a gentle arc (smiling ^ or sleepy ‿)
    ctx.strokeStyle = '#3a3242';
    ctx.lineWidth = R * 0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (squint > 0.3) { ctx.moveTo(-rx, ry * 0.15); ctx.quadraticCurveTo(0, -ry * 0.7, rx, ry * 0.15); }
    else { ctx.moveTo(-rx, 0); ctx.quadraticCurveTo(0, ry * 0.5, rx, 0); }
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, ry * (1 - o) * 0.6, rx, ry * o, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#2f2a36';
  ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  const px = P.lookX * rx * 0.35, py = P.lookY * ry * 0.3;
  ctx.fillStyle = '#4a3f5c';
  ctx.beginPath(); ctx.ellipse(px, py + ry * 0.25, rx * 0.7, ry * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  const shine = P.sad > 0.3 ? 1.35 : 1;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(px - rx * 0.32, py - ry * 0.38, rx * 0.34 * shine, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(px + rx * 0.32, py + ry * 0.3, rx * 0.15 * shine, 0, Math.PI * 2); ctx.fill();
  if (P.sad > 0.3) { ctx.fillStyle = `rgba(170,200,235,${P.sad * 0.6})`; ctx.beginPath(); ctx.ellipse(0, ry * 0.75, rx, ry * 0.3, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  ctx.restore();
}

function drawBrow(side) {
  const ex = side * R * 0.37, ey = -R * 0.4 - P.brow * R * 0.1 - P.surprise * R * 0.06 + P.angry * R * 0.06;
  // angry: inner ends down; sad: inner ends up
  const tilt = -side * (P.angry * 0.5 - P.sad * 0.45);
  ctx.save();
  ctx.translate(ex, ey);
  ctx.rotate(tilt);
  ctx.strokeStyle = 'rgba(120,96,140,0.75)';
  ctx.lineWidth = R * 0.05;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-R * 0.1, R * 0.01);
  ctx.quadraticCurveTo(0, -R * 0.03, R * 0.1, R * 0.01);
  ctx.stroke();
  ctx.restore();
}

function drawMouth(t) {
  const my = R * 0.24;
  ctx.save();
  ctx.translate(P.lookX * R * 0.05, my);
  ctx.strokeStyle = '#3a3242';
  ctx.fillStyle = '#4a2c3a';
  ctx.lineCap = 'round';
  ctx.lineWidth = R * 0.04;
  const curve = clamp(P.smile * 1.1 - P.sad * 0.9 - P.angry * 0.6, -1, 1);
  if (P.pucker > 0.45 && P.mouth < 0.4) {
    // little kissy "o"
    ctx.strokeStyle = '#c4627b';
    ctx.lineWidth = R * 0.05;
    ctx.beginPath(); ctx.ellipse(R * 0.02, 0, R * 0.055, R * 0.07, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (P.mouth > 0.12) {
    const w = R * (0.13 + P.smile * 0.1 + P.surprise * 0.02);
    const h = R * (0.05 + P.mouth * 0.22);
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.quadraticCurveTo(0, -curve * R * 0.06, w, 0);
    ctx.quadraticCurveTo(w * 0.9, h * 1.6, 0, h * 1.6);
    ctx.quadraticCurveTo(-w * 0.9, h * 1.6, -w, 0);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#e88a9c';
    ctx.beginPath(); ctx.ellipse(0, h * 1.6, w * 0.65, h * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else {
    // closed mouth: a little cat-like curve that smiles or frowns
    const w = R * (0.1 + P.smile * 0.08);
    const c = curve * R * 0.09;
    ctx.beginPath();
    ctx.moveTo(-w, -c * 0.3);
    ctx.quadraticCurveTo(-w * 0.5, c, 0, 0);
    ctx.quadraticCurveTo(w * 0.5, c, w, -c * 0.3);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPip(t) {
  const breathe = 1 + Math.sin(t * (P.sleep > 0.5 ? 1.4 : 2.2)) * (0.012 + P.sleep * 0.015);
  const puff = 1 + P.puff * 0.28;
  const sq = clamp(P.squash, -0.25, 0.25);
  const shakeX = P.shake > 0.3 ? Math.sin(t * 50) * R * 0.02 * P.shake : 0;
  const bodyY = BASE - R * 0.95 + P.hop;

  // ground shadow
  ctx.fillStyle = `rgba(80,90,70,${0.18 * (1 + P.hop / (R * 2))})`;
  ctx.beginPath(); ctx.ellipse(CX, BASE + R * 0.02, R * 0.85 * puff * (1 + P.hop / (R * 6)), R * 0.14, 0, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.translate(CX + shakeX, bodyY);
  ctx.rotate(P.roll);
  ctx.scale(breathe * puff * (1 + sq), breathe * puff * (1 - sq));
  // feet
  ctx.fillStyle = BODY[2];
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * R * 0.42, R * 0.9, R * 0.22, R * 0.12, 0, 0, Math.PI * 2); ctx.fill(); }
  // ears behind the head
  drawEar(-1, t);
  drawEar(1, t);
  // body
  const g = ctx.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.1, 0, 0, R * 1.05);
  g.addColorStop(0, BODY[0]);
  g.addColorStop(0.6, BODY[1]);
  g.addColorStop(1, BODY[2]);
  ctx.fillStyle = g;
  fluffyPath(R, P.shake * 0.01, t);
  ctx.fill();
  // mood tint: rosy when cross, cool when sad
  if (P.hue > 0.03) { ctx.fillStyle = `rgba(232,96,96,${P.hue * 0.35})`; fluffyPath(R, 0, t); ctx.fill(); }
  if (P.hue < -0.03) { ctx.fillStyle = `rgba(130,160,210,${-P.hue * 0.35})`; fluffyPath(R, 0, t); ctx.fill(); }
  // belly
  ctx.fillStyle = 'rgba(255,250,240,0.7)';
  ctx.beginPath(); ctx.ellipse(0, R * 0.45, R * 0.55, R * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // face turns with yours
  ctx.save();
  ctx.translate(P.lookX * R * 0.2, P.lookY * R * 0.12);
  // cheeks
  ctx.fillStyle = `rgba(240,140,160,${0.25 + P.blush * 0.45})`;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * R * 0.58, R * 0.12, R * 0.14 * (1 + P.puff * 0.4), R * 0.08 * (1 + P.puff * 0.4), 0, 0, Math.PI * 2); ctx.fill(); }
  drawEye(-1, P.eyeL, t);
  drawEye(1, P.eyeR, t);
  drawBrow(-1);
  drawBrow(1);
  // nose
  ctx.fillStyle = '#b86f83';
  ctx.beginPath(); ctx.moveTo(-R * 0.045, R * 0.08); ctx.lineTo(R * 0.045, R * 0.08); ctx.lineTo(0, R * 0.13); ctx.closePath(); ctx.fill();
  drawMouth(t);
  // anger mark
  if (P.angry > 0.35) {
    ctx.save();
    ctx.translate(R * 0.55, -R * 0.62);
    ctx.strokeStyle = `rgba(214,70,80,${P.angry})`;
    ctx.lineWidth = R * 0.035;
    ctx.lineCap = 'round';
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.moveTo(a * R * 0.03, b * R * 0.09); ctx.quadraticCurveTo(a * R * 0.03, b * R * 0.03, a * R * 0.09, b * R * 0.03); ctx.stroke(); }
    ctx.restore();
  }
  ctx.restore();
  ctx.restore();

  // a small rain cloud when Pip is really sad
  if (P.gloom > 0.05) {
    const cx = CX + Math.sin(t * 0.8) * R * 0.15, cy = BASE - R * 2.75;
    ctx.save();
    ctx.globalAlpha = P.gloom;
    ctx.fillStyle = '#b8c0cc';
    for (const [dx, dy, r] of [[-0.35, 0.05, 0.25], [0, -0.1, 0.32], [0.35, 0.05, 0.24], [0.1, 0.12, 0.25], [-0.15, 0.12, 0.22]]) { ctx.beginPath(); ctx.arc(cx + dx * R, cy + dy * R, r * R, 0, Math.PI * 2); ctx.fill(); }
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
      for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.42 : s; const ang = (i / 10) * Math.PI * 2; ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); }
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
  if (P.sleep > 0.6) return 'sleepy';
  if (!face.found) return P.awayFor > 1 ? 'where did you go?' : '';
  if (P.wink.t > 0.1) return 'winking';
  if (P.surprise > 0.55) return 'surprised!';
  if (P.puff > 0.45) return 'puffed up';
  if (P.pucker > 0.45) return 'kissy';
  if (P.angry > 0.4) return 'grumpy';
  if (P.sad > 0.4) return 'sad';
  if (P.smile > 0.55) return P.mouth > 0.35 ? 'giggly' : 'happy';
  if (P.smile > 0.25) return 'content';
  if (P.mouth > 0.4) return 'ahh';
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
      setStatus(face.found ? 'active' : 'searching', face.found ? 'Pip can see you' : 'looking for your face');
      hint.textContent = face.found ? '' : 'Look at the camera so Pip can see you.';
    }
  }
}
requestAnimationFrame(frame);

canvas.addEventListener('pointerdown', (e) => {
  const dx = e.clientX - CX, dy = e.clientY - (BASE - R * 0.95);
  if (Math.hypot(dx, dy) > R * 1.2) return;
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

// testing hook: window.pet.simulate({ smile: 1 }) drives Pip without a camera
window.pet = {
  P, face,
  simulate(v) { sim = { found: true, smile: 0, brow: 0, mouth: 0, angry: 0, sad: 0, roll: 0, yaw: 0, pitch: 0, fx: 0, fy: 0, eyeL: 0, eyeR: 0, pucker: 0, puff: 0, ...v }; },
  stopSimulating() { sim = null; },
};
