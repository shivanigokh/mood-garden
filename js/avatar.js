// AVATAR: a full-body scan turns you into a bold, cel-shaded open-world game hero.
// MediaPipe Pose finds your joints; during the scan the camera frame is sampled at
// your hair, skin, shirt, sleeves, trousers and shoes to pick the character's colours,
// sleeve and leg length and hair length. Then the character mirrors your pose live
// in a sunset city, and you can make a loading-screen style poster of it.
// Everything is drawn here; there are no external images.

import { PoseTracker, makePose } from './body.js?v=8';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, toScreen, Sfx, setupToggle } from './shared.js?v=8';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const scanCv = $('scan');
const sctx = scanCv.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const banner = $('banner');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const mirror = $('mirror');
const swatchesEl = $('swatches');

const TAU = Math.PI * 2;
const INK = '#1a0d2a';
const rand = (a, b) => a + Math.random() * (b - a);

let W = 0, H = 0, DPR = 1;
const backdrop = document.createElement('canvas');
const bctx = backdrop.getContext('2d');
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  backdrop.width = canvas.width;
  backdrop.height = canvas.height;
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  paintCity(bctx, W, H, 1);
  const r = scanCv.getBoundingClientRect();
  scanCv.width = Math.max(2, Math.round(r.width * DPR));
  scanCv.height = Math.max(2, Math.round(r.height * DPR));
}
window.addEventListener('resize', resize);

// ======================================================================
// Colour helpers
// ======================================================================
const hex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hsl2rgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// make a sampled colour read as an illustration: a touch more saturated, never pure black/white
function stylize(c, satBoost = 1.15, lo = 0.1, hi = 0.88) {
  const [h, s, l] = rgb2hsl(c);
  return hsl2rgb([h, clamp(s * satBoost, 0, 1), clamp(l, lo, hi)]);
}
// cel shadow: darker and nudged toward violet, like a sunset bounce light
const shadowOf = (c) => mix(c.map((v) => v * 0.62), [60, 20, 90], 0.22);
const lightOf = (c) => mix(c, [255, 240, 220], 0.28);

const COLOR_NAMES = [
  ['CRIMSON', [190, 30, 45]], ['SCARLET', [235, 60, 40]], ['TANGERINE', [240, 130, 40]], ['GOLDEN', [230, 190, 50]],
  ['LIME', [140, 200, 60]], ['JADE', [40, 150, 100]], ['TEAL', [30, 140, 150]], ['SKY', [90, 170, 230]],
  ['COBALT', [40, 80, 180]], ['MIDNIGHT', [25, 30, 70]], ['VIOLET', [120, 60, 180]], ['ROSE', [230, 110, 160]],
  ['IVORY', [235, 230, 215]], ['SILVER', [170, 170, 175]], ['SHADOW', [40, 40, 45]], ['DESERT', [190, 150, 100]],
  ['COCOA', [110, 70, 45]], ['OLIVE', [110, 115, 60]], ['DENIM', [70, 95, 140]],
];
const colorName = (c) => COLOR_NAMES.reduce((best, n) => (cdist(n[1], c) < cdist(best[1], c) ? n : best))[0];

// ======================================================================
// The character's look (filled in by the scan)
// ======================================================================
const DEFAULT_LOOK = {
  skin: [214, 160, 120], hair: [45, 30, 25], shirt: [230, 70, 70], pants: [60, 80, 130], shoes: [235, 235, 235],
  longSleeves: false, shorts: false, longHair: false, hairStyle: 'short', shades: false, build: 1, partial: false,
};
let look = null; // null until scanned
const HAIR_STYLES = ['short', 'long', 'buzz', 'bun', 'cap'];

// ======================================================================
// Pose → smoothed bone angles
// ======================================================================
let tracker = null;
const A = {}; // smoothed angles and values
const REST = {
  torso: -Math.PI / 2, sline: 0, hline: 0, head: -Math.PI / 2, tilt: 0, yaw: 0,
  uaL: Math.PI / 2 + 0.18, faL: Math.PI / 2 + 0.1, uaR: Math.PI / 2 - 0.18, faR: Math.PI / 2 - 0.1,
  thL: Math.PI / 2 + 0.07, shL: Math.PI / 2 + 0.03, thR: Math.PI / 2 - 0.07, shR: Math.PI / 2 - 0.03,
  ftL: Math.PI - 0.35, ftR: 0.35, hdL: Math.PI / 2 + 0.1, hdR: Math.PI / 2 - 0.1, shift: 0,
};
Object.assign(A, REST);
let present = 0; // 0..1 how sure we are someone is there
let fullBody = false;
let motion = 0;
let prevRaw = null;

const angOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
function angEase(key, target, k) {
  let d = target - A[key];
  d = Math.atan2(Math.sin(d), Math.cos(d));
  A[key] += d * k;
}

function readPose(dt) {
  const person = tracker?.people?.[0];
  present += ((person ? 1 : 0) - present) * ease(dt, 0.3);
  if (!person) {
    for (const k in REST) if (k !== 'shift') angEase(k, REST[k], ease(dt, 0.6));
    fullBody = false;
    return null;
  }
  const lm = person.lm;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const P = lm.map((p) => toScreen(p, vw, vh, W, H));
  const v = (i) => lm[i].v > 0.5;
  const k = ease(dt, 0.07);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const sm = mid(P[11], P[12]), hm = mid(P[23], P[24]);
  const legs = v(23) && v(24);
  fullBody = legs && v(25) && v(26) && v(27) && v(28) && v(0);
  if (legs) angEase('torso', angOf(hm, sm), k);
  else angEase('torso', REST.torso + (sm.x - W / 2) * 0, ease(dt, 0.4));
  angEase('sline', angOf(P[11], P[12]), k);
  angEase('hline', legs ? angOf(P[23], P[24]) : A.sline * 0.5, k);
  // head: from the shoulders to between the eyes, tilt from the eye line
  const eyes = mid(P[2], P[5]);
  if (v(0)) {
    angEase('head', angOf(sm, eyes), k);
    angEase('tilt', angOf(P[2], P[5]), k);
    const ears = mid(P[7], P[8]);
    const ew = Math.hypot(P[7].x - P[8].x, P[7].y - P[8].y) || 1;
    A.yaw += (clamp((P[0].x - ears.x) / ew, -0.6, 0.6) - A.yaw) * k;
  }
  // limbs: measured when visible, resting otherwise
  const limb = (key, a, b) => angEase(key, v(a) && v(b) ? angOf(P[a], P[b]) : REST[key], v(a) && v(b) ? k : ease(dt, 0.4));
  limb('uaL', 11, 13); limb('faL', 13, 15); limb('uaR', 12, 14); limb('faR', 14, 16);
  limb('hdL', 15, 19); limb('hdR', 16, 20);
  limb('thL', 23, 25); limb('shL', 25, 27); limb('thR', 24, 26); limb('shR', 26, 28);
  limb('ftL', 29, 31); limb('ftR', 30, 32);
  // drift left and right with you, a little
  const anchorX = legs ? hm.x : sm.x;
  A.shift += (clamp((anchorX - W / 2) / W, -0.5, 0.5) - A.shift) * k;
  // how much you are moving (for the "hold still" part of the scan)
  if (prevRaw) {
    let m = 0;
    for (const i of [0, 11, 12, 15, 16, 23, 24]) m += Math.hypot(lm[i].x - prevRaw[i].x, lm[i].y - prevRaw[i].y);
    motion += (m / dt / 7 - motion) * ease(dt, 0.25);
  }
  prevRaw = lm.map((p) => ({ x: p.x, y: p.y }));
  return { lm, P };
}

