// MOTION PARTY: four original minigames played with your whole body, for one or two
// players side by side. MediaPipe Pose finds shoulders, arms, hands and head; the
// camera fills the screen in true colour and the games are drawn on top.

import { PoseTracker, makePose } from './body.js?v=11';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, toScreen, Sfx, setupToggle } from './shared.js?v=8';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('fx');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const hint = $('hint');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const card = $('card');
const bar = $('bar');
const barGame = $('bar-game');
const barTime = $('bar-time');
const barScores = $('bar-scores');

const FONT = '"Fredoka", "Baloo 2", system-ui, sans-serif';
const PCOL = ['#ff5d73', '#2ec4f1'];
const PCOL_DARK = ['#c2324a', '#1689b0'];
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let W = 0, H = 0, DPR = 1, U = 1;
// keep labels clear of the nav and score bar at the top
const SAFE_TOP = () => (W <= 560 ? 70 : 124) + U * 5;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  U = Math.min(W, H) / 100; // one "unit" is 1% of the short side
}
window.addEventListener('resize', resize);
resize();

const sfx = new Sfx();
const S = {
  pop() { sfx.tone({ type: 'triangle', freqs: [[0, 1200], [0.09, 260]], dur: 0.14, gain: 0.22 }); sfx.hiss({ dur: 0.06, gain: 0.18, freq: 3000, q: 0.7 }); },
  gold() { [0, 0.07, 0.14].forEach((d, i) => sfx.tone({ type: 'square', freqs: [[0, [988, 1319, 1760][i]]], dur: 0.12, gain: 0.07, delay: d })); },
  coin() { sfx.tone({ type: 'square', freqs: [[0, 988]], dur: 0.07, gain: 0.07 }); sfx.tone({ type: 'square', freqs: [[0, 1319]], dur: 0.2, gain: 0.07, delay: 0.07 }); },
  hit() { sfx.tone({ type: 'sawtooth', freqs: [[0, 220], [0.3, 70]], dur: 0.35, gain: 0.16, filter: 600, q: 0.8 }); sfx.hiss({ dur: 0.3, gain: 0.2, type: 'lowpass', freq: 900 }); },
  zap() { sfx.tone({ type: 'sawtooth', freqs: [[0, 1800], [0.25, 200]], dur: 0.3, gain: 0.08 }); },
  warn() { sfx.tone({ type: 'square', freqs: [[0, 520]], dur: 0.08, gain: 0.05 }); },
  beep() { sfx.tone({ type: 'sine', freqs: [[0, 660]], dur: 0.18, gain: 0.25 }); },
  go() { sfx.tone({ type: 'sine', freqs: [[0, 990]], dur: 0.5, gain: 0.25 }); sfx.tone({ type: 'triangle', freqs: [[0, 1485]], dur: 0.5, gain: 0.12 }); },
  step(p) { sfx.tone({ type: 'triangle', freqs: [[0, 160 + p * 80]], dur: 0.05, gain: 0.05 }); },
  whoosh() { sfx.hiss({ dur: 0.5, gain: 0.12, freq: 700, q: 0.6 }); },
  judge(q) {
    const notes = [[330], [523, 659], [523, 659, 784], [523, 659, 784, 1047]][q];
    notes.forEach((f, i) => sfx.tone({ type: 'triangle', freqs: [[0, f]], dur: 0.25, gain: 0.14, delay: i * 0.06 }));
  },
  fanfare() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => sfx.tone({ type: 'square', freqs: [[0, f]], dur: i === 5 ? 0.6 : 0.14, gain: 0.07, delay: i * 0.12 })); },
};

let tracker = null;

// ======================================================================
// Players: pose landmarks turned into screen-space body parts
// ======================================================================
const pstate = [{}, {}]; // per player memory (previous hand positions etc.)
let players = []; // this frame's players
let nPlayers = 1; // locked when a game starts

function vdims() {
  return { vw: video.videoWidth || 1280, vh: video.videoHeight || 720 };
}

function buildPlayers(dt) {
  const { vw, vh } = vdims();
  const people = tracker ? tracker.people : [];
  const out = [];
  people.slice(0, 2).forEach((person, idx) => {
    const lm = person.lm;
    const pts = lm.map((p) => toScreen(p, vw, vh, W, H));
    const vis = lm.map((p) => p.v);
    const sw = Math.max(Math.hypot(pts[11].x - pts[12].x, pts[11].y - pts[12].y), U * 6);
    // head: nose, nudged up toward the eyes, sized from the ears
    const earW = Math.hypot(pts[7].x - pts[8].x, pts[7].y - pts[8].y);
    const head = { x: (pts[0].x * 2 + pts[2].x + pts[5].x) / 4, y: (pts[0].y * 2 + pts[2].y + pts[5].y) / 4, r: Math.max(earW * 0.75, sw * 0.32) };
    const hands = [];
    // index 0 is the hand on the screen's left (the person's left, odd landmarks)
    for (const [w, ix, pk, el] of [[15, 19, 17, 13], [16, 20, 18, 14]]) {
      const mx = (pts[ix].x + pts[pk].x) / 2, my = (pts[ix].y + pts[pk].y) / 2;
      const x = pts[w].x + (mx - pts[w].x) * 0.8, y = pts[w].y + (my - pts[w].y) * 0.8;
      hands.push({ x, y, r: Math.max(sw * 0.26, U * 3.2), on: vis[w] > 0.35, wrist: pts[w], elbow: pts[el] });
    }
    const ps = pstate[idx];
    if (ps.prev && dt > 0) {
      hands.forEach((h, i) => {
        const p = ps.prev[i];
        const k = ease(dt, 0.06);
        h.vx = (ps.vel?.[i]?.vx || 0) + (((h.x - p.x) / dt) - (ps.vel?.[i]?.vx || 0)) * k;
        h.vy = (ps.vel?.[i]?.vy || 0) + (((h.y - p.y) / dt) - (ps.vel?.[i]?.vy || 0)) * k;
      });
    } else hands.forEach((h) => { h.vx = 0; h.vy = 0; });
    ps.prev = hands.map((h) => ({ x: h.x, y: h.y }));
    ps.vel = hands.map((h) => ({ vx: h.vx, vy: h.vy }));
    out.push({ idx, pts, vis, sw, head, hands, color: PCOL[idx], dark: PCOL_DARK[idx] });
  });
  for (let i = out.length; i < 2; i++) pstate[i] = {};
  players = out;
}

function handsUp(p) {
  return p.hands.every((h) => h.on && h.wrist.y < p.head.y);
}

