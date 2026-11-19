// SHADOWS: hand shadow puppets that come alive.
// Make a dog, rabbit, cat or bird with your hands and hold it; the animal jumps off
// your hand onto the wall and then plays with your hand: it follows, sniffs, jumps,
// gets petted, startles, and birds perch on a still finger.
// Hand tracking: MediaPipe Hand Landmarker, on-device. Sound: Web Audio.

import { Tracker } from './tracking.js?v=6';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, toScreen, Sfx, setupToggle } from './shared.js?v=6';

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

// the shadow layer is drawn at reduced resolution, then scaled up softly: free penumbra
const sh = document.createElement('canvas');
const sx = sh.getContext('2d');
const gcv = document.createElement('canvas'); // ghost of an animal taking shape
const gx = gcv.getContext('2d');
const bg = document.createElement('canvas');
const bx = bg.getContext('2d');
const SH_SCALE = 0.5;
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
  sh.width = Math.round(W * SH_SCALE * DPR);
  sh.height = Math.round(H * SH_SCALE * DPR);
  sx.setTransform(SH_SCALE * DPR, 0, 0, SH_SCALE * DPR, 0, 0);
  gcv.width = sh.width;
  gcv.height = sh.height;
  gx.setTransform(SH_SCALE * DPR, 0, 0, SH_SCALE * DPR, 0, 0);
  paintWall();
}

// the wall: warm lamp light, a little paper grain, a floor where the animals walk
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
  // floor
  const f = bx.createLinearGradient(0, GY, 0, H);
  f.addColorStop(0, 'rgba(120,92,64,0.28)');
  f.addColorStop(1, 'rgba(70,52,38,0.55)');
  bx.fillStyle = f;
  bx.fillRect(0, GY, W, H - GY);
  bx.strokeStyle = 'rgba(90,68,48,0.35)';
  bx.lineWidth = 1.5;
  bx.beginPath(); bx.moveTo(0, GY + 0.5); bx.lineTo(W, GY + 0.5); bx.stroke();
  // grain
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
// Hands
// ======================================================================
let hands = [];
let nextHandId = 1;
let lastHandsRef = null;
let fakeHands = null; // test hook

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
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
  f.count = f.I + f.M + f.R + f.P;
  let pose = null;
  if (f.I && f.M && f.fR && f.fP) pose = 'rabbit';
  else if (f.I && f.P && f.fM && f.fR) pose = 'dog';
  else if (f.thumbOut && f.P && f.fI && f.fM && f.fR) pose = 'cat';
  const palm = { x: 0, y: 0 };
  for (const i of [0, 5, 9, 13, 17]) { palm.x += raw[i].x / 5; palm.y += raw[i].y / 5; }
  let top = raw[0];
  for (const p of raw) if (p.y < top.y) top = p;
  return { raw, size, f, pose, palm, top, open: clamp01((f.count - 1) / 3) };
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
      let best = null, bd = Infinity;
      for (const h of hands) {
        if (next.includes(h)) continue;
        const d = d2(h.palm, f.palm);
        if (d < bd) { bd = d; best = h; }
      }
      if (best && bd < 300 * U) {
        const fdt = Math.max((now - best.t) / 1000, 1 / 120);
        const vx = (f.palm.x - best.palm.x) / fdt, vy = (f.palm.y - best.palm.y) / fdt;
        best.vx += (vx - best.vx) * ease(fdt, 0.08);
        best.vy += (vy - best.vy) * ease(fdt, 0.08);
        Object.assign(best, f, { t: now });
        next.push(best);
      } else {
        next.push({ id: nextHandId++, ...f, pts: f.raw.map((p) => ({ ...p })), vx: 0, vy: 0, t: now, born: now, poseName: null, poseT: 0, spent: false });
      }
    }
    hands = next;
  } else {
    if (!fakeHands) hands = hands.filter((h) => now - h.t < 600);
  }
  const k = ease(dt, 0.04);
  for (const h of hands) {
    for (let i = 0; i < 21; i++) { h.pts[i].x += (h.raw[i].x - h.pts[i].x) * k; h.pts[i].y += (h.raw[i].y - h.pts[i].y) * k; }
    h.speed = Math.hypot(h.vx, h.vy);
    h.age = (now - h.born) / 1000;
  }
}