// character proportions in head units (u)
function buildJoints(cx, groundY, u, build = 1) {
  const dir = (a, l) => ({ x: Math.cos(a) * l, y: Math.sin(a) * l });
  const add = (p, d) => ({ x: p.x + d.x, y: p.y + d.y });
  const T = 2.55 * u, SW = 2.05 * u * build, HW = 1.35 * u * build;
  const UA = 1.4 * u, FA = 1.25 * u, TH = 1.75 * u, SH = 1.65 * u;
  const hip = { x: cx, y: 0 };
  const shC = add(hip, dir(A.torso, T));
  const sl = dir(A.sline, SW / 2), hl = dir(A.hline, HW / 2);
  const sL = { x: shC.x - sl.x, y: shC.y - sl.y }, sR = { x: shC.x + sl.x, y: shC.y + sl.y };
  const hL = { x: hip.x - hl.x, y: hip.y - hl.y }, hR = { x: hip.x + hl.x, y: hip.y + hl.y };
  const eL = add(sL, dir(A.uaL, UA)), wL = add(eL, dir(A.faL, FA));
  const eR = add(sR, dir(A.uaR, UA)), wR = add(eR, dir(A.faR, FA));
  const kL = add(hL, dir(A.thL, TH)), aL = add(kL, dir(A.shL, SH));
  const kR = add(hR, dir(A.thR, TH)), aR = add(kR, dir(A.shR, SH));
  const head = add(shC, dir(A.head, 0.95 * u));
  const J = { hip, shC, sL, sR, hL, hR, eL, wL, eR, wR, kL, aL, kR, aR, head, u };
  // stand on the ground: the lowest ankle sits just above the ground line
  const low = Math.max(aL.y, aR.y) + 0.32 * u;
  const dy = groundY - low;
  for (const key in J) if (key !== 'u') J[key].y += dy;
  return J;
}