function drawPlayers(t) {
  for (const p of players) {
    if (p.idx >= nPlayers && game) continue;
    const P = p.pts;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // a friendly outline of shoulders and arms so you can see what the game sees
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(4, p.sw * 0.06);
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(P[15].x, P[15].y); ctx.lineTo(P[13].x, P[13].y); ctx.lineTo(P[11].x, P[11].y);
    ctx.lineTo(P[12].x, P[12].y); ctx.lineTo(P[14].x, P[14].y); ctx.lineTo(P[16].x, P[16].y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // hands: chunky rings
    for (const h of p.hands) {
      if (!h.on) continue;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = Math.max(4, h.r * 0.16);
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r * 0.8, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    // name tag
    if (nPlayers > 1 || !game) {
      ctx.globalAlpha = 1;
      const tx = p.head.x, ty = Math.max(p.head.y - p.head.r * 1.6, SAFE_TOP()) + Math.sin(t * 3 + p.idx) * 3;
      ctx.font = `700 ${Math.round(U * 3.2)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = 'P' + (p.idx + 1);
      const w = ctx.measureText(label).width + U * 3;
      ctx.fillStyle = p.color;
      roundRect(tx - w / 2, ty - U * 2.4, w, U * 4.8, U * 2.4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, tx, ty + U * 0.2);
    }
    ctx.restore();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ======================================================================
// Shared effects: particles and floating text
// ======================================================================
const parts = [];
function confetti(x, y, color, n = 14, speed = 1) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), s = rand(80, 340) * speed;
    parts.push({ k: 'bit', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, life: 0, max: rand(0.6, 1.1), c: color || pick(['#ff5d73', '#ffc93c', '#7bdc65', '#2ec4f1', '#b38cff']), rot: rand(0, TAU), vr: rand(-12, 12), w: rand(5, 10), h: rand(3, 6) });
  }
}
function floatText(x, y, text, color = '#fff', size = 5) {
  parts.push({ k: 'txt', x, y, vx: 0, vy: -U * 12, life: 0, max: 1.1, text, c: color, size });
}
function ring(x, y, color, r = 40) {
  parts.push({ k: 'ring', x, y, vx: 0, vy: 0, life: 0, max: 0.45, c: color, r });
}
function stepParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life += dt;
    if (p.life > p.max) { parts.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.k === 'bit') { p.vy += 900 * dt; p.vx *= 1 - dt * 1.5; p.rot += p.vr * dt; }
    if (p.k === 'txt') p.vy *= 1 - dt * 2.5;
  }
}
function drawParts() {
  for (const p of parts) {
    const f = p.life / p.max;
    ctx.save();
    if (p.k === 'bit') {
      ctx.globalAlpha = 1 - f * f;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    } else if (p.k === 'txt') {
      ctx.globalAlpha = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
      const s = U * p.size * (f < 0.12 ? 0.6 + f / 0.12 * 0.5 : 1.1 - Math.min(0.1, (f - 0.12)));
      ctx.font = `700 ${Math.round(s)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = s * 0.18;
      ctx.strokeStyle = 'rgba(30, 24, 52, 0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.c;
      ctx.fillText(p.text, p.x, p.y);
    } else if (p.k === 'ring') {
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = p.c;
      ctx.lineWidth = 6 * (1 - f) + 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.6 + f * 1.2), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function outlinedText(text, x, y, size, fill = '#fff', stroke = 'rgba(30,24,52,0.9)', align = 'center') {
  ctx.font = `700 ${Math.round(size)}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// ======================================================================
// Game 1: Balloon Burst
// ======================================================================
function Balloons() {
  const COLORS = ['#ff5d73', '#ffc93c', '#7bdc65', '#2ec4f1', '#b38cff', '#ff8a3d'];
  const g = { id: 'balloons', t: 0, dur: 30, items: [], spawnT: 0.3, scores: [0, 0] };
  g.spawn = () => {
    const roll = Math.random();
    const kind = roll < 0.12 ? 'gold' : roll < 0.27 ? 'storm' : 'plain';
    const r = U * (kind === 'gold' ? 4.6 : kind === 'storm' ? 6.4 : rand(5.4, 7));
    g.items.push({
      kind, r, x: rand(W * 0.07, W * 0.93), y: H + r * 2, speed: U * rand(13, 20) * (kind === 'gold' ? 1.35 : 1) * (1 + g.t / 45),
      ph: rand(0, TAU), wob: rand(0.6, 1.4), c: kind === 'gold' ? '#ffd23f' : pick(COLORS), dead: false, spin: rand(-0.2, 0.2),
    });
  };
  g.update = (dt) => {
    g.t += dt;
    g.spawnT -= dt;
    if (g.spawnT <= 0) {
      g.spawn();
      g.spawnT = lerp(0.7, 0.36, clamp01(g.t / g.dur)) * rand(0.7, 1.3) / (nPlayers > 1 ? 1.5 : 1);
    }
    for (const b of g.items) {
      b.y -= b.speed * dt;
      b.x += Math.sin(g.t * 1.6 * b.wob + b.ph) * U * 6 * dt;
      for (const p of players) {
        if (p.idx >= nPlayers || b.dead) continue;
        for (const h of p.hands) {
          if (!h.on) continue;
          if (Math.hypot(h.x - b.x, h.y - (b.y - b.r * 0.1)) < b.r + h.r * 0.7) {
            b.dead = true;
            if (b.kind === 'storm') {
              g.scores[p.idx] = Math.max(0, g.scores[p.idx] - 2);
              floatText(b.x, b.y, '-2', '#ff8fa0', 6);
              confetti(b.x, b.y, '#5b5774', 16, 0.8);
              confetti(b.x, b.y, '#fff27a', 6, 1.2);
              S.hit();
              shake = 0.3;
            } else {
              const pts = b.kind === 'gold' ? 3 : 1;
              g.scores[p.idx] += pts;
              floatText(b.x, b.y, '+' + pts, b.kind === 'gold' ? '#ffd23f' : '#fff', b.kind === 'gold' ? 7 : 5);
              confetti(b.x, b.y, b.c, 16);
              ring(b.x, b.y, p.color, b.r);
              b.kind === 'gold' ? S.gold() : S.pop();
            }
            break;
          }
        }
      }
    }
    g.items = g.items.filter((b) => !b.dead && b.y > -b.r * 4);
  };
  g.draw = (t) => {
    for (const b of g.items) {
      const x = b.x, y = b.y, r = b.r;
      ctx.save();
      if (b.kind === 'storm') {
        drawStorm(x, y, r, t);
      } else {
        // string
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y + r * 1.15);
        for (let i = 1; i <= 8; i++) ctx.lineTo(x + Math.sin(t * 4 + i * 0.8 + b.ph) * r * 0.12, y + r * 1.15 + i * r * 0.22);
        ctx.stroke();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 1.3 + b.ph) * 0.12);
        // body with a slight teardrop
        const gr = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.2);
        gr.addColorStop(0, shade(b.c, 0.45));
        gr.addColorStop(0.55, b.c);
        gr.addColorStop(1, shade(b.c, -0.35));
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.moveTo(0, r * 1.08);
        ctx.bezierCurveTo(-r * 0.9, r * 0.75, -r * 1.02, -r * 0.2, -r * 0.8, -r * 0.62);
        ctx.bezierCurveTo(-r * 0.5, -r * 1.12, r * 0.5, -r * 1.12, r * 0.8, -r * 0.62);
        ctx.bezierCurveTo(r * 1.02, -r * 0.2, r * 0.9, r * 0.75, 0, r * 1.08);
        ctx.fill();
        // knot
        ctx.fillStyle = shade(b.c, -0.3);
        ctx.beginPath();
        ctx.moveTo(-r * 0.12, r * 1.2); ctx.lineTo(r * 0.12, r * 1.2); ctx.lineTo(0, r * 1.04); ctx.closePath();
        ctx.fill();
        // shine
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.ellipse(-r * 0.38, -r * 0.45, r * 0.14, r * 0.28, -0.6, 0, TAU);
        ctx.fill();
        if (b.kind === 'gold') {
          ctx.fillStyle = '#fff';
          for (let i = 0; i < 3; i++) {
            const a = t * 2 + i * 2.1;
            star(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3, r * 0.18, 4);
          }
          outlinedText('3', 0, r * 0.05, r * 0.9, '#fff', 'rgba(150,100,0,0.8)');
        }
      }
      ctx.restore();
    }
  };
  return g;
}

function drawStorm(x, y, r, t) {
  ctx.save();
  ctx.translate(x, y);
  // lightning under the cloud
  if (Math.sin(t * 9 + x) > 0.2) {
    ctx.strokeStyle = '#fff27a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-r * 0.1, r * 0.4); ctx.lineTo(r * 0.15, r * 0.9); ctx.lineTo(-r * 0.05, r * 0.95); ctx.lineTo(r * 0.2, r * 1.5);
    ctx.stroke();
  }
  ctx.fillStyle = '#4a4766';
  for (const [cx, cy, cr] of [[-0.55, 0.15, 0.5], [0, -0.2, 0.68], [0.55, 0.12, 0.52], [0, 0.3, 0.55]]) {
    ctx.beginPath();
    ctx.arc(cx * r, cy * r, cr * r, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(-r * 0.15, -r * 0.4, r * 0.32, 0, TAU);
  ctx.fill();
  // grumpy face
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-r * 0.4, -r * 0.18); ctx.lineTo(-r * 0.12, -r * 0.05);
  ctx.moveTo(r * 0.4, -r * 0.18); ctx.lineTo(r * 0.12, -r * 0.05);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-r * 0.24, r * 0.08, r * 0.07, 0, TAU); ctx.arc(r * 0.24, r * 0.08, r * 0.07, 0, TAU); ctx.fill();
  ctx.beginPath();
  ctx.arc(0, r * 0.42, r * 0.16, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
  ctx.restore();
}

function star(x, y, r, n = 5, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * TAU - Math.PI / 2;
    const rr = i % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const to = amt > 0 ? 255 : 0, k = Math.abs(amt);
  r = Math.round(r + (to - r) * k); g = Math.round(g + (to - g) * k); b = Math.round(b + (to - b) * k);
  return `rgb(${r},${g},${b})`;
}

// ======================================================================
// Game 2: Pump Dash, a sprint powered by pumping your arms
// ======================================================================
function Race() {
  const CPU = [
    { name: 'Bolt', c: '#ffc93c' },
    { name: 'Mochi', c: '#b38cff' },
    { name: 'Turbo', c: '#7bdc65' },
  ];
  const g = { id: 'race', t: 0, dur: 40, scores: [0, 0], runners: [], finished: 0, over: false };
  for (let i = 0; i < nPlayers; i++) g.runners.push({ human: i, name: 'P' + (i + 1), c: PCOL[i], d: 0, v: 0, energy: 0, place: 0, phase: 0, lastStep: 0 });
  for (const c of CPU.slice(0, 4 - nPlayers)) g.runners.push({ human: -1, name: c.name, c: c.c, d: 0, v: 0, pace: rand(1 / 15.5, 1 / 12.5), surge: rand(0, TAU), place: 0, phase: 0 });
  const placePts = [12, 8, 5, 2];
  g.update = (dt) => {
    g.t += dt;
    if (g.t < 0.01) return;
    for (const r of g.runners) {
      if (r.place) { r.v *= 1 - dt * 2; r.phase += r.v * dt * 60; continue; }
      let target;
      if (r.human >= 0) {
        const p = players.find((pp) => pp.idx === r.human);
        let e = 0;
        if (p) for (const h of p.hands) if (h.on) e += Math.abs(h.vy) / p.sw;
        // shoulder-widths per second of hand movement; brisk pumping is around 12-16
        r.energy += (e - r.energy) * ease(dt, 0.25);
        target = clamp(r.energy / 15, 0, 1.2) / 11.5;
      } else {
        target = r.pace * (1 + Math.sin(g.t * 0.9 + r.surge) * 0.18) * clamp01(g.t / 1.2);
      }
      r.v += (target - r.v) * ease(dt, r.human >= 0 ? 0.35 : 0.8);
      r.d += r.v * dt;
      r.phase += r.v * dt * 60;
      if (r.human >= 0 && Math.floor(r.phase / Math.PI) !== r.lastStep) { r.lastStep = Math.floor(r.phase / Math.PI); if (r.v > 0.02) S.step(r.human); }
      if (r.d >= 1) {
        r.d = 1;
        r.place = ++g.finished;
        r.time = g.t;
        if (r.human >= 0) {
          g.scores[r.human] = placePts[r.place - 1] + Math.max(0, Math.round((40 - g.t) / 4));
          S.fanfare();
          confetti(trackX(1), laneY(g.runners.indexOf(r)), r.c, 30, 1.2);
        }
      }
    }
    // the race ends when every human has finished
    if (g.runners.every((r) => r.human < 0 || r.place)) g.over = g.over || g.t;
    if (g.over && g.t - g.over > 1.6) g.done = true;
    // still running when time is up: place the rest by distance
    if (g.t >= g.dur && !g.done) {
      const left = g.runners.filter((r) => !r.place).sort((a, b) => b.d - a.d);
      for (const r of left) { r.place = ++g.finished; if (r.human >= 0) g.scores[r.human] = placePts[r.place - 1]; }
      g.done = true;
    }
  };
  const top = () => H * 0.66, bot = () => H - Math.max(16, U * 4);
  const trackX = (d) => lerp(W * 0.15, W * 0.9, d);
  const laneY = (i) => lerp(top() + U * 5, bot() - U * 3, (i + 0.5) / g.runners.length);
  g.draw = (t) => {
    const y0 = top(), y1 = bot();
    ctx.save();
    // track panel
    ctx.fillStyle = 'rgba(38, 34, 66, 0.88)';
    roundRect(W * 0.03, y0 - U * 1, W * 0.94, y1 - y0 + U * 2, U * 3);
    ctx.fill();
    const lh = (y1 - y0 - U * 6) / g.runners.length;
    g.runners.forEach((r, i) => {
      const ly = laneY(i);
      ctx.fillStyle = i % 2 ? '#d9653b' : '#e8774a';
      roundRect(W * 0.12, ly - lh * 0.42, W * 0.82, lh * 0.84, lh * 0.2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([U * 2, U * 2]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(W * 0.12, ly + lh * 0.42); ctx.lineTo(W * 0.94, ly + lh * 0.42); ctx.stroke();
      ctx.setLineDash([]);
    });
    // finish line
    const fx = trackX(1) + U * 2;
    const sq = U * 1.4;
    for (let yy = y0 + U * 1.5, row = 0; yy < y1 - U; yy += sq, row++) {
      for (let c = 0; c < 2; c++) { ctx.fillStyle = (row + c) % 2 ? '#fff' : '#222'; ctx.fillRect(fx + c * sq, yy, sq, sq); }
    }
    // runners
    g.runners.forEach((r, i) => {
      const x = trackX(r.d), y = laneY(i), s = Math.min(lh * 0.38, U * 4.2);
      drawRunner(x, y, s, r, t);
      ctx.font = `600 ${Math.round(U * 2.4)}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = r.human >= 0 ? r.c : 'rgba(255,255,255,0.8)';
      ctx.fillText(r.name, W * 0.11, y);
      if (r.place) outlinedText(['1st', '2nd', '3rd', '4th'][r.place - 1], x, y - s * 2, U * 3.4, r.place === 1 ? '#ffc93c' : '#fff');
    });
    ctx.restore();
    // pump meters by each player's body
    for (const p of players) {
      if (p.idx >= nPlayers) continue;
      const r = g.runners.find((rr) => rr.human === p.idx);
      if (!r || r.place) continue;
      const lvl = clamp01(r.energy / 15);
      const cx = p.head.x, cy = Math.max(p.head.y - p.head.r * 2.6, SAFE_TOP());
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = U * 1.6;
      ctx.strokeStyle = 'rgba(38, 34, 66, 0.8)';
      ctx.beginPath(); ctx.arc(cx, cy, U * 5, Math.PI * 0.8, Math.PI * 2.2); ctx.stroke();
      ctx.strokeStyle = lvl > 0.75 ? '#7bdc65' : lvl > 0.4 ? '#ffc93c' : '#ff5d73';
      ctx.beginPath(); ctx.arc(cx, cy, U * 5, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * lvl)); ctx.stroke();
      if (lvl < 0.5) outlinedText('PUMP!', cx, cy + Math.sin(t * 10) * 3, U * 3.4, '#fff');
      else outlinedText(lvl > 0.85 ? 'FAST!' : 'GO!', cx, cy, U * 3, '#fff');
      ctx.restore();
    }
  };
  return g;
}

function drawRunner(x, y, s, r, t) {
  ctx.save();
  ctx.translate(x, y);
  const ph = r.phase;
  const bob = Math.abs(Math.sin(ph)) * s * 0.25 * Math.min(1, r.v * 20);
  // legs
  ctx.strokeStyle = shade(r.c.startsWith('#') ? r.c : '#ffffff', -0.4);
  ctx.lineWidth = s * 0.28;
  ctx.lineCap = 'round';
  for (const k of [0, Math.PI]) {
    const a = Math.sin(ph + k) * 0.9 * Math.min(1, r.v * 20);
    ctx.beginPath();
    ctx.moveTo(0, s * 0.3 - bob);
    ctx.lineTo(Math.sin(a) * s * 0.8, s * 1.0 - Math.max(0, Math.cos(a + 1)) * s * 0.1);
    ctx.stroke();
  }
  // dust
  if (r.v > 0.03 && !r.place) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 3; i++) {
      const f = ((t * 3 + i / 3) % 1);
      ctx.beginPath();
      ctx.arc(-s * (0.8 + f * 1.6), s * 0.9 - f * s * 0.4, s * 0.2 * (1 - f), 0, TAU);
      ctx.fill();
    }
  }
  // body
  ctx.fillStyle = r.c;
  ctx.beginPath();
  ctx.ellipse(0, -bob, s * 0.85, s * 0.78, Math.min(0.35, r.v * 4), 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath(); ctx.ellipse(-s * 0.25, -bob - s * 0.35, s * 0.25, s * 0.15, -0.5, 0, TAU); ctx.fill();
  // eyes
  ctx.fillStyle = '#fff';
  for (const ex of [0.2, 0.5]) { ctx.beginPath(); ctx.ellipse(s * ex, -bob - s * 0.15, s * 0.14, s * 0.2, 0, 0, TAU); ctx.fill(); }
  ctx.fillStyle = '#231d3a';
  for (const ex of [0.25, 0.55]) { ctx.beginPath(); ctx.arc(s * ex, -bob - s * 0.12, s * 0.08, 0, TAU); ctx.fill(); }
  // headband for humans
  if (r.human >= 0) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.14;
    ctx.beginPath(); ctx.arc(0, -bob, s * 0.8, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  }
  ctx.restore();
}