function drawHandShadow(c, h) {
  const p = h.pts, s = h.size;
  c.fillStyle = SHADOW;
  c.strokeStyle = SHADOW;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  // forearm, reaching back from the wrist
  const ax = p[0].x - p[9].x, ay = p[0].y - p[9].y;
  const al = Math.hypot(ax, ay) || 1;
  const ux = ax / al, uy = ay / al, nx = -uy, ny = ux;
  const far = { x: p[0].x + ux * s * 3, y: p[0].y + uy * s * 3 };
  c.beginPath();
  c.moveTo(p[0].x + nx * s * 0.42, p[0].y + ny * s * 0.42);
  c.lineTo(far.x + nx * s * 0.55, far.y + ny * s * 0.55);
  c.lineTo(far.x - nx * s * 0.55, far.y - ny * s * 0.55);
  c.lineTo(p[0].x - nx * s * 0.42, p[0].y - ny * s * 0.42);
  c.closePath();
  c.fill();
  // palm
  c.beginPath();
  for (const [j, i] of [0, 1, 2, 5, 9, 13, 17].entries()) j ? c.lineTo(p[i].x, p[i].y) : c.moveTo(p[i].x, p[i].y);
  c.closePath();
  c.fill();
  c.lineWidth = s * 0.3;
  c.stroke();
  // fingers, tapering towards the tips
  FINGERS.forEach((chain, fi) => {
    for (let j = 0; j < 3; j++) {
      const a = p[chain[j]], b = p[chain[j + 1]];
      c.lineWidth = s * (fi === 0 ? 0.3 : 0.26) * (1 - j * 0.12);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
  });
}

// ======================================================================
// Silhouettes. Unit space: facing right, origin on the ground under the body.
// ======================================================================
function ell(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, Math.max(rx, 0.001), Math.max(ry, 0.001), rot, 0, Math.PI * 2); c.fill(); }
function seg(c, x0, y0, x1, y1, w) { c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
function leg(c, hx, hy, fx, fy, knee, w) {
  const mx = (hx + fx) / 2 + knee, my = (hy + fy) / 2;
  c.lineWidth = w;
  c.beginPath(); c.moveTo(hx, hy); c.lineTo(mx, my); c.lineTo(fx, fy); c.stroke();
  ell(c, fx + 0.025, fy - w * 0.3, w * 0.75, w * 0.45);
}

function drawDog(c, a, t) {
  const sit = a.sit, ph = a.phase, st = a.stride;
  const lift = (o) => Math.max(0, Math.cos(ph + o)) * 0.07 * st;
  const sw = (o) => Math.sin(ph + o) * 0.16 * st;
  const hip = { x: -0.3 + sit * 0.08, y: -0.52 + sit * 0.3 + a.crouch * 0.08 };
  const sho = { x: 0.24, y: -0.58 + a.crouch * 0.06 };
  // tail
  const ta = -0.6 - a.tail;
  c.lineWidth = 0.075;
  c.beginPath();
  c.moveTo(hip.x - 0.12, hip.y - 0.06);
  c.quadraticCurveTo(hip.x - 0.3, hip.y - 0.1, hip.x - 0.12 - Math.cos(ta) * 0.36, hip.y - 0.06 + Math.sin(ta) * 0.36);
  c.stroke();
  // far legs first (they share the silhouette anyway)
  if (sit < 0.5) {
    leg(c, hip.x, hip.y + 0.05, hip.x + sw(Math.PI), -lift(Math.PI), -0.07, 0.085);
    leg(c, sho.x, sho.y + 0.05, sho.x + 0.02 + sw(0), -lift(0), 0.03, 0.075);
  }
  leg(c, sho.x + 0.05, sho.y + 0.05, sho.x + 0.07 + sw(Math.PI), -lift(Math.PI), 0.03, 0.075);
  if (sit > 0.5) {
    // folded hind leg
    ell(c, hip.x + 0.06, -0.12, 0.2, 0.12, -0.2);
    ell(c, hip.x + 0.16, -0.03, 0.12, 0.035);
  } else leg(c, hip.x + 0.04, hip.y + 0.05, hip.x + 0.04 + sw(0), -lift(0), -0.07, 0.085);
  // body
  c.lineWidth = 0.34;
  c.beginPath(); c.moveTo(hip.x, hip.y); c.lineTo(sho.x, sho.y); c.stroke();
  ell(c, hip.x, hip.y, 0.2, 0.19);
  ell(c, sho.x + 0.03, sho.y - 0.01, 0.2, 0.21);
  // neck and head
  const nb = { x: sho.x + 0.12, y: sho.y - 0.08 };
  const hx = nb.x + 0.16 + a.reach * 0.12, hy = sho.y - 0.36 + a.crouch * 0.05 + a.reach * 0.1;
  seg(c, nb.x, nb.y, hx, hy, 0.17);
  c.save();
  c.translate(hx, hy);
  c.rotate(a.head);
  ell(c, 0.02, 0, 0.15, 0.13);
  ell(c, 0.19, 0.035, 0.13, 0.065);
  // lower jaw opens when barking
  c.save(); c.translate(0.08, 0.06); c.rotate(a.jaw * 0.55); ell(c, 0.1, 0.01, 0.12, 0.04); c.restore();
  ell(c, 0.315, 0.0, 0.035, 0.032);
  // ear: floppy to perked
  const et = { x: lerp(-0.13, -0.05, a.ear), y: lerp(0.12, -0.3, a.ear) };
  c.beginPath(); c.moveTo(-0.08, -0.09); c.lineTo(et.x, et.y); c.lineTo(0.04, -0.1); c.closePath(); c.fill();
  c.lineWidth = 0.05; c.stroke();
  c.restore();
}

function drawRabbit(c, a, t) {
  const air = a.air ? 1 : 0;
  c.save();
  c.translate(0, -0.3);
  c.scale(1 + air * 0.12, 1 - air * 0.08);
  c.translate(0, 0.3);
  // hind feet stretch out when hopping
  if (air) ell(c, -0.32, -0.12, 0.2, 0.05, 0.4);
  else ell(c, -0.07, -0.035, 0.21, 0.045);
  ell(c, -0.12, -0.27 - a.crouch * 0.02, 0.26, 0.25); // haunch
  ell(c, 0.07, -0.3, 0.24, 0.2 - a.crouch * 0.03); // body
  ell(c, -0.38, -0.34, 0.075, 0.075); // tail
  ell(c, air ? 0.36 : 0.24, air ? -0.18 : -0.04, 0.06, 0.04); // front paw
  // head and ears
  const hx = 0.28 + a.reach * 0.08, hy = -0.53 + a.crouch * 0.1 + a.reach * 0.08;
  c.save();
  c.translate(hx, hy);
  c.rotate(a.head * 0.6);
  ell(c, 0, 0, 0.15, 0.125);
  ell(c, 0.12, 0.04 + Math.sin(t * 30) * 0.004 * a.sniff, 0.075, 0.065);
  const back = a.earBack;
  ell(c, -0.06, -0.2 + back * 0.12, 0.055, 0.2, -0.25 - back * 0.95);
  ell(c, 0.01, -0.21 + back * 0.12, 0.05, 0.19, -0.05 - back * 1.0 + Math.sin(t * 2) * 0.05);
  c.restore();
  c.restore();
}

function drawCat(c, a, t) {
  const sit = a.sit, ph = a.phase, st = a.stride;
  const lift = (o) => Math.max(0, Math.cos(ph + o)) * 0.06 * st;
  const sw = (o) => Math.sin(ph + o) * 0.14 * st;
  const hip = { x: lerp(-0.32, -0.12, sit), y: lerp(-0.5, -0.17, sit) };
  const sho = { x: lerp(0.24, 0.16, sit), y: lerp(-0.52, -0.58, sit) + a.crouch * 0.06 };
  // tail: long S-curve; up and curled when happy
  const sway = Math.sin(t * (a.happy > 0.3 ? 2.4 : 1.4)) * 0.1;
  c.lineWidth = 0.06;
  c.beginPath();
  c.moveTo(hip.x - 0.06, hip.y - 0.04);
  if (sit > 0.5) {
    c.bezierCurveTo(hip.x - 0.3, hip.y + 0.15, hip.x + 0.1, -0.02, hip.x + 0.3 + sway * 0.4, -0.04);
  } else {
    const up = a.happy;
    c.bezierCurveTo(hip.x - 0.3, hip.y + 0.05 - up * 0.2, hip.x - 0.32 + sway, hip.y - 0.35 - up * 0.25, hip.x - 0.18 + sway * 1.5, hip.y - 0.48 - up * 0.2);
  }
  c.stroke();
  if (sit < 0.5) {
    leg(c, hip.x, hip.y, hip.x + sw(Math.PI), -lift(Math.PI), -0.06, 0.06);
    leg(c, hip.x + 0.05, hip.y, hip.x + 0.05 + sw(0), -lift(0), -0.06, 0.065);
  } else {
    ell(c, hip.x + 0.05, -0.12, 0.2, 0.13, -0.3);
    ell(c, hip.x + 0.15, -0.025, 0.11, 0.03);
  }
  leg(c, sho.x, sho.y, sho.x + 0.02 + sw(0), -lift(0), 0.02, 0.055);
  // front paw: swats when your fingertip comes close
  if (a.swat > 0.05) seg(c, sho.x + 0.04, sho.y, sho.x + 0.2 + a.swat * 0.15, sho.y - 0.18 - a.swat * 0.22, 0.055);
  else leg(c, sho.x + 0.05, sho.y, sho.x + 0.07 + sw(Math.PI), -lift(Math.PI), 0.02, 0.06);
  // body, arched when rubbing against your hand
  c.lineWidth = 0.25;
  c.beginPath();
  c.moveTo(hip.x, hip.y);
  c.quadraticCurveTo((hip.x + sho.x) / 2, (hip.y + sho.y) / 2 - 0.04 - a.arch * 0.2, sho.x, sho.y);
  c.stroke();
  ell(c, hip.x, hip.y, 0.13, 0.13);
  ell(c, sho.x, sho.y, 0.13, 0.14);
  // head
  const hx = sho.x + 0.16 + a.reach * 0.08, hy = sho.y - 0.22 + a.reach * 0.06;
  seg(c, sho.x + 0.04, sho.y - 0.04, hx, hy, 0.12);
  c.save();
  c.translate(hx, hy);
  c.rotate(a.head * 0.7);
  ell(c, 0, 0, 0.12, 0.11);
  ell(c, 0.11, 0.035, 0.065, 0.05);
  for (const ex of [-0.07, 0.04]) {
    c.beginPath(); c.moveTo(ex - 0.045, -0.06); c.lineTo(ex - 0.01 - a.earBack * 0.06, -0.21 + a.earBack * 0.08); c.lineTo(ex + 0.05, -0.07); c.closePath(); c.fill();
  }
  // whiskers
  c.lineWidth = 0.008;
  for (const wy of [0.02, 0.05]) { c.beginPath(); c.moveTo(0.14, wy); c.lineTo(0.3, wy - 0.02 + wy * 0.3); c.stroke(); }
  c.restore();
}

function drawBird(c, a, t) {
  // origin at the feet; body sits above
  c.save();
  c.translate(0, -0.2);
  c.rotate(a.tilt);
  if (a.mode !== 'fly') {
    seg(c, -0.02, 0.1, -0.03, 0.2, 0.018);
    seg(c, 0.04, 0.1, 0.05, 0.2, 0.018);
  }
  ell(c, 0, 0, 0.23, 0.12);
  // tail fan
  c.beginPath(); c.moveTo(-0.16, -0.02); c.lineTo(-0.47, -0.1); c.lineTo(-0.46, 0.06); c.closePath(); c.fill();
  // head
  const hy = -0.09 + (a.peck > 0 ? Math.sin(a.peck * Math.PI) * 0.16 : 0);
  ell(c, 0.21, hy, 0.09, 0.085);
  c.beginPath(); c.moveTo(0.28, hy - 0.025); c.lineTo(0.41, hy + 0.01 + a.beak * 0.02); c.lineTo(0.28, hy + 0.025); c.closePath(); c.fill();
  if (a.beak > 0.1) { c.beginPath(); c.moveTo(0.28, hy + 0.02); c.lineTo(0.38, hy + 0.06); c.lineTo(0.28, hy + 0.04); c.closePath(); c.fill(); }
  // wings
  if (a.mode === 'fly') {
    const f = Math.sin(a.flap);
    for (const [ox, k] of [[0.03, 1], [-0.03, 0.75]]) {
      c.beginPath();
      c.moveTo(0.1 + ox, -0.04);
      c.quadraticCurveTo(0.0 + ox, -0.35 * f * k, -0.22 + ox, -0.5 * f * k - 0.02);
      c.quadraticCurveTo(-0.12 + ox, -0.1 * f, -0.12 + ox, 0.0);
      c.closePath();
      c.fill();
    }
  } else {
    ell(c, -0.06, -0.03, 0.18, 0.08, -0.15 - a.wingUp * 0.6);
  }
  c.restore();
}

const DRAW = { dog: drawDog, rabbit: drawRabbit, cat: drawCat, bird: drawBird };
const SIZE = { dog: 0.27, rabbit: 0.21, cat: 0.25, bird: 0.15 };
const NAMES = { dog: 'dog', rabbit: 'rabbit', cat: 'cat', bird: 'bird' };

function drawAnimal(c, a, t) {
  c.save();
  c.translate(a.x, a.y);
  c.scale(a.face * a.s * a.grow, a.s * a.grow);
  c.fillStyle = SHADOW;
  c.strokeStyle = SHADOW;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  DRAW[a.kind](c, a, t);
  c.restore();
}

// ======================================================================
// Sounds
// ======================================================================
const SOUND = {
  dog: { voice() { const p = 1 + (Math.random() - 0.5) * 0.15; sfx.tone({ type: 'sawtooth', freqs: [[0, 560 * p], [0.05, 640 * p], [0.14, 300 * p]], dur: 0.16, gain: 0.22, filter: 1100, q: 1.2 }); sfx.hiss({ dur: 0.1, gain: 0.08, freq: 1500 }); if (Math.random() < 0.5) setTimeout(() => SOUND.dog.voice1(), 190); }, voice1() { sfx.tone({ type: 'sawtooth', freqs: [[0, 600], [0.04, 660], [0.12, 320]], dur: 0.14, gain: 0.18, filter: 1100, q: 1.2 }); }, happy() { sfx.tone({ type: 'triangle', freqs: [[0, 900], [0.15, 1300], [0.35, 1000]], dur: 0.4, gain: 0.07 }); }, word: 'woof' },
  rabbit: { voice() { sfx.tone({ type: 'sine', freqs: [[0, 1800], [0.06, 2600]], dur: 0.08, gain: 0.06 }); }, happy() { sfx.tone({ type: 'sine', freqs: [[0, 1500], [0.08, 2100]], dur: 0.12, gain: 0.06 }); }, word: 'squeak' },
  cat: { voice() { sfx.tone({ type: 'sawtooth', freqs: [[0, 480], [0.18, 820], [0.5, 520]], dur: 0.55, gain: 0.12, filter: 1300, q: 2.5 }); }, happy() { sfx.hiss({ dur: 1.1, gain: 0.18, type: 'lowpass', freq: 220, am: 24 }); }, word: 'meow' },
  bird: { voice() { for (let i = 0; i < 2 + (Math.random() * 2 | 0); i++) sfx.tone({ type: 'sine', freqs: [[0, 2600], [0.04, 3600], [0.09, 2900]], dur: 0.1, gain: 0.07, delay: i * 0.13 }); }, happy() { sfx.tone({ type: 'sine', freqs: [[0, 3000], [0.1, 4200], [0.2, 3200]], dur: 0.22, gain: 0.06 }); }, word: 'tweet' },
};
function popSound() { sfx.tone({ type: 'sine', freqs: [[0, 260], [0.12, 880]], dur: 0.2, gain: 0.15 }); sfx.hiss({ dur: 0.2, gain: 0.05, freq: 3000 }); }
function sniffSound() { for (let i = 0; i < 3; i++) sfx.hiss({ dur: 0.06, gain: 0.06, type: 'highpass', freq: 2500, delay: i * 0.09 }); }

// ======================================================================
// Particles (drawn as light, not shadow)
// ======================================================================
let parts = [];
function emit(type, x, y, o = {}) { parts.push({ type, x, y, vx: o.vx ?? (Math.random() - 0.5) * 40, vy: o.vy ?? -60, life: 0, max: o.max ?? 1.2, text: o.text, size: o.size ?? 1 }); }
function drawParticles(dt) {
  parts = parts.filter((p) => (p.life += dt) < p.max);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of parts) {
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
      ctx.scale(p.size * U * (0.8 + k * 0.4), p.size * U * (0.8 + k * 0.4));
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.bezierCurveTo(-14, -4, -8, -16, 0, -8);
      ctx.bezierCurveTo(8, -16, 14, -4, 0, 6);
      ctx.fill();
    } else if (p.type === 'spark') {
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5 * U * p.size * (1 - k), 0, Math.PI * 2); ctx.fill();
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
const G = () => 2600 * U; // gravity, px/s²
let animals = [];
const MAX_ANIMALS = 6;

function spawn(kind, x, y) {
  const s = SIZE[kind] * Math.min(W, H) * 1.0;
  const a = {
    kind, x, y, s, vx: 0, vy: -s * 2.2, face: x < W / 2 ? 1 : -1, air: kind !== 'bird', mode: kind === 'bird' ? 'fly' : 'idle',
    phase: 0, stride: 0, sit: 0, crouch: 0, reach: 0, head: 0, jaw: 0, tail: 0, ear: 0.5, earBack: 0, arch: 0, swat: 0, sniff: 0,
    happy: 0, pet: 0, startle: -1, fleeDir: 1, cool: 0.6, hopCool: 0, nextVoice: 1 + Math.random() * 2, nextThink: 0, wanderX: x,
    flap: 0, tilt: 0, peck: 0, beak: 0, wingUp: 0, perchT: 0, groundT: 0, target: null, grow: 0, leaving: false, born: performance.now(), lastPet: 0,
  };
  if (kind === 'bird') { a.vx = 0; a.vy = -s * 3; }
  animals.push(a);
  const alive = animals.filter((q) => !q.leaving);
  if (alive.length > MAX_ANIMALS) { alive[0].leaving = true; alive[0].fleeDir = alive[0].x < W / 2 ? -1 : 1; }
  for (let i = 0; i < 18; i++) emit('spark', x, y, { vx: (Math.random() - 0.5) * 420 * U, vy: (Math.random() - 0.9) * 360 * U, max: 0.8, size: 1 + Math.random() });
  popSound();
  setTimeout(() => SOUND[kind].voice(), 220);
  emit('text', x, y - s * 0.9, { text: `a ${NAMES[kind]}!`, vx: 0, vy: -30, max: 1.6, size: 1.1 });
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

function voice(a, now, word = true) {
  SOUND[a.kind].voice();
  a.jaw = 1;
  if (word) emit('text', a.x + a.face * a.s * 0.5, a.y - a.s * 1.05, { text: SOUND[a.kind].word, vx: a.face * 20, vy: -40, max: 1.1, size: 0.8 });
}

function startle(a, h) {
  a.startle = 1.2;
  a.fleeDir = Math.sign(a.x - h.palm.x) || 1;
  emit('text', a.x, a.y - a.s * 1.2, { text: '!', vx: 0, vy: -60, max: 0.9, size: 1.4 });
  if (a.kind === 'bird') { a.mode = 'fly'; a.vy = -a.s * 6; a.vx = a.fleeDir * a.s * 4; }
  else if (!a.air) { a.air = true; a.vy = -a.s * 2.5; }
  SOUND[a.kind].voice();
}

function updateGroundAnimal(a, dt, t) {
  const s = a.s;
  a.cool -= dt; a.startle -= dt; a.hopCool -= dt; a.nextVoice -= dt;
  a.jaw = Math.max(0, a.jaw - dt * 5);
  const h = nearestHand(a);
  let want = 0, sitT = 0, headT = 0, earT = 0.5, crouchT = 0, reachT = 0, archT = 0, swatT = 0, earBackT = 0, sniffT = 0;
  let petting = false;
  const run = s * (a.kind === 'cat' ? 2.4 : 3.2), walk = s * (a.kind === 'cat' ? 0.9 : 1.2);

  if (a.leaving) {
    want = a.fleeDir * run;
    a.face = a.fleeDir;
  } else if (a.startle > 0) {
    want = a.fleeDir * run * 1.2;
    a.face = a.fleeDir;
    earT = 1; earBackT = 1;
  } else if (h) {
    // a fast swipe nearby startles them
    if (h.speed > 2600 * U && h.age > 0.4 && a.startle < -1 && Math.hypot(h.palm.x - a.x, h.palm.y - (a.y - s * 0.5)) < s * 2.2) startle(a, h);
    const dx = h.palm.x - a.x;
    const above = (GY - h.palm.y) / s; // hand height above the floor, in body lengths
    const reach = s * 0.5;
    if (Math.abs(dx) > reach * (a.kind === 'rabbit' ? 1.6 : 1)) {
      want = Math.sign(dx) * Math.min(run, Math.abs(dx) * 2.2);
      a.face = Math.sign(dx);
      earT = 0.85;
    } else {
      if (Math.abs(dx) > s * 0.08) a.face = Math.sign(dx);
      earT = 0.9;
      // look at the hand
      const headX = a.x + a.face * s * 0.55, headY = a.y - s * 0.9;
      const ang = Math.atan2(h.palm.y - headY, Math.abs(h.palm.x - headX) + s * 0.2);
      headT = clamp(ang, -1.0, 0.9);
      if (above < 1.7) {
        // close and low: sniff, and enjoy a stroke from an open hand
        reachT = 1; crouchT = 0.3; sniffT = 1;
        if (a.kind === 'cat') { archT = 0.8; reachT = 0.6; }
        const stroking = h.open > 0.5 && Math.abs(h.vx) > 70 * U && Math.abs(h.vx) < 2400 * U;
        if (stroking) petting = true;
        if (!petting && a.kind === 'dog' && Math.random() < dt * 0.6) { sniffSound(); emit('puff', headX + a.face * s * 0.2, headY + s * 0.05, { vx: a.face * 30, vy: -20, max: 0.6 }); }
        if (a.kind === 'cat') {
          const tip = h.pts[8];
          if (h.f.I && Math.hypot(tip.x - headX, tip.y - headY) < s * 0.7 && !stroking) swatT = 1;
        }
      } else if (above < 4.6) {
        // within reach: jump for it
        if (!a.air && a.cool <= 0) {
          const jumpH = Math.max(s * 0.5, GY - h.palm.y - s * (a.kind === 'rabbit' ? 0.4 : 0.8));
          a.vy = -Math.sqrt(2 * G() * jumpH);
          a.vx = clamp(dx * 2, -s * 2, s * 2);
          a.air = true;
          a.cool = 1.1 + Math.random() * 0.7;
          if (Math.random() < 0.55) voice(a, t);
        }
        earT = 1;
      } else {
        // far above: sit and look up, hopeful
        sitT = a.kind === 'rabbit' ? 0 : 1;
        earT = 1;
        if (a.nextVoice <= 0) { voice(a, t); a.nextVoice = 2.5 + Math.random() * 2; }
      }
    }
  } else {
    // nobody around: wander, sit, sniff the floor
    if (t > a.nextThink) {
      const r = Math.random();
      if (r < 0.55) a.wanderX = clamp(a.x + (Math.random() - 0.5) * W * 0.5, s, W - s);
      else a.wanderX = a.x;
      a.idleSit = r > 0.75 && a.kind !== 'rabbit';
      a.nextThink = t + 2 + Math.random() * 3;
    }
    const dx = a.wanderX - a.x;
    if (Math.abs(dx) > s * 0.1) { want = Math.sign(dx) * walk; a.face = Math.sign(dx); }
    else if (a.idleSit) sitT = 1;
    else { headT = 0.6; crouchT = 0.2; sniffT = 0.5; }
    if (a.nextVoice <= 0) { if (Math.random() < 0.35) voice(a, t); a.nextVoice = 4 + Math.random() * 5; }
  }

  // petting builds happiness
  if (petting) {
    a.pet = Math.min(1.5, a.pet + dt * 2.2);
    a.lastPet = t;
  } else a.pet = Math.max(0, a.pet - dt * 0.8);
  a.happy += ((a.pet > 0.2 ? 1 : 0) - a.happy) * ease(dt, 0.4);
  if (a.pet > 0.25) {
    earBackT = a.kind === 'rabbit' ? 1 : 0.4;
    sitT = Math.max(sitT, a.kind === 'cat' ? 0 : 0.3);
    if (Math.random() < dt * 4) emit('heart', a.x + (Math.random() - 0.3) * s * 0.6 * a.face, a.y - s * (0.9 + Math.random() * 0.3), { vx: (Math.random() - 0.5) * 40, vy: -70 * U, max: 1.4, size: 0.9 + Math.random() * 0.5 });
    if (a.nextVoice <= 0) { SOUND[a.kind].happy(); a.nextVoice = a.kind === 'cat' ? 1.1 : 1.6; }
  }

  // motion
  if (a.air) {
    a.vy += G() * dt;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    if (a.y >= GY) {
      a.y = GY;
      a.air = false;
      a.vy = 0;
      a.vx *= 0.3;
      for (let i = 0; i < 4; i++) emit('puff', a.x + (Math.random() - 0.5) * s * 0.6, GY - 4, { vx: (Math.random() - 0.5) * 60, vy: -15, max: 0.5 });
    }
  } else if (a.kind === 'rabbit') {
    // rabbits only move by hopping
    if (Math.abs(want) > s * 0.2 && a.hopCool <= 0) {
      a.air = true;
      a.vy = -s * 3.6;
      a.vx = clamp(want * 1.3, -s * 4, s * 4);
      a.hopCool = 0.16;
      sfx.tone({ type: 'sine', freqs: [[0, 220], [0.1, 380]], dur: 0.1, gain: 0.03 });
    }
    a.vx *= Math.exp(-dt / 0.05);
    a.x += a.vx * dt;
  } else {
    a.vx += (want - a.vx) * ease(dt, 0.16);
    a.x += a.vx * dt;
  }
  if (!a.leaving) a.x = clamp(a.x, s * 0.6, W - s * 0.6);

  const moving = Math.abs(a.vx) > s * 0.15 && !a.air;
  a.stride += ((moving ? clamp01(Math.abs(a.vx) / (s * 1.6)) : 0) - a.stride) * ease(dt, 0.1);
  a.phase += (Math.abs(a.vx) / s) * dt * 6.5;
  if (moving || a.air) sitT = 0;
  const k = ease(dt, 0.16);
  a.sit += (sitT - a.sit) * ease(dt, 0.25);
  a.head += ((a.air ? -0.4 : headT) - a.head) * k;
  a.ear += (earT - a.ear) * k;
  a.earBack += (earBackT - a.earBack) * k;
  a.crouch += (crouchT - a.crouch) * k;
  a.reach += (reachT - a.reach) * k;
  a.arch += (archT - a.arch) * ease(dt, 0.3);
  a.swat += (swatT * (0.6 + 0.4 * Math.sin(t * 14)) - a.swat) * ease(dt, 0.05);
  a.sniff += (sniffT - a.sniff) * k;
  const wagSpeed = a.happy > 0.3 || (h && !a.leaving) ? 20 : 7;
  a.tail = 0.25 + a.happy * 0.5 + Math.sin(t * wagSpeed) * (0.25 + a.happy * 0.25);
  return a.leaving && (a.x < -s * 2 || a.x > W + s * 2);
}

function perchPoint(h) {
  // land on a pointing fingertip, otherwise on top of the hand
  const p = h.f.I && !h.f.M ? h.pts[8] : h.top;
  return { x: p.x, y: p.y - h.size * 0.12 };
}

function updateBird(a, dt, t) {
  const s = a.s;
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
      a.x += (p.x - a.x) * ease(dt, 0.04);
      a.y += (p.y - a.y) * ease(dt, 0.04);
      a.vx = a.vy = 0;
      a.perchT += dt;
      // the other hand stroking nearby makes it happy
      const other = hands.find((o) => o !== h && o.open > 0.5 && Math.hypot(o.palm.x - a.x, o.palm.y - a.y) < s * 2.5 && Math.abs(o.vx) > 60 * U);
      if (other) { a.pet = Math.min(1.5, a.pet + dt * 2.2); if (Math.random() < dt * 4) emit('heart', a.x, a.y - s * 0.5, { vy: -70 * U, max: 1.3 }); }
      else a.pet = Math.max(0, a.pet - dt);
      if (a.nextVoice <= 0) { SOUND.bird.voice(); a.beak = 1; a.nextVoice = 1.8 + Math.random() * 2.5; }
      if (Math.random() < dt * 0.4) a.face *= -1;
      a.wingUp = Math.max(0, Math.sin(t * 3) - 0.6);
    }
  } else if (a.mode === 'ground') {
    a.groundT -= dt;
    a.vx = a.vy = 0;
    a.y = GY;
    if (Math.random() < dt * 1.2) { a.peck = 1; }
    if (Math.random() < dt * 0.5) { a.x += a.face * s * 0.2; }
    if (Math.random() < dt * 0.3) a.face *= -1;
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
      if (d < s * 0.6 && h.speed < 450 * U && h.age > 0.5) {
        a.mode = 'perch';
        a.perchT = 0;
        a.face = Math.sign(W / 2 - a.x) || 1;
        a.nextVoice = 0.2;
      }
      if (d > s * 2.5) { ty -= s * 0.8; } // swoop in from above
    } else {
      if (!a.target || t > a.nextThink) {
        if (Math.random() < 0.3) a.target = { x: clamp(a.x + (Math.random() - 0.5) * W * 0.4, s, W - s), y: GY, land: true };
        else a.target = { x: s + Math.random() * (W - 2 * s), y: H * (0.15 + Math.random() * 0.45) };
        a.nextThink = t + 3 + Math.random() * 3;
      }
      tx = a.target.x; ty = a.target.y;
      if (a.target.land && Math.hypot(tx - a.x, ty - a.y) < s * 0.3) { a.mode = 'ground'; a.groundT = 3 + Math.random() * 4; a.y = GY; a.target = null; }
    }
    const dx = tx - a.x, dy = ty - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = Math.min(s * (a.startle > 0 ? 9 : 5), d * (slow ? 3 : 1.5));
    a.vx += ((dx / d) * sp - a.vx) * ease(dt, 0.3);
    a.vy += ((dy / d) * sp - a.vy) * ease(dt, 0.3);
    a.vy += Math.sin(t * 4 + a.born) * s * 0.4 * dt * 10;
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    if (!a.leaving) a.x = clamp(a.x, s * 0.5, W - s * 0.5);
    a.y = Math.min(a.y, GY);
    if (Math.abs(a.vx) > s * 0.3) a.face = Math.sign(a.vx);
    a.flap += dt * (13 + Math.min(10, Math.abs(a.vy) / s * 2));
    a.tilt += (clamp(a.vy / (s * 10), -0.4, 0.4) * a.face - a.tilt) * ease(dt, 0.2);
    if (a.nextVoice <= 0) { if (Math.random() < 0.5) { SOUND.bird.voice(); a.beak = 1; } a.nextVoice = 3 + Math.random() * 4; }
  } else a.tilt *= Math.exp(-dt / 0.2);
  return a.leaving && (a.x < -s * 2 || a.x > W + s * 2);
}