// ======================================================================
// Drawing helpers: smooth tubes and cel shading with ink outlines
// ======================================================================
function tubePath(c, pts, ws, steps = 6) {
  const n = pts.length;
  const S = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let j = 0; j < steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      S.push([cr(p0.x, p1.x, p2.x, p3.x), cr(p0.y, p1.y, p2.y, p3.y), ws[i] + (ws[i + 1] - ws[i]) * t]);
    }
  }
  S.push([pts[n - 1].x, pts[n - 1].y, ws[n - 1]]);
  const m = S.length, L = [], R = [], N = [];
  for (let k = 0; k < m; k++) {
    const a = S[Math.max(0, k - 1)], b = S[Math.min(m - 1, k + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    N.push(Math.atan2(dx, -dy));
    L.push([S[k][0] - dy * S[k][2], S[k][1] + dx * S[k][2]]);
    R.push([S[k][0] + dy * S[k][2], S[k][1] - dx * S[k][2]]);
  }
  c.beginPath();
  c.moveTo(L[0][0], L[0][1]);
  for (let k = 1; k < m; k++) c.lineTo(L[k][0], L[k][1]);
  c.arc(S[m - 1][0], S[m - 1][1], Math.max(S[m - 1][2], 0.01), N[m - 1], N[m - 1] - Math.PI, true);
  for (let k = m - 1; k >= 0; k--) c.lineTo(R[k][0], R[k][1]);
  c.arc(S[0][0], S[0][1], Math.max(S[0][2], 0.01), N[0] - Math.PI, N[0] - TAU, true);
  c.closePath();
}

// fill a shape in two tones (lit + shadow) and ink it
function cel(c, path, base, u, opts = {}) {
  const off = u * (opts.off ?? 0.16);
  path();
  c.fillStyle = hex(opts.shadow || shadowOf(base));
  c.fill();
  c.save();
  path();
  c.clip();
  c.translate(-off, -off * 0.55); // light from the upper left
  path();
  c.fillStyle = hex(base);
  c.fill();
  c.restore();
  if (opts.shine) {
    // a thin highlight edge on the lit side
    c.save();
    path();
    c.clip();
    c.lineWidth = u * 0.12;
    c.strokeStyle = hex(lightOf(base));
    c.translate(off * 0.45, off * 0.35);
    path();
    c.globalAlpha = 0.55;
    c.stroke();
    c.restore();
  }
  if (opts.ink !== false) {
    path();
    c.lineWidth = u * 0.075;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = INK;
    c.stroke();
  }
}

// ======================================================================
// The character
// ======================================================================
function drawCharacter(c, J, L, t, holo = 0) {
  const u = J.u;
  const lp = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  const skin = L.skin, shirt = L.shirt, pants = L.pants, hair = L.hair;
  const shoes = L.shoes;
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // ground shadow
  c.fillStyle = 'rgba(30, 10, 50, 0.35)';
  c.beginPath();
  c.ellipse((J.aL.x + J.aR.x) / 2, Math.max(J.aL.y, J.aR.y) + 0.32 * u, Math.abs(J.aL.x - J.aR.x) / 2 + u * 1.1, u * 0.28, 0, 0, TAU);
  c.fill();

  // long hair falls behind everything above the shoulders
  const headAng = A.tilt;
  if (L.hairStyle === 'long') {
    c.save();
    c.translate(J.head.x, J.head.y);
    c.rotate(headAng * 0.6);
    cel(c, () => {
      c.beginPath();
      c.moveTo(-0.5 * u, -0.25 * u);
      c.quadraticCurveTo(-0.72 * u, 0.9 * u, -0.6 * u, 1.45 * u);
      c.lineTo(0.6 * u, 1.45 * u);
      c.quadraticCurveTo(0.72 * u, 0.9 * u, 0.5 * u, -0.25 * u);
      c.closePath();
    }, hair, u);
    c.restore();
  }

  // legs: shoes, then trousers (or skin with shorts)
  for (const [k, a, ft, side] of [[J.kL, J.aL, A.ftL, -1], [J.kR, J.aR, A.ftR, 1]]) {
    const toeA = Math.abs(Math.cos(ft)) > 0.2 ? ft : (side < 0 ? Math.PI - 0.35 : 0.35);
    const tip = { x: a.x + Math.cos(toeA) * 0.55 * u, y: a.y + 0.25 * u + Math.max(0, Math.sin(toeA)) * 0.1 * u };
    cel(c, () => {
      c.beginPath();
      c.ellipse((a.x + tip.x) / 2, a.y + 0.2 * u, 0.5 * u, 0.24 * u, Math.atan2(tip.y - a.y - 0.2 * u, tip.x - a.x) * 0.3, 0, TAU);
    }, shoes, u, { shine: true });
    // sole stripe
    c.strokeStyle = hex(shadowOf(shoes));
    c.lineWidth = u * 0.06;
    c.beginPath();
    c.moveTo(a.x - 0.4 * u * Math.sign(Math.cos(toeA) || 1) * -1, a.y + 0.36 * u);
    c.lineTo(tip.x, a.y + 0.36 * u);
    c.stroke();
  }
  for (const [h, k, a] of [[J.hL, J.kL, J.aL], [J.hR, J.kR, J.aR]]) {
    if (L.shorts) {
      cel(c, () => tubePath(c, [h, k, a], [0.36 * u, 0.27 * u, 0.2 * u]), skin, u);
      cel(c, () => tubePath(c, [lp(h, k, -0.05), lp(h, k, 0.85)], [0.47 * u, 0.4 * u]), pants, u);
    } else {
      cel(c, () => tubePath(c, [h, k, lp(k, a, 1.05)], [0.46 * u, 0.36 * u, 0.3 * u]), pants, u, { shine: true });
    }
  }
  // seat of the trousers joins the legs
  cel(c, () => {
    const up = { x: Math.cos(A.torso) * 0.55 * u, y: Math.sin(A.torso) * 0.55 * u };
    c.beginPath();
    c.moveTo(J.hL.x - 0.45 * u + up.x, J.hL.y + up.y);
    c.lineTo(J.hR.x + 0.45 * u + up.x, J.hR.y + up.y);
    c.lineTo(J.hR.x + 0.42 * u, J.hR.y + 0.35 * u);
    c.quadraticCurveTo(J.hip.x, J.hip.y + 0.75 * u, J.hL.x - 0.42 * u, J.hL.y + 0.35 * u);
    c.closePath();
  }, pants, u, { ink: false });

  // torso
  const sOut = 0.2 * u;
  const lineV = { x: Math.cos(A.sline), y: Math.sin(A.sline) };
  const waistL = lp(J.sL, J.hL, 0.7), waistR = lp(J.sR, J.hR, 0.7);
  const torsoPath = () => {
    c.beginPath();
    const nl = { x: J.shC.x - lineV.x * 0.32 * u, y: J.shC.y - lineV.y * 0.32 * u };
    const nr = { x: J.shC.x + lineV.x * 0.32 * u, y: J.shC.y + lineV.y * 0.32 * u };
    c.moveTo(nl.x, nl.y);
    c.quadraticCurveTo(J.sL.x - lineV.x * sOut * 0.3, J.sL.y - 0.25 * u, J.sL.x - lineV.x * sOut, J.sL.y + 0.15 * u);
    c.quadraticCurveTo(waistL.x - 0.05 * u, waistL.y, J.hL.x - 0.38 * u, J.hL.y - 0.25 * u);
    c.quadraticCurveTo(J.hip.x, J.hip.y - 0.05 * u, J.hR.x + 0.38 * u, J.hR.y - 0.25 * u);
    c.quadraticCurveTo(waistR.x + 0.05 * u, waistR.y, J.sR.x + lineV.x * sOut, J.sR.y + 0.15 * u);
    c.quadraticCurveTo(J.sR.x + lineV.x * sOut * 0.3, J.sR.y - 0.25 * u, nr.x, nr.y);
    c.quadraticCurveTo(J.shC.x, J.shC.y + 0.25 * u, nl.x, nl.y);
    c.closePath();
  };
  // neck under the collar
  cel(c, () => tubePath(c, [lp(J.shC, J.head, -0.05), lp(J.shC, J.head, 0.6)], [0.24 * u, 0.22 * u]), skin, u);
  cel(c, torsoPath, shirt, u, { shine: true });
  c.save();
  torsoPath();
  c.clip();
  c.strokeStyle = INK;
  c.lineWidth = u * 0.06;
  if (L.longSleeves) {
    // a jacket: zip line and open collar
    c.beginPath();
    c.moveTo(J.shC.x, J.shC.y + 0.2 * u);
    c.lineTo(J.hip.x, J.hip.y - 0.2 * u);
    c.stroke();
    c.fillStyle = hex(shadowOf(shirt));
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(J.shC.x + s * 0.32 * u, J.shC.y - 0.02 * u);
      c.lineTo(J.shC.x + s * 0.05 * u, J.shC.y + 0.55 * u);
      c.lineTo(J.shC.x + s * 0.5 * u, J.shC.y + 0.25 * u);
      c.closePath();
      c.fill();
      c.stroke();
    }
  } else {
    // tee: a crew neck and a crease
    c.strokeStyle = hex(shadowOf(shirt));
    c.lineWidth = u * 0.05;
    c.beginPath();
    c.moveTo(lp(J.sL, J.hR, 0.45).x, lp(J.sL, J.hR, 0.45).y);
    c.quadraticCurveTo(J.hip.x + 0.1 * u, J.hip.y - 1.0 * u, lp(J.sR, J.hR, 0.85).x - 0.2 * u, lp(J.sR, J.hR, 0.85).y);
    c.stroke();
  }
  // belt
  c.fillStyle = INK;
  c.fillRect(Math.min(J.hL.x, J.hR.x) - u, J.hip.y - 0.42 * u, Math.abs(J.hR.x - J.hL.x) + 2 * u, 0.16 * u);
  c.fillStyle = '#d9b44a';
  c.fillRect(J.hip.x - 0.12 * u, J.hip.y - 0.44 * u, 0.24 * u, 0.2 * u);
  c.restore();

  // arms
  for (const [s, e, w, hd] of [[J.sL, J.eL, J.wL, A.hdL], [J.sR, J.eR, J.wR, A.hdR]]) {
    const wEnd = lp(e, w, 1.0);
    if (L.longSleeves) {
      cel(c, () => tubePath(c, [s, e, wEnd], [0.36 * u, 0.29 * u, 0.25 * u]), shirt, u, { shine: true });
      // cuff
      cel(c, () => tubePath(c, [lp(e, w, 0.86), lp(e, w, 1.0)], [0.27 * u, 0.27 * u]), shadowOf(shirt), u, { off: 0.05 });
    } else {
      cel(c, () => tubePath(c, [s, e, wEnd], [0.31 * u, 0.25 * u, 0.2 * u]), skin, u);
      cel(c, () => tubePath(c, [lp(s, e, -0.1), lp(s, e, 0.55)], [0.4 * u, 0.33 * u]), shirt, u, { shine: true });
    }
    // hand: a mitten pointing along the fingers with a thumb
    const ha = Math.abs(Math.atan2(Math.sin(hd - angOf(e, w)), Math.cos(hd - angOf(e, w)))) < 1.4 ? hd : angOf(e, w);
    const hc = { x: w.x + Math.cos(ha) * 0.22 * u, y: w.y + Math.sin(ha) * 0.22 * u };
    cel(c, () => {
      c.beginPath();
      c.ellipse(hc.x, hc.y, 0.27 * u, 0.21 * u, ha, 0, TAU);
    }, skin, u, { off: 0.08 });
    cel(c, () => {
      const ta = ha + (w === J.wL ? -1.1 : 1.1);
      c.beginPath();
      c.ellipse(w.x + Math.cos(ta) * 0.2 * u, w.y + Math.sin(ta) * 0.2 * u, 0.13 * u, 0.08 * u, ta, 0, TAU);
    }, skin, u, { off: 0.04 });
  }

  // head
  c.save();
  c.translate(J.head.x, J.head.y);
  c.rotate(headAng);
  c.translate(0, -0.06 * u);
  c.scale(1.12, 1.12);
  drawHead(c, L, u, t);
  c.restore();

  c.restore();

  // hologram treatment while scanning: cyan wash and scanlines
  if (holo > 0) {
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.globalAlpha = holo;
    c.fillStyle = 'rgba(80, 230, 255, 0.9)';
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.globalAlpha = holo * 0.5;
    c.fillStyle = 'rgba(255,255,255,0.8)';
    for (let y = (t * 40) % 6; y < c.canvas.height; y += 6) c.fillRect(0, y, c.canvas.width, 1.5);
    c.restore();
  }
}