// ======================================================================
// Game 3: Duck & Dodge
// ======================================================================
function Dodge() {
  const g = { id: 'dodge', t: 0, dur: 30, scores: [0, 0], items: [], spawnT: 0.6, beams: [], beamT: 4, inv: [0, 0], hits: [0, 0] };
  g.update = (dt) => {
    g.t += dt;
    g.spawnT -= dt;
    g.beamT -= dt;
    const live = players.filter((p) => p.idx < nPlayers);
    if (g.spawnT <= 0) {
      g.spawnT = lerp(0.75, 0.4, clamp01(g.t / g.dur)) * rand(0.7, 1.3) / (nPlayers > 1 ? 1.3 : 1);
      const roll = Math.random();
      const kind = roll < 0.42 ? 'coin' : roll < 0.5 ? 'star' : 'rock';
      let x = rand(W * 0.08, W * 0.92);
      // aim some drops near a head so there is always something to do
      if (live.length && Math.random() < 0.5) { const p = pick(live); x = clamp(p.head.x + rand(-1, 1) * p.head.r * 3, W * 0.05, W * 0.95); }
      const r = U * (kind === 'rock' ? rand(3.6, 5.2) : kind === 'star' ? 3.4 : 2.8);
      g.items.push({ kind, x, y: -r * 2, r, vy: U * rand(30, 42) * (1 + g.t / 40), rot: 0, vr: rand(-3, 3), dead: false });
    }
    if (g.beamT <= 0 && live.length && g.t < g.dur - 2) {
      g.beamT = rand(4.5, 6.5) - g.t / 15;
      const p = pick(live);
      // the beam aims at the head's current height; get out of its way
      const x0 = nPlayers > 1 ? (p.idx === 0 ? 0 : W / 2) : 0, x1 = nPlayers > 1 ? (p.idx === 0 ? W / 2 : W) : W;
      g.beams.push({ y: p.head.y, h: p.head.r * 1.1, t: 0, warn: 1.25, fire: 0.35, x0, x1, hit: [false, false] });
      S.warn();
    }
    for (const it of g.items) {
      it.y += it.vy * dt;
      it.rot += it.vr * dt;
      for (const p of live) {
        if (it.dead) break;
        if (Math.hypot(p.head.x - it.x, p.head.y - it.y) < p.head.r + it.r * 0.8) {
          it.dead = true;
          if (it.kind === 'rock') hurt(p, it.x, it.y);
          else {
            const pts = it.kind === 'star' ? 3 : 1;
            g.scores[p.idx] += pts;
            floatText(it.x, it.y - it.r, '+' + pts, '#ffd23f', it.kind === 'star' ? 6 : 4.5);
            confetti(it.x, it.y, '#ffd23f', 8, 0.7);
            it.kind === 'star' ? S.gold() : S.coin();
          }
        }
      }
    }
    g.items = g.items.filter((it) => !it.dead && it.y < H + it.r * 3);
    for (const b of g.beams) {
      const was = b.t;
      b.t += dt;
      if (b.t < b.warn && Math.floor(b.t * 6) !== Math.floor(was * 6)) S.warn();
      if (was < b.warn && b.t >= b.warn) S.zap();
      if (b.t >= b.warn && b.t < b.warn + b.fire) {
        for (const p of live) {
          if (b.hit[p.idx] || p.head.x < b.x0 || p.head.x > b.x1) continue;
          if (Math.abs(p.head.y - b.y) < b.h / 2 + p.head.r * 0.55) { b.hit[p.idx] = true; hurt(p, p.head.x, b.y); }
        }
      }
      if (b.t >= b.warn + b.fire && !b.scored) {
        b.scored = true;
        for (const p of live) if (!b.hit[p.idx] && p.head.x >= b.x0 && p.head.x <= b.x1) { g.scores[p.idx] += 2; floatText(p.head.x, p.head.y - p.head.r * 1.6, 'Dodged! +2', '#7bdc65', 4.5); S.coin(); }
      }
    }
    g.beams = g.beams.filter((b) => b.t < b.warn + b.fire + 0.3);
    g.inv = g.inv.map((v) => Math.max(0, v - dt));
  };
  function hurt(p, x, y) {
    if (g.inv[p.idx] > 0) return;
    g.inv[p.idx] = 1.1;
    g.hits[p.idx]++;
    g.scores[p.idx] = Math.max(0, g.scores[p.idx] - 3);
    floatText(x, y, 'OUCH -3', '#ff8fa0', 5.5);
    confetti(x, y, '#8d86b8', 12, 0.9);
    S.hit();
    shake = 0.35;
  }
  g.draw = (t) => {
    // beams first so items fall over them
    for (const b of g.beams) {
      ctx.save();
      if (b.t < b.warn) {
        const blink = Math.floor(b.t * 8) % 2 === 0;
        ctx.fillStyle = `rgba(255, 60, 90, ${blink ? 0.32 : 0.14})`;
        ctx.fillRect(b.x0, b.y - b.h / 2, b.x1 - b.x0, b.h);
        ctx.strokeStyle = 'rgba(255, 80, 110, 0.9)';
        ctx.setLineDash([U * 2, U * 1.5]);
        ctx.lineWidth = 3;
        ctx.strokeRect(b.x0 + 2, b.y - b.h / 2, b.x1 - b.x0 - 4, b.h);
        ctx.setLineDash([]);
        outlinedText('MOVE!', (b.x0 + b.x1) / 2, b.y - b.h / 2 - U * 3, U * 4, '#ff6b85');
        // countdown pips
        const left = 1 - b.t / b.warn;
        ctx.fillStyle = '#ff6b85';
        ctx.fillRect(b.x0, b.y + b.h / 2 + 4, (b.x1 - b.x0) * left, 5);
      } else if (b.t < b.warn + b.fire) {
        const f = (b.t - b.warn) / b.fire;
        const gr = ctx.createLinearGradient(0, b.y - b.h / 2, 0, b.y + b.h / 2);
        gr.addColorStop(0, 'rgba(255,60,120,0)');
        gr.addColorStop(0.5, `rgba(255,255,255,${1 - f * 0.5})`);
        gr.addColorStop(1, 'rgba(255,60,120,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(b.x0, b.y - b.h / 2, b.x1 - b.x0, b.h);
        ctx.fillStyle = `rgba(255, 70, 120, ${0.8 - f * 0.6})`;
        ctx.fillRect(b.x0, b.y - b.h * 0.12, b.x1 - b.x0, b.h * 0.24);
      }
      ctx.restore();
    }
    for (const it of g.items) {
      ctx.save();
      ctx.translate(it.x, it.y);
      if (it.kind === 'rock') {
        ctx.rotate(it.rot);
        ctx.fillStyle = '#6c5f8f';
        ctx.beginPath();
        for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU; const rr = it.r * (i % 2 ? 0.78 : 1.12); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#8f83b8';
        ctx.beginPath(); ctx.arc(-it.r * 0.2, -it.r * 0.25, it.r * 0.4, 0, TAU); ctx.fill();
        ctx.rotate(-it.rot);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(-it.r * 0.25, 0, it.r * 0.17, 0, TAU); ctx.arc(it.r * 0.25, 0, it.r * 0.17, 0, TAU); ctx.fill();
        ctx.fillStyle = '#1d1830';
        ctx.beginPath(); ctx.arc(-it.r * 0.22, it.r * 0.05, it.r * 0.08, 0, TAU); ctx.arc(it.r * 0.28, it.r * 0.05, it.r * 0.08, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#1d1830'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-it.r * 0.45, -it.r * 0.3); ctx.lineTo(-it.r * 0.1, -it.r * 0.15); ctx.moveTo(it.r * 0.45, -it.r * 0.3); ctx.lineTo(it.r * 0.1, -it.r * 0.15); ctx.stroke();
      } else if (it.kind === 'coin') {
        const sx = Math.abs(Math.cos(t * 5 + it.x));
        ctx.fillStyle = '#e8a317';
        ctx.beginPath(); ctx.ellipse(0, 0, it.r * Math.max(0.15, sx), it.r, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath(); ctx.ellipse(0, 0, it.r * Math.max(0.1, sx) * 0.78, it.r * 0.78, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(-it.r * 0.1 * sx, -it.r * 0.45, it.r * 0.2 * sx, it.r * 0.9);
      } else {
        ctx.rotate(t * 2);
        ctx.fillStyle = '#ffd23f';
        star(0, 0, it.r * 1.2, 5, 0.5);
        ctx.fillStyle = '#fff6c4';
        star(0, 0, it.r * 0.6, 5, 0.5);
      }
      ctx.restore();
    }
    // a halo marks each head, the part of you that collects and gets hit
    for (const p of players) {
      if (p.idx >= nPlayers) continue;
      ctx.save();
      const inv = g.inv[p.idx];
      ctx.globalAlpha = inv > 0 && Math.floor(inv * 12) % 2 ? 0.25 : 0.9;
      ctx.strokeStyle = inv > 0 ? '#ff5d73' : p.color;
      ctx.lineWidth = U * 0.8;
      ctx.setLineDash([U * 2.5, U * 1.5]);
      ctx.lineDashOffset = -t * 30;
      ctx.beginPath(); ctx.arc(p.head.x, p.head.y, p.head.r, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  };
  return g;
}

// ======================================================================
// Game 4: Strike a Pose, match the outline before the wall arrives
// ======================================================================
// Arm angles in degrees for each arm as [upper arm, forearm], measured from straight
// down (0) through out to the side (90) to straight up (180). "near" is the arm on the
// screen's left, "far" the one on the right.
const POSES = [
  { name: 'Touchdown', l: [170, 175], r: [170, 175] },
  { name: 'Letter T', l: [90, 90], r: [90, 90] },
  { name: 'Letter Y', l: [140, 145], r: [140, 145] },
  { name: 'Strong!', l: [90, 175], r: [90, 175] },
  { name: 'Disco', l: [150, 155], r: [30, 30] },
  { name: 'Disco', l: [30, 30], r: [150, 155] },
  { name: 'Hand up', l: [170, 175], r: [10, 10] },
  { name: 'Hand up', l: [10, 10], r: [170, 175] },
  { name: 'Airplane', l: [120, 120], r: [60, 60] },
  { name: 'Airplane', l: [60, 60], r: [120, 120] },
  { name: 'Letter L', l: [175, 178], r: [90, 90] },
  { name: 'Letter L', l: [90, 90], r: [175, 178] },
  { name: 'Wings', l: [45, 45], r: [45, 45] },
];

// angle of a screen-space segment for the arm on side s (0 = screen-left arm)
function segAngle(a, b, s) {
  const out = s === 0 ? a.x - b.x : b.x - a.x; // away from the body
  const down = b.y - a.y;
  let deg = (Math.atan2(out, down) * 180) / Math.PI; // 0 down, 90 out, 180 up
  if (deg < -60) deg += 360; // arms crossed far over the head wrap round
  return deg;
}
function armAngles(p) {
  const P = p.pts;
  return [
    [segAngle(P[11], P[13], 0), segAngle(P[13], P[15], 0)],
    [segAngle(P[12], P[14], 1), segAngle(P[14], P[16], 1)],
  ];
}
function angDiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function Walls() {
  const order = POSES.slice().sort(() => Math.random() - 0.5);
  // avoid the same pose twice in a row
  for (let i = 1; i < order.length; i++) if (order[i].name === order[i - 1].name) order.push(order.splice(i, 1)[0]);
  const g = { id: 'pose', t: 0, scores: [0, 0], n: 8, i: 0, wall: null, gap: 1, results: [], judged: [] };
  const next = () => {
    if (g.i >= g.n) { g.done = true; return; }
    const pose = order[g.i % order.length];
    g.wall = { pose, t: 0, dur: lerp(5, 3.2, g.i / (g.n - 1)), match: [0, 0], best: [0, 0] };
    g.i++;
    S.whoosh();
  };
  g.update = (dt) => {
    g.t += dt;
    if (!g.wall) {
      g.gap -= dt;
      if (g.gap <= 0) next();
      return;
    }
    const w = g.wall;
    w.t += dt;
    for (const p of players) {
      if (p.idx >= nPlayers) continue;
      const A = armAngles(p);
      const tg = [w.pose.l, w.pose.r];
      let err = 0;
      for (let s = 0; s < 2; s++) for (let k = 0; k < 2; k++) err += angDiff(A[s][k], tg[s][k]);
      err /= 4;
      // the arms only need to be close; held a little loosely
      const m = clamp01(1 - (err - 12) / 45);
      w.match[p.idx] += (m - w.match[p.idx]) * ease(dt, 0.12);
      if (w.t > w.dur - 0.6) w.best[p.idx] = Math.max(w.best[p.idx], w.match[p.idx]);
      p.armErr = A.map((a, s) => a.map((v, k) => angDiff(v, tg[s][k])));
    }
    if (w.t >= w.dur) {
      g.judged = [];
      let bestQ = 0;
      for (let i = 0; i < nPlayers; i++) {
        const m = Math.max(w.best[i], w.match[i]);
        const q = m > 0.8 ? 3 : m > 0.6 ? 2 : m > 0.4 ? 1 : 0;
        bestQ = Math.max(bestQ, q);
        g.scores[i] += q;
        g.judged.push(q);
        const p = players.find((pp) => pp.idx === i);
        const x = p ? p.head.x : W / 2, y = p ? p.head.y - p.head.r * 2 : H / 2;
        floatText(x, y, ['MISS', 'OK +1', 'GOOD +2', 'PERFECT +3'][q], ['#ff8fa0', '#fff', '#2ec4f1', '#ffd23f'][q], q === 3 ? 7 : 5.5);
        if (q >= 2 && p) confetti(x, y, null, q === 3 ? 30 : 14);
      }
      S.judge(bestQ);
      if (bestQ === 0) shake = 0.25;
      g.flash = 0.3;
      g.wall = null;
      g.gap = 0.9;
    }
  };
  g.draw = (t) => {
    if (g.flash > 0) {
      g.flash -= 1 / 60;
      ctx.fillStyle = `rgba(255,255,255,${g.flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    const w = g.wall;
    if (!w) return;
    const f = clamp01(w.t / w.dur);
    const s = lerp(0.18, 1.02, f * f); // the wall rushes toward you
    const cx = W / 2, cy = H * 0.5;
    const ww = W * s, wh = H * s;
    ctx.save();
    // wall frame: a chunky striped border, open in the middle so you stay visible
    const th = Math.max(8, U * 4 * s);
    ctx.lineWidth = th;
    ctx.strokeStyle = '#7a5cf0';
    roundRect(cx - ww / 2 + th / 2, cy - wh / 2 + th / 2, ww - th, wh - th, th);
    ctx.stroke();
    ctx.setLineDash([th * 1.2, th * 1.2]);
    ctx.lineDashOffset = -t * 40;
    ctx.strokeStyle = '#ffc93c';
    ctx.lineWidth = th * 0.35;
    ctx.stroke();
    ctx.setLineDash([]);
    // pose name on the wall
    outlinedText(w.pose.name.toUpperCase(), cx, cy - wh / 2 + th + U * 4 * Math.max(0.6, s), U * 6 * Math.max(0.55, s), '#ffc93c');
    // timer bar
    ctx.fillStyle = 'rgba(38,34,66,0.8)';
    roundRect(cx - U * 20, H - U * 8, U * 40, U * 2.4, U * 1.2);
    ctx.fill();
    ctx.fillStyle = f > 0.75 ? '#ff5d73' : '#ffc93c';
    roundRect(cx - U * 20, H - U * 8, U * 40 * (1 - f), U * 2.4, U * 1.2);
    ctx.fill();
    ctx.restore();
    // ghost outline on each player's body
    for (const p of players) {
      if (p.idx >= nPlayers) continue;
      drawGhost(p, w.pose, w.match[p.idx], t, f);
    }
  };
  return g;
}

function drawGhost(p, pose, match, t, f) {
  const P = p.pts;
  const up = p.sw * 0.95, fore = p.sw * 0.9;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  [pose.l, pose.r].forEach((ang, s) => {
    const sh = s === 0 ? P[11] : P[12];
    const dir = s === 0 ? -1 : 1; // outward on screen
    const a1 = (ang[0] * Math.PI) / 180, a2 = (ang[1] * Math.PI) / 180;
    const e = { x: sh.x + Math.sin(a1) * dir * up, y: sh.y + Math.cos(a1) * up };
    const w = { x: e.x + Math.sin(a2) * dir * fore, y: e.y + Math.cos(a2) * fore };
    const err = p.armErr ? (p.armErr[s][0] + p.armErr[s][1]) / 2 : 90;
    const good = err < 28;
    ctx.globalAlpha = 0.45 + f * 0.45;
    ctx.strokeStyle = 'rgba(30, 24, 52, 0.55)';
    ctx.lineWidth = p.sw * 0.34;
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(e.x, e.y); ctx.lineTo(w.x, w.y); ctx.stroke();
    ctx.strokeStyle = good ? '#7bdc65' : '#ffffff';
    ctx.shadowColor = good ? '#7bdc65' : '#ffffff';
    ctx.shadowBlur = 16;
    ctx.lineWidth = p.sw * 0.22;
    ctx.setLineDash(good ? [] : [p.sw * 0.15, p.sw * 0.12]);
    ctx.lineDashOffset = -t * 60;
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(e.x, e.y); ctx.lineTo(w.x, w.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.fillStyle = good ? '#7bdc65' : '#ffffff';
    ctx.beginPath(); ctx.arc(w.x, w.y, p.sw * 0.17, 0, TAU); ctx.fill();
  });
  // match meter
  ctx.globalAlpha = 1;
  const cx = p.head.x, cy = Math.max(p.head.y - p.head.r * 2.3, SAFE_TOP());
  ctx.lineCap = 'round';
  ctx.lineWidth = U * 1.4;
  ctx.strokeStyle = 'rgba(38,34,66,0.8)';
  ctx.beginPath(); ctx.arc(cx, cy, U * 4.2, 0, TAU); ctx.stroke();
  ctx.strokeStyle = match > 0.8 ? '#ffd23f' : match > 0.6 ? '#2ec4f1' : match > 0.4 ? '#fff' : '#ff5d73';
  ctx.beginPath(); ctx.arc(cx, cy, U * 4.2, -Math.PI / 2, -Math.PI / 2 + TAU * match); ctx.stroke();
  outlinedText(Math.round(match * 100) + '%', cx, cy, U * 2.6);
  ctx.restore();
}

// ======================================================================
// Flow: menu → intro → countdown → play → results (→ next game) → final
// ======================================================================
const GAMES = {
  balloons: { name: 'Balloon Burst', icon: '🎈', make: Balloons, how: 'Pop balloons with your hands. Gold ones are worth 3. Keep away from the grumpy storm clouds!', short: 'Pop with your hands', stars: [12, 24, 36], unit: 'points' },
  race: { name: 'Pump Dash', icon: '🏃', make: Race, how: 'Pump your arms up and down as fast as you can to sprint. Beat Bolt, Mochi and Turbo to the finish line!', short: 'Pump your arms to sprint', stars: [5, 10, 14], unit: 'points' },
  dodge: { name: 'Duck & Dodge', icon: '⚡', make: Dodge, how: 'Move your head to grab coins and dodge the falling rocks. When a red stripe flashes at your head, duck or stand tall before it zaps!', short: 'Move your head', stars: [10, 20, 32], unit: 'points' },
  pose: { name: 'Strike a Pose', icon: '🕺', make: Walls, how: 'A wall is coming! Match the glowing outline with your arms before it arrives. It turns green when you’re close.', short: 'Copy the outline', stars: [8, 14, 20], unit: 'points' },
};
const ORDER = ['balloons', 'race', 'dodge', 'pose'];

let phase = 'menu'; // menu | intro | countdown | play | result | final
let phaseT = 0;
let game = null;
let gameId = null;
let party = null; // { list, i, stars: [n, n] } when playing the full party
let paused = false;
let shake = 0;
let raiseT = 0; // hands-up hold timer
let best = {};
try { best = JSON.parse(localStorage.getItem('mood-party-best') || '{}') || {}; } catch (e) { best = {}; }
function saveBest() { try { localStorage.setItem('mood-party-best', JSON.stringify(best)); } catch (e) { /* private mode */ } }

function starsFor(id, score) {
  const th = GAMES[id].stars;
  return score >= th[2] ? 3 : score >= th[1] ? 2 : score >= th[0] ? 1 : 0;
}
function starRow(n, of = 3) {
  return '<span>' + '★'.repeat(n) + '</span><span class="off">' + '★'.repeat(Math.max(0, of - n)) + '</span>';
}

function showCard(html, small = false) {
  card.innerHTML = html;
  card.classList.toggle('small', small);
  card.hidden = false;
  // restart the pop-in animation
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
}
function hideCard() { card.hidden = true; }

function showMenu() {
  phase = 'menu';
  phaseT = 0;
  game = null;
  party = null;
  bar.hidden = true;
  const tiles = ORDER.map((id) => {
    const G = GAMES[id];
    const b = best[id] != null ? ` · best ${best[id]}` : '';
    return `<button class="game-tile" data-game="${id}"><span class="ic" aria-hidden="true">${G.icon}</span><b>${G.name}</b><small>${G.short}${b}</small></button>`;
  }).join('');
  showCard(`
    <h2>Pick a game</h2>
    <p>Play all four as a party, or jump into one. Two people side by side? It becomes a head-to-head.</p>
    <button class="party-btn" data-game="party">Start the party</button>
    <div class="games">${tiles}</div>
    <p class="muted">Or raise both hands above your head to start the party.</p>`);
}

card.addEventListener('click', (e) => {
  const b = e.target.closest('[data-game],[data-act]');
  if (!b) return;
  sfx.init();
  if (b.dataset.game) {
    if (b.dataset.game === 'party') startParty();
    else { party = null; startGame(b.dataset.game); }
  } else if (b.dataset.act === 'next') advance();
  else if (b.dataset.act === 'again') startGame(gameId);
  else if (b.dataset.act === 'menu') showMenu();
});

function startParty() {
  party = { list: ORDER.slice(), i: 0, stars: [0, 0], totals: [0, 0] };
  startGame(party.list[0]);
}

function startGame(id) {
  gameId = id;
  phase = 'intro';
  phaseT = 0;
  game = null;
  parts.length = 0;
  const G = GAMES[id];
  const round = party ? `<p class="muted" style="margin:0 0 6px">Game ${party.i + 1} of ${party.list.length}</p>` : '';
  showCard(`${round}<div class="big-icon" aria-hidden="true">${G.icon}</div><h2>${G.name}</h2><p>${G.how}</p><p class="muted">Get ready…</p>`);
  bar.hidden = true;
}

function beginCountdown() {
  hideCard();
  phase = 'countdown';
  phaseT = 0;
  nPlayers = clamp(players.length, 1, 2);
  game = GAMES[gameId].make();
  bar.hidden = false;
  barGame.textContent = GAMES[gameId].name;
  S.beep();
}

function finishGame() {
  phase = 'result';
  phaseT = 0;
  const G = GAMES[gameId];
  const sc = game.scores.slice(0, nPlayers);
  let isBest = false;
  const top = Math.max(...sc);
  if (best[gameId] == null || top > best[gameId]) { best[gameId] = top; saveBest(); isBest = true; }
  let html = `<div class="big-icon" aria-hidden="true">${G.icon}</div><h2>${G.name}</h2>`;
  let stars;
  if (nPlayers === 1) {
    stars = [starsFor(gameId, sc[0]), 0];
    html += `<div class="stars">${starRow(stars[0])}</div><div class="results"><div class="result p1"><div class="who">Score</div><div class="pts">${sc[0]}</div></div></div>`;
    html += `<p>${['Warm-up round. You’ll get it next time!', 'Nice moves!', 'Great job!', 'Superstar!'][stars[0]]}${isBest ? ' New best!' : ''}</p>`;
  } else {
    const win = sc[0] === sc[1] ? -1 : sc[0] > sc[1] ? 0 : 1;
    stars = [0, 1].map((i) => (win === -1 ? 2 : i === win ? 3 : 1));
    html += `<div class="results">${[0, 1].map((i) => `<div class="result p${i + 1}"><div class="crown">${i === win ? '👑' : '&nbsp;'}</div><div class="who">Player ${i + 1}</div><div class="pts">${sc[i]}</div><div class="stars">${starRow(stars[i])}</div></div>`).join('')}</div>`;
    html += `<p>${win === -1 ? 'A tie!' : `Player ${win + 1} wins this one!`}</p>`;
  }
  if (party) {
    for (let i = 0; i < 2; i++) { party.stars[i] += stars[i]; party.totals[i] += sc[i] || 0; }
    const last = party.i >= party.list.length - 1;
    html += `<div class="card-row"><button class="party-btn" data-act="next">${last ? 'See the results' : 'Next game'}</button></div><p class="muted">Next up in a few seconds, or raise both hands.</p>`;
  } else {
    html += `<div class="card-row"><button class="party-btn" data-act="again">Play again</button><button class="party-btn alt" data-act="menu">All games</button></div>`;
  }
  showCard(html);
  S.fanfare();
  confetti(W / 2, H * 0.3, null, 50, 1.4);
  bar.hidden = true;
}

function advance() {
  if (!party) return showMenu();
  party.i++;
  if (party.i < party.list.length) return startGame(party.list[party.i]);
  // the grand finale
  phase = 'final';
  phaseT = 0;
  const st = party.stars;
  let html = '<div class="big-icon" aria-hidden="true">🏆</div><h2>Party results</h2>';
  if (nPlayers === 1) {
    const max = party.list.length * 3;
    const title = st[0] >= 11 ? 'Party Legend' : st[0] >= 8 ? 'Dance-floor Hero' : st[0] >= 5 ? 'Rising Star' : 'Party Rookie';
    html += `<div class="stars">★ ${st[0]} / ${max}</div><p>You are a <b>${title}</b>!</p>`;
  } else {
    const win = st[0] === st[1] ? (party.totals[0] === party.totals[1] ? -1 : party.totals[0] > party.totals[1] ? 0 : 1) : st[0] > st[1] ? 0 : 1;
    html += `<div class="results">${[0, 1].map((i) => `<div class="result p${i + 1}"><div class="crown">${i === win ? '👑' : '&nbsp;'}</div><div class="who">Player ${i + 1}</div><div class="pts">★ ${st[i]}</div></div>`).join('')}</div>`;
    html += `<p>${win === -1 ? 'Dead heat! Rematch?' : `Player ${win + 1} is the party champion!`}</p>`;
  }
  html += `<div class="card-row"><button class="party-btn" data-game="party">Party again</button><button class="party-btn alt" data-act="menu">All games</button></div>`;
  showCard(html);
  S.fanfare();
  for (let i = 0; i < 4; i++) setTimeout(() => confetti(rand(W * 0.2, W * 0.8), H * 0.3, null, 40, 1.5), i * 250);
}

function updateBar() {
  if (bar.hidden || !game) return;
  const G = GAMES[gameId];
  let time;
  if (gameId === 'pose') time = `${Math.min(game.i, game.n)}/${game.n}`;
  else time = Math.max(0, Math.ceil((game.dur - game.t))) + 's';
  if (barTime.textContent !== time) barTime.textContent = time;
  const sc = game.scores.slice(0, nPlayers).map((s, i) => `<span class="chip p${i + 1}">${nPlayers > 1 ? 'P' + (i + 1) + ' ' : ''}${s}</span>`).join('');
  if (barScores.innerHTML !== sc) barScores.innerHTML = sc;
  barGame.textContent = G.name;
}

// ======================================================================
// Main loop
// ======================================================================
function setStatus(st, text) { if (statusEl.dataset.state !== st) statusEl.dataset.state = st; if (statusText.textContent !== text) statusText.textContent = text; }
function setHint(text) { if (hint.textContent !== text) hint.textContent = text; }

let last = performance.now();
let lostT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;
  if (tracker) tracker.update(now);
  buildPlayers(dt);

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (shake > 0) {
    shake -= dt;
    const m = shake * U * 3;
    ctx.translate(rand(-m, m), rand(-m, m));
  }

  const someone = players.length > 0;
  lostT = someone ? 0 : lostT + dt;
  if (tracker?.running || tracker?.fake) setStatus(someone ? 'active' : 'searching', someone ? (players.length > 1 ? 'two players in view' : 'you’re in view') : 'step into view');

  phaseT += dt;
  // raise both hands to start / continue
  const raised = players.some(handsUp);
  if ((phase === 'menu' || phase === 'result' || phase === 'final') && raised) raiseT += dt; else raiseT = 0;
  if (raiseT > 1.1) {
    raiseT = 0;
    sfx.init();
    if (phase === 'menu' || phase === 'final') startParty();
    else if (phase === 'result') party ? advance() : startGame(gameId);
  }

  if (phase === 'intro') {
    if (phaseT > 4.2 && someone) beginCountdown();
    setHint(someone ? '' : 'Step back so the camera can see your head, shoulders and hands.');
  } else if (phase === 'countdown') {
    const n = 3 - Math.floor(phaseT);
    if (Math.floor(phaseT) !== Math.floor(phaseT - dt) && n >= 1) S.beep();
    if (phaseT >= 3) { phase = 'play'; phaseT = 0; S.go(); }
    nPlayers = Math.max(nPlayers, clamp(players.length, 1, 2));
    setHint('');
  } else if (phase === 'play') {
    paused = lostT > 0.8 && !tracker?.fake;
    if (!paused) {
      game.update(dt, t);
      if (game.done || (game.dur && game.t >= game.dur && gameId !== 'race')) finishGame();
    }
    setHint(paused ? 'Paused. Come back into view to keep playing.' : '');
  } else if (phase === 'result') {
    if (party && phaseT > 6) advance();
    setHint('');
  } else if (phase === 'menu') {
    setHint(someone ? '' : 'Step into view so the camera can see you.');
  } else setHint('');

  if (game && (phase === 'play' || phase === 'countdown')) game.draw(t);
  drawPlayers(t);
  stepParts(dt);
  drawParts();

  if (phase === 'countdown') {
    const n = 3 - Math.floor(phaseT);
    const f = phaseT % 1;
    outlinedText(n > 0 ? String(n) : 'GO!', W / 2, H * 0.45, U * (22 + f * 6), n > 0 ? '#ffc93c' : '#7bdc65', 'rgba(30,24,52,0.9)');
  } else if (phase === 'play' && phaseT < 0.7) {
    ctx.globalAlpha = 1 - phaseT / 0.7;
    outlinedText('GO!', W / 2, H * 0.45, U * (28 + phaseT * 20), '#7bdc65');
    ctx.globalAlpha = 1;
  }
  if (raiseT > 0) {
    // progress ring around the raised hands
    for (const p of players) if (handsUp(p)) {
      ctx.lineWidth = U * 1.2;
      ctx.strokeStyle = '#ffc93c';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(p.head.x, Math.max(p.head.y - p.head.r * 2.4, SAFE_TOP()), U * 4, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(raiseT / 1.1));
      ctx.stroke();
    }
  }
  ctx.restore();
  updateBar();
}
requestAnimationFrame(frame);

setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
$('btn-menu').addEventListener('click', () => { sfx.init(); showMenu(); });

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Warming up…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new PoseTracker(video, { numPoses: 2 });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    showMenu();
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Body tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

// testing hook: window.party.fake([makePose(...)]) feeds landmarks without a camera
window.party = {
  get phase() { return phase; },
  get game() { return game; },
  get players() { return players; },
  get nPlayers() { return nPlayers; },
  makePose,
  fake(list) { tracker ||= new PoseTracker(video); tracker.fake = list; },
  start(id) { sfx.init(); if (id === 'party') startParty(); else { party = null; startGame(id); } },
  skipIntro() { phaseT = 99; },
  menu: showMenu,
  armAngles: () => players.map(armAngles),
  POSES,
};