// ======================================================================
// Making shapes
// ======================================================================
const HOLD = 0.8; // seconds a shape must be held
let birdT = 0, birdSpent = false, birdAt = null;
const forming = []; // ghost silhouettes for shapes being held

function detectShapes(dt, now) {
  forming.length = 0;
  // bird: two open hands with the thumbs hooked together
  let bird = null;
  if (hands.length >= 2) {
    const [a, b] = hands;
    const sz = (a.size + b.size) / 2;
    if (a.f.count >= 3 && b.f.count >= 3 && d2(a.raw[4], b.raw[4]) < sz * 0.9) bird = { x: (a.palm.x + b.palm.x) / 2, y: (a.palm.y + b.palm.y) / 2 };
  }
  if (bird) {
    birdAt = bird;
    if (!birdSpent) {
      birdT ||= now;
      const c = clamp01(((now - birdT) / 1000 - 0.15) / HOLD);
      forming.push({ kind: 'bird', x: bird.x, y: bird.y, c });
      if (c >= 1) { spawn('bird', bird.x, bird.y); birdSpent = true; }
    }
  } else { birdT = 0; birdSpent = false; }

  for (const h of hands) {
    const pose = bird ? null : h.pose;
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
    // a ring of lamplight fills up as you hold the shape
    ctx.save();
    ctx.strokeStyle = `rgba(${LIGHT},${0.35 + f.c * 0.5})`;
    ctx.shadowColor = `rgba(${LIGHT},0.9)`;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 4 * U;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(f.x, f.y, s * 0.75, -Math.PI / 2, -Math.PI / 2 + f.c * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(${LIGHT},${0.5 + f.c * 0.5})`;
    ctx.font = `italic 500 ${Math.round(26 * U)}px "Cormorant Garamond", Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${NAMES[f.kind]}…`, f.x, Math.max(96 * U, f.y - s * 0.95));
    ctx.restore();
    // the animal's shadow takes shape in the light
    const ghost = { kind: f.kind, x: f.x, y: f.y + s * 0.45, s, face: f.x < W / 2 ? 1 : -1, grow: 0.4 + f.c * 0.6, mode: 'fly', phase: 0, stride: 0, sit: 0, crouch: 0, reach: 0, head: 0, jaw: 0, tail: 0.3, ear: 1, earBack: 0, arch: 0, swat: 0, sniff: 0, happy: 0, flap: t * 10, tilt: 0, peck: 0, beak: 0, wingUp: 0, air: false };
    gx.clearRect(0, 0, W, H);
    drawAnimal(gx, ghost, t);
    ctx.save();
    ctx.globalAlpha = f.c * 0.6;
    if (CAN_FILTER) ctx.filter = 'blur(1.5px)';
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
  const live = !!tracker?.running || !!fakeHands;
  if (live) detectShapes(dt, now);
  for (const a of animals) a.grow = Math.min(1, a.grow + dt * 3);
  animals = animals.filter((a) => !(a.kind === 'bird' ? updateBird(a, dt, t) : updateGroundAnimal(a, dt, t)));

  // wall
  ctx.drawImage(bg, 0, 0, W, H);
  // shadows
  sx.clearRect(0, 0, W, H);
  for (const a of animals) drawAnimal(sx, a, t);
  for (const h of hands) drawHandShadow(sx, h);
  ctx.save();
  ctx.globalAlpha = 0.86;
  if (CAN_FILTER) ctx.filter = 'blur(1.5px)';
  ctx.drawImage(sh, 0, 0, W, H);
  ctx.restore();
  drawForming(t);
  drawParticles(dt);
  // a lamp breathes a little
  flicker += (Math.random() - 0.5) * dt * 2;
  flicker *= Math.exp(-dt * 2);
  const vig = 0.06 + Math.sin(t * 1.3) * 0.015 + flicker * 0.05;
  ctx.fillStyle = `rgba(40,28,18,${clamp(vig, 0, 0.15)})`;
  ctx.fillRect(0, 0, W, H);

  if (tracker?.running) {
    setStatus(hands.length ? 'active' : 'searching', hands.length ? `${hands.length} hand${hands.length > 1 ? 's' : ''} in the light` : 'show me your hands');
    const charging = forming.length > 0;
    hint.textContent = !hands.length
      ? (animals.length ? '' : 'Hold a hand up to the camera and its shadow appears on the wall.')
      : charging ? 'Hold still…'
      : !animals.length ? 'Make a shape and hold it: a dog, rabbit, cat or bird (see the guide).' : '';
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