function drawHead(c, L, u, t) {
  const skin = L.skin, hair = L.hair;
  const yaw = A.yaw * 0.22 * u; // features slide as you turn your head
  const hw = 0.42 * u, hh = 0.56 * u;
  // ears
  for (const s of [-1, 1]) cel(c, () => { c.beginPath(); c.ellipse(s * hw * 0.98 + yaw * 0.3, 0.05 * u, 0.1 * u, 0.15 * u, 0, 0, TAU); }, skin, u, { off: 0.04 });
  const face = () => {
    c.beginPath();
    c.moveTo(-hw, -0.1 * u);
    c.bezierCurveTo(-hw, -hh * 1.15, hw, -hh * 1.15, hw, -0.1 * u);
    c.bezierCurveTo(hw * 1.02, 0.22 * u, hw * 0.75, 0.42 * u, 0.12 * u + yaw * 0.3, hh * 0.98);
    c.quadraticCurveTo(yaw * 0.3, hh * 1.04, -0.12 * u + yaw * 0.3, hh * 0.98);
    c.bezierCurveTo(-hw * 0.75, 0.42 * u, -hw * 1.02, 0.22 * u, -hw, -0.1 * u);
    c.closePath();
  };
  cel(c, face, skin, u, { off: 0.12 });

  const fx = yaw;
  // brows: thick and confident
  c.strokeStyle = hex(mix(hair, [20, 10, 20], 0.35));
  c.lineWidth = u * 0.075;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(fx + s * 0.07 * u, -0.1 * u);
    c.quadraticCurveTo(fx + s * 0.18 * u, -0.17 * u, fx + s * 0.3 * u, -0.12 * u);
    c.stroke();
  }
  if (L.shades) {
    c.fillStyle = INK;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(fx + s * 0.04 * u, -0.06 * u);
      c.lineTo(fx + s * 0.33 * u, -0.08 * u);
      c.quadraticCurveTo(fx + s * 0.32 * u, 0.1 * u, fx + s * 0.2 * u, 0.1 * u);
      c.quadraticCurveTo(fx + s * 0.06 * u, 0.1 * u, fx + s * 0.04 * u, -0.06 * u);
      c.fill();
    }
    c.fillRect(fx - 0.05 * u, -0.07 * u, 0.1 * u, 0.03 * u);
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = u * 0.025;
    for (const s of [-1, 1]) { c.beginPath(); c.moveTo(fx + s * 0.12 * u, -0.03 * u); c.lineTo(fx + s * 0.2 * u, 0.05 * u); c.stroke(); }
  } else {
    for (const s of [-1, 1]) {
      const ex = fx + s * 0.18 * u, ey = 0.0;
      c.fillStyle = '#fff';
      c.beginPath(); c.ellipse(ex, ey, 0.1 * u, 0.055 * u, 0, 0, TAU); c.fill();
      c.fillStyle = '#3a2416';
      c.beginPath(); c.arc(ex + A.yaw * 0.04 * u, ey, 0.045 * u, 0, TAU); c.fill();
      c.fillStyle = INK;
      c.beginPath(); c.arc(ex + A.yaw * 0.04 * u, ey, 0.022 * u, 0, TAU); c.fill();
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(ex + A.yaw * 0.04 * u - 0.015 * u, ey - 0.018 * u, 0.012 * u, 0, TAU); c.fill();
      // upper lid line
      c.strokeStyle = INK;
      c.lineWidth = u * 0.04;
      c.beginPath(); c.ellipse(ex, ey, 0.1 * u, 0.055 * u, 0, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
    }
  }
  // nose and mouth: a little smirk
  c.strokeStyle = hex(shadowOf(skin));
  c.lineWidth = u * 0.045;
  c.beginPath(); c.moveTo(fx + 0.02 * u, 0.06 * u); c.lineTo(fx + 0.05 * u, 0.2 * u); c.lineTo(fx - 0.03 * u, 0.22 * u); c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = u * 0.045;
  c.beginPath(); c.moveTo(fx - 0.12 * u, 0.34 * u); c.quadraticCurveTo(fx + 0.02 * u, 0.37 * u, fx + 0.14 * u, 0.31 * u); c.stroke();

  // hair on top
  const hs = L.hairStyle;
  if (hs === 'cap') {
    const capC = L.capColor || mix(L.shirt, [255, 255, 255], 0.15);
    cel(c, () => {
      c.beginPath();
      c.moveTo(-hw * 1.08, -0.1 * u);
      c.bezierCurveTo(-hw * 1.05, -hh * 1.35, hw * 1.05, -hh * 1.35, hw * 1.08, -0.1 * u);
      c.closePath();
    }, capC, u, { shine: true });
    cel(c, () => { c.beginPath(); c.ellipse(fx * 0.6 + 0.05 * u, -0.1 * u, hw * 1.15, 0.09 * u, 0, 0, TAU); }, shadowOf(capC), u, { off: 0.03 });
  } else if (hs === 'buzz') {
    cel(c, () => {
      c.beginPath();
      c.moveTo(-hw * 1.02, -0.05 * u);
      c.bezierCurveTo(-hw * 1.04, -hh * 1.22, hw * 1.04, -hh * 1.22, hw * 1.02, -0.05 * u);
      c.quadraticCurveTo(hw * 0.7, -0.32 * u, 0, -0.33 * u);
      c.quadraticCurveTo(-hw * 0.7, -0.32 * u, -hw * 1.02, -0.05 * u);
      c.closePath();
    }, hair, u, { off: 0.06 });
  } else {
    // swept fringe with a few chunky spikes
    cel(c, () => {
      c.beginPath();
      c.moveTo(-hw * 1.1, 0.05 * u);
      c.bezierCurveTo(-hw * 1.25, -hh * 1.45, hw * 1.25, -hh * 1.5, hw * 1.12, 0.0);
      c.lineTo(hw * 0.95, -0.2 * u);
      c.quadraticCurveTo(hw * 0.6, -0.22 * u, hw * 0.45, -0.38 * u);
      c.quadraticCurveTo(hw * 0.1, -0.2 * u, -hw * 0.2, -0.3 * u);
      c.quadraticCurveTo(-hw * 0.55, -0.15 * u, -hw * 0.85, -0.22 * u);
      c.closePath();
    }, hair, u, { shine: true, off: 0.1 });
    if (hs === 'bun') cel(c, () => { c.beginPath(); c.arc(0, -hh * 1.2, 0.2 * u, 0, TAU); }, hair, u, { off: 0.06 });
  }
}

// ======================================================================
// Backdrop: an original sunset city
// ======================================================================
function paintCity(c, w, h, s) {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3b1c6b');
  g.addColorStop(0.35, '#c2407a');
  g.addColorStop(0.62, '#ff8a4c');
  g.addColorStop(0.75, '#ffc46b');
  g.addColorStop(1, '#ffc46b');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const hz = h * 0.72; // horizon
  // sun with sliced bands
  const sr = Math.min(w, h) * 0.22;
  const sg = c.createLinearGradient(0, hz - sr * 1.6, 0, hz);
  sg.addColorStop(0, '#fff2a8');
  sg.addColorStop(1, '#ff7a45');
  c.save();
  c.beginPath();
  c.arc(w * 0.5, hz - sr * 0.35, sr, 0, TAU);
  c.clip();
  c.fillStyle = sg;
  c.fillRect(w * 0.5 - sr, hz - sr * 1.6, sr * 2, sr * 2);
  c.fillStyle = '#ff8a4c';
  for (let i = 0; i < 6; i++) { const y = hz - sr * 0.55 + i * sr * 0.16; c.fillRect(w * 0.5 - sr, y, sr * 2, sr * 0.025 * (i + 1)); }
  c.restore();
  // halftone dots in the upper sky
  c.fillStyle = 'rgba(255, 255, 255, 0.07)';
  const step = 14 * s;
  for (let y = 0; y < h * 0.4; y += step) for (let x = (y / step) % 2 ? step / 2 : 0; x < w; x += step) {
    const r = (1 - y / (h * 0.4)) * 3.2 * s;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  }
  // skyline: two layers of towers
  const rng = (() => { let a = 11; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
  for (const [col, hmul, win] of [['#7a2f6e', 0.32, 0.25], ['#3d1a52', 0.22, 0.6]]) {
    let x = -10;
    while (x < w + 10) {
      const bw = (30 + rng() * 70) * s;
      const bh = h * hmul * (0.35 + rng() * 0.75);
      c.fillStyle = col;
      c.fillRect(x, hz - bh, bw - 3 * s, bh);
      if (rng() < 0.35) c.fillRect(x + bw * 0.4, hz - bh - 18 * s, 3 * s, 18 * s);
      c.fillStyle = `rgba(255, 220, 140, ${win})`;
      for (let wy = hz - bh + 8 * s; wy < hz - 6 * s; wy += 11 * s) for (let wx = x + 5 * s; wx < x + bw - 10 * s; wx += 9 * s) if (rng() < 0.32) c.fillRect(wx, wy, 4 * s, 5 * s);
      x += bw;
    }
  }
  // palms
  const palm = (px, ph, lean) => {
    c.strokeStyle = '#24102f';
    c.lineWidth = 9 * s;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(px, h * 0.86);
    c.quadraticCurveTo(px + lean * 0.5, h * 0.86 - ph * 0.5, px + lean, h * 0.86 - ph);
    c.stroke();
    c.fillStyle = '#24102f';
    const tx = px + lean, ty = h * 0.86 - ph;
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.55;
      c.beginPath();
      c.moveTo(tx, ty);
      c.quadraticCurveTo(tx + Math.cos(a - 0.4) * ph * 0.35, ty + Math.sin(a - 0.4) * ph * 0.35 - 10 * s, tx + Math.cos(a) * ph * 0.42, ty + Math.sin(a) * ph * 0.42 + ph * 0.12);
      c.quadraticCurveTo(tx + Math.cos(a + 0.2) * ph * 0.25, ty + Math.sin(a + 0.2) * ph * 0.25, tx, ty);
      c.fill();
    }
  };
  palm(w * 0.12, h * 0.5, 40 * s);
  palm(w * 0.2, h * 0.36, -25 * s);
  palm(w * 0.88, h * 0.55, -45 * s);
  // street
  const rg = c.createLinearGradient(0, hz, 0, h);
  rg.addColorStop(0, '#3a2348');
  rg.addColorStop(1, '#1f1029');
  c.fillStyle = rg;
  c.fillRect(0, hz, w, h - hz);
  c.strokeStyle = 'rgba(255, 200, 90, 0.85)';
  c.lineWidth = 4 * s;
  for (let i = 0; i < 9; i++) {
    const f0 = i / 9, f1 = (i + 0.5) / 9;
    const y0 = hz + (h - hz) * f0 * f0, y1 = hz + (h - hz) * f1 * f1;
    c.lineWidth = (1 + f1 * 6) * s;
    c.beginPath(); c.moveTo(w / 2, y0); c.lineTo(w / 2, y1); c.stroke();
  }
  c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  c.lineWidth = 2 * s;
  for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(w / 2 + sx * w * 0.06, hz); c.lineTo(w / 2 + sx * w * 0.9, h); c.stroke(); }
  // sidewalk the hero stands on
  c.fillStyle = 'rgba(255,255,255,0.06)';
  c.fillRect(0, h * 0.86, w, h * 0.14);
}

// ======================================================================
// Scanning: sample colours from the camera at body regions
// ======================================================================
const sampler = document.createElement('canvas');
const sampCtx = sampler.getContext('2d', { willReadFrequently: true });
let scan = { state: 'waiting', t: 0, seenT: 0, samples: {} };

function samplePatch(img, w, h, x, y, r = 3) {
  const px = Math.round(x * w), py = Math.round(y * h);
  if (px < r || py < r || px >= w - r || py >= h - r) return null;
  const out = [];
  for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    const i = ((py + dy) * w + (px + dx)) * 4;
    out.push([img[i], img[i + 1], img[i + 2]]);
  }
  return out;
}
function median(list) {
  if (!list.length) return null;
  const ch = [0, 1, 2].map((k) => list.map((c) => c[k]).sort((a, b) => a - b)[Math.floor(list.length / 2)]);
  return ch;
}

function sampleFrame(lm) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const w = 240, h = Math.round((240 * vh) / vw);
  sampler.width = w;
  sampler.height = h;
  sampCtx.drawImage(video, 0, 0, w, h);
  const img = sampCtx.getImageData(0, 0, w, h).data;
  const P = (i) => lm[i];
  const vis = (...ids) => ids.every((i) => lm[i].v > 0.5);
  const at = (a, b, f, dx = 0, dy = 0) => ({ x: a.x + (b.x - a.x) * f + dx, y: a.y + (b.y - a.y) * f + dy });
  const add = (key, pt, r = 3) => {
    const s = samplePatch(img, w, h, pt.x, pt.y, r);
    if (s) (scan.samples[key] ||= []).push(...s);
  };
  const earW = Math.hypot(P(7).x - P(8).x, P(7).y - P(8).y);
  if (vis(0, 7, 8)) {
    // cheeks for skin, above the forehead for hair, beside the jaw to tell long hair
    add('skin', at(P(0), P(7), 0.4, 0, earW * 0.12), 2);
    add('skin', at(P(0), P(8), 0.4, 0, earW * 0.12), 2);
    const eyes = at(P(2), P(5), 0.5);
    add('hair', { x: eyes.x, y: eyes.y - earW * 0.62 }, 2);
    add('hair', { x: eyes.x + earW * 0.25, y: eyes.y - earW * 0.5 }, 2);
    add('hair', { x: eyes.x - earW * 0.25, y: eyes.y - earW * 0.5 }, 2);
    add('besideJaw', { x: P(7).x + (P(7).x - P(8).x) * 0.12, y: P(7).y + earW * 0.55 }, 2);
    add('besideJaw', { x: P(8).x - (P(7).x - P(8).x) * 0.12, y: P(8).y + earW * 0.55 }, 2);
    add('bg', { x: eyes.x + earW * 1.6, y: eyes.y - earW * 0.4 }, 2);
    add('bg', { x: eyes.x - earW * 1.6, y: eyes.y - earW * 0.4 }, 2);
  }
  if (vis(11, 12)) {
    const sm = at(P(11), P(12), 0.5);
    const hipOk = vis(23, 24);
    const hm = hipOk ? at(P(23), P(24), 0.5) : { x: sm.x, y: sm.y + Math.abs(P(11).x - P(12).x) * 1.2 };
    add('shirt', at(sm, hm, 0.3), 4);
    add('shirt', at(at(P(11), sm, 0.35), hm, 0.45), 3);
    add('shirt', at(at(P(12), sm, 0.35), hm, 0.45), 3);
  }
  for (const [s, e, wr] of [[11, 13, 15], [12, 14, 16]]) {
    if (vis(s, e)) add('upperArm', at(P(s), P(e), 0.45), 2);
    if (vis(e, wr)) add('forearm', at(P(e), P(wr), 0.55), 2);
  }
  for (const [hp, kn, an, toe] of [[23, 25, 27, 31], [24, 26, 28, 32]]) {
    if (vis(hp, kn)) add('thigh', at(P(hp), P(kn), 0.45), 3);
    if (vis(kn, an)) add('shin', at(P(kn), P(an), 0.55), 2);
    if (vis(an, toe)) add('shoes', at(P(an), P(toe), 0.5), 2);
  }
}

function finishScan() {
  const m = (k) => median(scan.samples[k] || []);
  const L = { ...DEFAULT_LOOK };
  const skin = m('skin'), hair = m('hair'), shirt = m('shirt'), fore = m('forearm'), thigh = m('thigh'), shin = m('shin'), shoes = m('shoes'), jaw = m('besideJaw'), bgc = m('bg');
  if (skin) L.skin = stylize(skin, 1.05, 0.2, 0.86);
  if (hair) L.hair = stylize(hair, 1.1, 0.08, 0.8);
  if (shirt) L.shirt = stylize(shirt, 1.25);
  if (thigh) L.pants = stylize(thigh, 1.2);
  if (shoes) L.shoes = stylize(shoes, 1.1, 0.12, 0.92);
  // hair that looks like the background is probably background: fall back to dark hair
  if (hair && bgc && cdist(hair, bgc) < 30) L.hair = DEFAULT_LOOK.hair;
  if (fore && skin && shirt) L.longSleeves = cdist(fore, shirt) < cdist(fore, skin) * 0.9;
  if (shin && skin && thigh) L.shorts = cdist(shin, skin) < cdist(shin, thigh) * 0.75 && cdist(thigh, skin) > 40;
  if (jaw && hair && skin) L.longHair = cdist(jaw, hair) < cdist(jaw, skin) && cdist(jaw, hair) < 55 && (!bgc || cdist(jaw, bgc) > 35);
  L.hairStyle = L.longHair ? 'long' : 'short';
  L.partial = !thigh;
  if (!shoes) L.shoes = DEFAULT_LOOK.shoes;
  L.title = makeTitle(L);
  L.seed = Math.floor(Math.random() * 1e6);
  look = L;
  showSwatches();
  ['btn-hair', 'btn-shades', 'btn-poster'].forEach((id) => ($(id).disabled = false));
  reveal = 0;
  S.done();
}

function showSwatches() {
  if (!look) { swatchesEl.hidden = true; return; }
  const row = (name, c) => `<div><i style="background:${hex(c)}"></i>${name}</div>`;
  swatchesEl.innerHTML = row('Hair', look.hair) + row('Skin', look.skin) + row(look.longSleeves ? 'Jacket' : 'Tee', look.shirt) + row(look.shorts ? 'Shorts' : 'Trousers', look.pants) + row('Shoes', look.shoes);
  swatchesEl.hidden = false;
}

const NOUNS = ['ACE', 'RIDER', 'MAVERICK', 'LEGEND', 'DRIFTER', 'NIGHTHAWK', 'HUSTLE', 'BOSS', 'ROOKIE', 'WILDCARD', 'COMET', 'NOMAD'];
function makeTitle(L) {
  return colorName(L.shirt) + ' ' + NOUNS[Math.floor(Math.random() * NOUNS.length)];
}

// ======================================================================
// Poster
// ======================================================================
async function makePoster() {
  if (!look) return;
  try { await document.fonts.load('80px Anton'); } catch (e) { /* fallback font */ }
  const PW = 1080, PH = 1350;
  const pc = document.createElement('canvas');
  pc.width = PW;
  pc.height = PH;
  const c = pc.getContext('2d');
  // two bold panels split on a diagonal, colours from the outfit
  const [h] = rgb2hsl(look.shirt);
  const a = hsl2rgb([(h + 0.5) % 1, 0.65, 0.55]), b = hsl2rgb([(h + 0.08) % 1, 0.75, 0.6]);
  c.fillStyle = hex(a);
  c.fillRect(0, 0, PW, PH);
  c.fillStyle = hex(b);
  c.beginPath(); c.moveTo(PW * 0.55, 0); c.lineTo(PW, 0); c.lineTo(PW, PH); c.lineTo(PW * 0.25, PH); c.closePath(); c.fill();
  // sun disc and halftone
  c.fillStyle = 'rgba(255, 240, 180, 0.55)';
  c.beginPath(); c.arc(PW * 0.62, PH * 0.38, PW * 0.36, 0, TAU); c.fill();
  c.fillStyle = 'rgba(26, 13, 42, 0.12)';
  for (let y = 0; y < PH; y += 22) for (let x = (y / 22) % 2 ? 11 : 0; x < PW; x += 22) {
    const r = 5 * clamp01(1 - Math.hypot(x - PW * 0.2, y - PH * 0.9) / (PW * 0.9));
    if (r > 0.3) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  }
  // the character, big, with a white sticker outline
  const u = PH * 0.7 / 8.4;
  const J = buildJoints(PW * 0.6, PH * 0.92, u, look.build);
  const layer = document.createElement('canvas');
  layer.width = PW; layer.height = PH;
  const lc = layer.getContext('2d');
  drawCharacter(lc, J, look, performance.now() / 1000);
  const sil = document.createElement('canvas');
  sil.width = PW; sil.height = PH;
  const sc = sil.getContext('2d');
  sc.drawImage(layer, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = '#ffffff';
  sc.fillRect(0, 0, PW, PH);
  c.save();
  c.globalAlpha = 0.35;
  c.filter = 'none';
  // drop shadow
  const dsh = document.createElement('canvas');
  dsh.width = PW; dsh.height = PH;
  const dc = dsh.getContext('2d');
  dc.drawImage(layer, 0, 0);
  dc.globalCompositeOperation = 'source-in';
  dc.fillStyle = INK;
  dc.fillRect(0, 0, PW, PH);
  c.drawImage(dsh, 18, 14);
  c.restore();
  for (let i = 0; i < 16; i++) { const an = (i / 16) * TAU; c.drawImage(sil, Math.cos(an) * 12, Math.sin(an) * 12); }
  c.drawImage(layer, 0, 0);

  // title block
  const words = look.title.split(' ');
  c.save();
  c.translate(60, PH * 0.73);
  c.rotate(-0.07);
  c.textBaseline = 'alphabetic';
  c.lineJoin = 'round';
  words.forEach((wd, i) => {
    const size = i === 0 ? 120 : 170;
    c.font = `${size}px Anton, Impact, sans-serif`;
    const y = i === 0 ? 0 : 150;
    c.lineWidth = 22;
    c.strokeStyle = INK;
    c.strokeText(wd, 0, y);
    c.fillStyle = i === 0 ? '#ffcf3f' : '#ffffff';
    c.fillText(wd, 0, y);
  });
  c.restore();

  // stats card
  const rng = mulberry(look.seed);
  const stats = [['STAMINA', 0], ['DRIVING', 0], ['STEALTH', 0], ['STYLE', 0], ['LUCK', 0]].map(([n]) => [n, 45 + Math.floor(rng() * 55)]);
  c.save();
  c.translate(56, 70);
  c.fillStyle = 'rgba(26, 13, 42, 0.85)';
  c.fillRect(0, 0, 380, 300);
  c.fillStyle = '#ffcf3f';
  c.fillRect(0, 0, 380, 8);
  c.font = '38px Anton, Impact, sans-serif';
  c.fillStyle = '#fff';
  c.fillText('PLAYER PROFILE', 24, 60);
  c.font = '600 20px Inter, sans-serif';
  stats.forEach(([n, v], i) => {
    const y = 100 + i * 40;
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText(n, 24, y + 16);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(160, y, 190, 18);
    c.fillStyle = v > 85 ? '#ffcf3f' : '#7be0ff';
    c.fillRect(160, y, 190 * (v / 100), 18);
  });
  c.restore();
  // reputation stars
  const rep = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < 5; i++) {
    c.fillStyle = i < rep ? '#ffcf3f' : 'rgba(26,13,42,0.35)';
    c.strokeStyle = INK;
    c.lineWidth = 5;
    starPath(c, PW - 330 + i * 62, 110, 26);
    c.fill();
    c.stroke();
  }
  c.font = '26px Anton, Impact, sans-serif';
  c.fillStyle = INK;
  c.fillText('REPUTATION', PW - 360, 170);
  // footer
  c.fillStyle = INK;
  c.fillRect(0, PH - 64, PW, 64);
  c.font = '30px Anton, Impact, sans-serif';
  c.fillStyle = '#fff';
  c.fillText('SUNSET BAY  ·  CHAPTER ONE', 40, PH - 22);
  c.font = '500 18px Inter, sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.6)';
  c.textAlign = 'right';
  c.fillText('made with Mood Garden', PW - 32, PH - 26);
  return pc;
}
function starPath(c, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  c.closePath();
}
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let posterUrl = null;
async function openPoster(newTitle) {
  if (newTitle && look) look.title = makeTitle(look);
  const pc = await makePoster();
  if (!pc) return;
  pc.toBlob((blob) => {
    if (posterUrl) URL.revokeObjectURL(posterUrl);
    posterUrl = URL.createObjectURL(blob);
    $('poster-img').src = posterUrl;
    $('poster-save').href = posterUrl;
    $('poster-save').download = look.title.toLowerCase().replace(/\s+/g, '-') + '-poster.png';
    $('poster-view').hidden = false;
  }, 'image/png');
  S.shutter();
}

// ======================================================================
// Sound
// ======================================================================
const sfx = new Sfx();
const S = {
  tick(p) { sfx.tone({ type: 'square', freqs: [[0, 400 + p * 800]], dur: 0.04, gain: 0.03 }); },
  done() {
    sfx.hiss({ dur: 0.5, gain: 0.15, freq: 3000, q: 0.5 });
    [392, 523, 659, 784].forEach((f, i) => sfx.tone({ type: 'sawtooth', freqs: [[0, f]], dur: 0.3, gain: 0.05, delay: i * 0.08, filter: 1800, q: 0.7 }));
  },
  shutter() { sfx.hiss({ dur: 0.08, gain: 0.2, freq: 4000, q: 0.8 }); sfx.hiss({ dur: 0.1, gain: 0.15, freq: 2500, q: 0.8, delay: 0.09 }); },
  click() { sfx.tone({ type: 'triangle', freqs: [[0, 880]], dur: 0.05, gain: 0.06 }); },
};

// ======================================================================
// Scanner overlay on the camera inset
// ======================================================================
function drawScanOverlay(pose, t) {
  const cw = scanCv.width, ch = scanCv.height;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, cw, ch);
  if (!pose) return;
  // the inset shows the camera with object-fit: cover, mirrored by CSS like the video
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (vw * s - cw) / 2, oy = (vh * s - ch) / 2;
  const pt = (p) => ({ x: p.x * vw * s - ox, y: p.y * vh * s - oy });
  const lm = pose.lm;
  const scanning = scan.state === 'scanning';
  sctx.strokeStyle = scanning ? 'rgba(90, 240, 255, 0.95)' : look ? 'rgba(255, 207, 63, 0.9)' : 'rgba(255,255,255,0.8)';
  sctx.lineWidth = 2 * DPR;
  sctx.lineCap = 'round';
  const bones = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
  for (const [a, b] of bones) {
    if (lm[a].v < 0.5 || lm[b].v < 0.5) continue;
    const p = pt(lm[a]), q = pt(lm[b]);
    sctx.beginPath(); sctx.moveTo(p.x, p.y); sctx.lineTo(q.x, q.y); sctx.stroke();
  }
  sctx.fillStyle = sctx.strokeStyle;
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (lm[i].v < 0.5) continue;
    const p = pt(lm[i]);
    sctx.beginPath(); sctx.arc(p.x, p.y, 3 * DPR, 0, TAU); sctx.fill();
  }
  if (scanning) {
    // laser sweeping down and up
    const f = (Math.sin(t * 3) * 0.5 + 0.5);
    const y = f * ch;
    const g = sctx.createLinearGradient(0, y - 30 * DPR, 0, y + 4 * DPR);
    g.addColorStop(0, 'rgba(90, 240, 255, 0)');
    g.addColorStop(1, 'rgba(90, 240, 255, 0.45)');
    sctx.fillStyle = g;
    sctx.fillRect(0, y - 30 * DPR, cw, 34 * DPR);
    sctx.fillStyle = 'rgba(200, 255, 255, 0.95)';
    sctx.fillRect(0, y, cw, 2 * DPR);
  }
}

// ======================================================================
// Main loop
// ======================================================================
let reveal = 1; // 0..1 wipe from hologram to the finished character
function setStatus(st, text) { if (statusEl.dataset.state !== st) statusEl.dataset.state = st; if (statusText.textContent !== text) statusText.textContent = text; }
function setBanner(html) { if (banner.innerHTML !== html) banner.innerHTML = html; }

const charLayer = document.createElement('canvas');
const clc = charLayer.getContext('2d');

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;
  if (tracker) tracker.update(now);
  const pose = readPose(dt);

  // scan state machine
  if (tracker && (tracker.running || tracker.fake)) {
    if (scan.state === 'waiting') {
      if (pose) scan.seenT += dt; else scan.seenT = 0;
      if (pose && fullBody) { scan.fullT = (scan.fullT || 0) + dt; } else scan.fullT = 0;
      if (scan.fullT > 0.8 || scan.seenT > 9) { scan.state = 'scanning'; scan.t = 0; scan.samples = {}; scan.partial = !fullBody; }
      setBanner(pose ? (fullBody ? 'Hold it right there' : `Step back so I can see your feet <small>${scan.seenT > 4 ? 'or I’ll scan what I can see in ' + Math.ceil(9 - scan.seenT) + 's' : ''}</small>`) : 'Step into the frame');
    } else if (scan.state === 'scanning') {
      const still = motion < 0.35;
      if (pose && still) {
        const before = scan.t;
        scan.t += dt;
        if (Math.floor(before * 8) !== Math.floor(scan.t * 8)) { sampleFrame(pose.lm); S.tick(scan.t / 3); }
      }
      const pct = Math.min(100, Math.round((scan.t / 3) * 100));
      setBanner(pose ? (still ? `Scanning ${pct}%` : 'Hold still…') : 'Come back into the frame');
      if (scan.t >= 3) { scan.state = 'done'; finishScan(); }
    } else if (scan.state === 'done') {
      setBanner(reveal < 1 ? 'Scan complete' : (look.partial ? `${look.title} <small>legs guessed: step back and rescan for a full scan</small>` : look.title));
    }
    const label = !pose ? 'looking for you' : fullBody ? 'full body in view' : 'upper body in view';
    setStatus(pose ? 'active' : 'searching', label);
  }

  ctx.drawImage(backdrop, 0, 0, W, H);
  // the character, bobbing gently when idle
  const u = Math.min(H * 0.68 / 8.4, W * 0.09);
  const cx = W / 2 + A.shift * W * 0.35;
  const J = buildJoints(cx, H * 0.93, u, look?.build || 1);
  const breathe = Math.sin(t * 2) * u * 0.03;
  for (const key in J) if (key !== 'u' && !['aL', 'aR'].includes(key)) J[key].y += breathe * (J[key].y < J.hip.y ? 1 : 0.4);
  const L = look || { ...DEFAULT_LOOK, skin: [190, 200, 210], hair: [110, 120, 140], shirt: [150, 160, 180], pants: [110, 120, 140], shoes: [200, 205, 215] };
  if (charLayer.width !== canvas.width || charLayer.height !== canvas.height) { charLayer.width = canvas.width; charLayer.height = canvas.height; }
  clc.setTransform(1, 0, 0, 1, 0, 0);
  clc.clearRect(0, 0, charLayer.width, charLayer.height);
  clc.setTransform(DPR, 0, 0, DPR, 0, 0);
  const holo = look ? 0 : 0.55 + Math.sin(t * 6) * 0.05;
  if (look && reveal < 1) {
    // wipe the finished look in from the top over the hologram
    reveal = Math.min(1, reveal + dt / 1.1);
    const cut = lerp(J.head.y - u * 1.2, H, reveal);
    drawCharacter(clc, J, { ...DEFAULT_LOOK, ...L }, t, 0);
    clc.save();
    clc.setTransform(1, 0, 0, 1, 0, 0);
    clc.globalCompositeOperation = 'destination-out';
    clc.fillRect(0, cut * DPR, charLayer.width, charLayer.height);
    clc.restore();
    ctx.drawImage(charLayer, 0, 0, W, H);
    clc.setTransform(1, 0, 0, 1, 0, 0);
    clc.clearRect(0, 0, charLayer.width, charLayer.height);
    clc.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawCharacter(clc, J, { ...DEFAULT_LOOK, skin: [190, 200, 210], hair: [110, 120, 140], shirt: [150, 160, 180], pants: [110, 120, 140], shoes: [200, 205, 215] }, t, 0.55);
    clc.save();
    clc.setTransform(1, 0, 0, 1, 0, 0);
    clc.globalCompositeOperation = 'destination-out';
    clc.fillRect(0, 0, charLayer.width, cut * DPR);
    clc.restore();
    ctx.drawImage(charLayer, 0, 0, W, H);
    // bright scan line at the cut
    ctx.fillStyle = 'rgba(200, 255, 255, 0.9)';
    ctx.fillRect(cx - u * 3, cut - 2, u * 6, 4);
  } else {
    drawCharacter(clc, J, L, t, holo);
    ctx.globalAlpha = look ? 1 : 0.85 * clamp01(0.4 + present);
    ctx.drawImage(charLayer, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  drawScanOverlay(pose, t);
}

resize();
requestAnimationFrame(frame);

setupToggle($('btn-mirror'), true, (v) => mirror.classList.toggle('hidden', !v));
setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
$('btn-scan').addEventListener('click', () => {
  sfx.init();
  S.click();
  scan = { state: 'waiting', t: 0, seenT: 0, samples: {} };
  look = null;
  showSwatches();
  ['btn-hair', 'btn-shades', 'btn-poster'].forEach((id) => ($(id).disabled = true));
});
$('btn-hair').addEventListener('click', () => {
  if (!look) return;
  S.click();
  look.hairStyle = HAIR_STYLES[(HAIR_STYLES.indexOf(look.hairStyle) + 1) % HAIR_STYLES.length];
});
$('btn-shades').addEventListener('click', (e) => {
  if (!look) return;
  S.click();
  look.shades = !look.shades;
  e.currentTarget.setAttribute('aria-pressed', String(look.shades));
});
$('btn-poster').addEventListener('click', () => { sfx.init(); openPoster(false); });
$('poster-again').addEventListener('click', () => openPoster(true));
$('poster-close').addEventListener('click', () => { $('poster-view').hidden = true; });

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Booting scanner…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new PoseTracker(video, { numPoses: 1 });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    requestAnimationFrame(resize); // size the scanner overlay now that it is visible
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Body tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

// testing hook
window.avatar = {
  makePose,
  fake(list) { tracker ||= new PoseTracker(video); tracker.fake = list; },
  get scan() { return scan; },
  get look() { return look; },
  setLook(l) { look = { ...DEFAULT_LOOK, title: 'COBALT ACE', seed: 1, ...l }; reveal = 1; showSwatches(); scan.state = 'done'; ['btn-hair', 'btn-shades', 'btn-poster'].forEach((id) => ($(id).disabled = false)); },
  angles: A,
  get fullBody() { return fullBody; },
  makePoster,
};
