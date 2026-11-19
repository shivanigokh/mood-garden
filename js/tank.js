// FISH TANK: an aquarium you play with your hands.
// Point and the fish follow your finger, pinch to sprinkle food, wave an open hand to
// push a current, swipe fast to scatter them. Draw your own fish (mouse, touch, or by
// pinching in the air) and release it: it swims with a body wave like the others.

import { Tracker } from './tracking.js?v=8';
import { clamp01, clamp, lerp, ease, cameraErrorMessage, toScreen, Sfx, setupToggle } from './shared.js?v=8';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('tank');
const ctx = canvas.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const hint = $('hint');
const countEl = $('count');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const mirror = $('mirror');
const guide = $('guide');

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ======================================================================
// Tank geometry and the painted background
// ======================================================================
let W = 0, H = 0, DPR = 1, S = 1, SURF = 0, SAND = 0;
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');
let decor = null;

function sandY(x) {
  return SAND + Math.sin(x * 0.006 + 1) * H * 0.018 + Math.sin(x * 0.017 + 2) * H * 0.008;
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  S = Math.min(W, H);
  SURF = H * 0.07;
  SAND = H * 0.83;
  bg.width = canvas.width;
  bg.height = canvas.height;
  bgx.setTransform(DPR, 0, 0, DPR, 0, 0);
  buildDecor();
  paintBackground();
}

function buildDecor() {
  // fixed layout with a little randomness, rebuilt on resize
  const rng = mulberry(7);
  const plants = [];
  const spots = [0.06, 0.15, 0.27, 0.42, 0.58, 0.7, 0.83, 0.94];
  spots.forEach((fx, i) => {
    const x = W * fx + (rng() - 0.5) * W * 0.03;
    const n = 3 + Math.floor(rng() * 3);
    const hue = pick([[118, 45, 34], [140, 50, 30], [160, 45, 32], [95, 50, 36], [28, 60, 42]]);
    const front = i % 3 === 1;
    for (let k = 0; k < n; k++) {
      plants.push({
        x: x + (k - n / 2) * S * 0.012,
        h: H * (0.16 + rng() * 0.22) * (front ? 0.8 : 1),
        w: S * (0.009 + rng() * 0.007),
        ph: rng() * TAU,
        col: `hsl(${hue[0] + (rng() - 0.5) * 16}, ${hue[1]}%, ${hue[2] + (rng() - 0.5) * 10}%)`,
        front,
        bend: 0,
      });
    }
  });
  const rocks = [];
  for (const [fx, sz] of [[0.2, 0.09], [0.24, 0.05], [0.66, 0.11], [0.73, 0.06], [0.5, 0.04], [0.9, 0.07]]) {
    rocks.push({ x: W * fx, r: S * sz, seed: rng() });
  }
  const corals = [{ x: W * 0.36, s: S * 0.12, c: '#ff7f8e' }, { x: W * 0.79, s: S * 0.1, c: '#c38bff' }, { x: W * 0.09, s: S * 0.08, c: '#ff9f5a' }];
  decor = { plants, rocks, corals, chest: { x: W * 0.55, y: 0, s: S * 0.075 } };
  decor.chest.y = sandY(decor.chest.x) + decor.chest.s * 0.15;
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function paintBackground() {
  const c = bgx;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#5cc8d8');
  g.addColorStop(0.18, '#2a9fbd');
  g.addColorStop(0.6, '#136f93');
  g.addColorStop(1, '#0a4663');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // far rocks and hills, hazy
  c.fillStyle = 'rgba(14, 82, 110, 0.55)';
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 20) c.lineTo(x, SAND - H * 0.1 - Math.sin(x * 0.004) * H * 0.06 - Math.sin(x * 0.011 + 1) * H * 0.03);
  c.lineTo(W, H);
  c.fill();
  c.fillStyle = 'rgba(10, 70, 96, 0.6)';
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 20) c.lineTo(x, SAND - H * 0.04 - Math.sin(x * 0.007 + 2) * H * 0.04);
  c.lineTo(W, H);
  c.fill();
  // sand
  const sg = c.createLinearGradient(0, SAND - H * 0.03, 0, H);
  sg.addColorStop(0, '#d9c58f');
  sg.addColorStop(0.4, '#c9ae74');
  sg.addColorStop(1, '#9c8352');
  c.fillStyle = sg;
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 8) c.lineTo(x, sandY(x));
  c.lineTo(W, H);
  c.fill();
  // ripples and pebbles
  const rng = mulberry(3);
  c.strokeStyle = 'rgba(120, 95, 50, 0.25)';
  c.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    const x = rng() * W, y = sandY(x) + 10 + rng() * (H - SAND);
    c.beginPath();
    c.ellipse(x, y, S * (0.02 + rng() * 0.04), S * 0.004, 0, Math.PI, TAU);
    c.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const x = rng() * W, y = sandY(x) + 6 + rng() * (H - SAND);
    const r = S * (0.002 + rng() * 0.006);
    c.fillStyle = pick(['#8d7a5a', '#b9a37a', '#6f6a62', '#e8dcc0', '#a07656']);
    c.beginPath();
    c.ellipse(x, y, r * 1.3, r, rng() * 3, 0, TAU);
    c.fill();
  }
  // rocks
  for (const r of decor.rocks) drawRock(c, r);
  // vignette in the corners of the glass
  const v = c.createRadialGradient(W / 2, H * 0.45, S * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0, 25, 40, 0.35)');
  c.fillStyle = v;
  c.fillRect(0, 0, W, H);
}

function drawRock(c, r) {
  const rng = mulberry(Math.floor(r.seed * 1000));
  const y = sandY(r.x) + r.r * 0.25;
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + (i / 10) * Math.PI;
    const rr = r.r * (0.8 + rng() * 0.35);
    pts.push([r.x + Math.cos(a) * rr * 1.35, y + Math.sin(a) * rr * 0.9]);
  }
  const g = c.createLinearGradient(r.x, y - r.r, r.x, y);
  g.addColorStop(0, '#7d8c90');
  g.addColorStop(1, '#3f4b52');
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const m = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
    c.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], m[0], m[1]);
  }
  c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.12)';
  c.beginPath();
  c.ellipse(r.x - r.r * 0.3, y - r.r * 0.6, r.r * 0.4, r.r * 0.15, -0.3, 0, TAU);
  c.fill();
  c.fillStyle = 'rgba(80, 140, 70, 0.35)'; // a little algae
  c.beginPath();
  c.ellipse(r.x + r.r * 0.2, y - r.r * 0.75, r.r * 0.35, r.r * 0.1, 0.2, 0, TAU);
  c.fill();
}

window.addEventListener('resize', resize);

// ======================================================================
// Water current: short-lived pushes from hands and the mouse
// ======================================================================
const pushes = [];
function addPush(x, y, vx, vy, r, life = 0.6) {
  pushes.push({ x, y, vx, vy, r, life, max: life });
  if (pushes.length > 60) pushes.shift();
}
function currentAt(x, y) {
  let cx = 0, cy = 0;
  for (const p of pushes) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > p.r) continue;
    const f = (1 - d / p.r) ** 2 * (p.life / p.max);
    cx += p.vx * f;
    cy += p.vy * f;
  }
  return { x: cx, y: cy };
}

// ======================================================================
// Fish
// ======================================================================
// Each species: body length, depth profile, colours and how it swims.
const SPECIES = {
  clown: { len: 0.115, depth: 0.2, speed: 0.11, tail: 'round', school: 0.15, prof: [0.3, 0.2], n: 4 },
  tetra: { len: 0.07, depth: 0.12, speed: 0.17, tail: 'fork', school: 1, prof: [0.28, 0.25], n: 10 },
  angel: { len: 0.115, depth: 0.36, speed: 0.07, tail: 'lyre', school: 0.3, prof: [0.38, 0.12], n: 2 },
  gold: { len: 0.115, depth: 0.22, speed: 0.09, tail: 'veil', school: 0.2, prof: [0.35, 0.18], n: 3 },
  puffer: { len: 0.1, depth: 0.27, speed: 0.06, tail: 'fan', school: 0, prof: [0.45, 0.28], n: 2 },
};

const fish = [];
let idSeq = 0;

class Fish {
  constructor(kind, opts = {}) {
    this.id = idSeq++;
    this.kind = kind;
    this.sp = SPECIES[kind] || { len: 0.13, depth: 0.3, speed: 0.08, school: 0, prof: [0.4, 0.2] };
    this.size = opts.size || rand(0.88, 1.12);
    this.z = opts.z ?? rand(0, 1); // depth in the tank: 0 far, 1 near
    this.x = opts.x ?? rand(W * 0.15, W * 0.85);
    this.y = opts.y ?? rand(SURF + H * 0.1, SAND - H * 0.12);
    const a = rand(-0.4, 0.4) + (Math.random() < 0.5 ? Math.PI : 0);
    this.vx = Math.cos(a) * 30;
    this.vy = Math.sin(a) * 10;
    this.wa = a;
    this.face = Math.cos(a) > 0 ? 1 : -1;
    this.pitch = 0;
    this.phase = rand(0, TAU);
    this.fear = 0;
    this.full = 0;
    this.chomp = 0;
    this.puff = 0;
    this.hue = rand(-10, 10);
    this.img = opts.img || null;
    this.name = opts.name || '';
    this.nameT = opts.nameT || 0;
    this.drawn = !!opts.img;
  }
  get L() { return S * this.sp.len * this.size * lerp(0.75, 1.12, this.z) * (this.drawn ? 1 : 1); }
  get maxSp() { return S * this.sp.speed * lerp(0.8, 1.1, this.z); }

  update(dt, t) {
    const L = this.L;
    const cruise = this.maxSp * 0.55;
    // wander: a slowly drifting preferred direction, mostly horizontal
    this.wa += rand(-1, 1) * dt * 1.2;
    let dvx = Math.cos(this.wa) * cruise, dvy = Math.sin(this.wa) * cruise * 0.35;
    let urgency = 1.2;

    // keep inside the glass
    const mx = W * 0.05, top = SURF + H * 0.06, bot = sandY(this.x) - L * 0.6;
    if (this.x < mx) { this.wa = lerp(this.wa, 0, dt * 2); dvx += (mx - this.x) * 3; }
    if (this.x > W - mx) { this.wa = lerp(this.wa, Math.cos(this.wa) > 0 ? Math.PI : this.wa, dt * 2); dvx -= (this.x - (W - mx)) * 3; }
    if (this.y < top) dvy += (top - this.y) * 4;
    if (this.y > bot) dvy -= (this.y - bot) * 4;
    if (this.x < -L || this.x > W + L) this.wa = this.x < 0 ? 0 : Math.PI;

    // neighbours: keep a little space, and school with your own kind
    let ax = 0, ay = 0, n = 0, cx = 0, cy = 0, sx = 0, sy = 0;
    for (const o of fish) {
      if (o === this) continue;
      const dx = o.x - this.x, dy = o.y - this.y;
      const d2 = dx * dx + dy * dy;
      const near = (L + o.L) * 0.6;
      if (d2 < near * near && Math.abs(o.z - this.z) < 0.35) {
        const d = Math.sqrt(d2) || 1;
        sx -= (dx / d) * (near - d) * 3;
        sy -= (dy / d) * (near - d) * 3;
      }
      if (o.kind === this.kind && this.sp.school && d2 < (L * 6) ** 2) {
        ax += o.vx; ay += o.vy; cx += o.x; cy += o.y; n++;
      }
    }
    if (n) {
      const k = this.sp.school;
      dvx = lerp(dvx, ax / n, 0.5 * k) + (cx / n - this.x) * 0.4 * k;
      dvy = lerp(dvy, ay / n, 0.5 * k) + (cy / n - this.y) * 0.4 * k;
    }
    dvx += sx; dvy += sy;

    // food: the nearest flake in sight
    if (this.full <= 0 && this.fear <= 0) {
      let best = null, bd = S * 0.55;
      for (const f of food) {
        if (f.eaten) continue;
        const d = Math.hypot(f.x - this.x, f.y - this.y);
        if (d < bd) { bd = d; best = f; }
      }
      if (best) {
        const mouth = this.mouth();
        const dx = best.x - mouth.x, dy = best.y - mouth.y;
        const d = Math.hypot(dx, dy) || 1;
        const sp = this.maxSp * 1.25;
        dvx = (dx / d) * sp; dvy = (dy / d) * sp;
        urgency = 3;
        this.wa = Math.atan2(dy, dx);
        if (d < L * 0.28) this.eat(best);
      }
    }

    // a pointing finger: come and follow it
    const lure = lureFor(this);
    if (lure && this.fear <= 0) {
      const dx = lure.x - this.x, dy = lure.y - this.y;
      const d = Math.hypot(dx, dy) || 1;
      const ring = L * (1.1 + (this.id % 5) * 0.35);
      const sp = this.maxSp * clamp((d - ring) / (L * 2), -0.4, 1.3);
      // swim in toward the finger, then circle it
      dvx = (dx / d) * sp - (dy / d) * this.maxSp * 0.35 * (this.id % 2 ? 1 : -1);
      dvy = (dy / d) * sp + (dx / d) * this.maxSp * 0.35 * (this.id % 2 ? 1 : -1);
      urgency = 3.5;
      this.wa = Math.atan2(dvy, dvx);
    }

    // scared: dart away
    if (this.fear > 0) {
      this.fear -= dt;
      dvx = this.fx * this.maxSp * 2.6;
      dvy = this.fy * this.maxSp * 2.6;
      urgency = 6;
    }
    if (this.kind === 'puffer') this.puff = Math.max(0, this.puff - dt * 0.3);
    if (this.full > 0) this.full -= dt;
    if (this.chomp > 0) this.chomp -= dt * 4;
    if (this.nameT > 0) this.nameT -= dt;

    // steer toward the desired velocity, then drift with the water
    const k = ease(dt, 1 / urgency);
    this.vx += (dvx - this.vx) * k;
    this.vy += (dvy - this.vy) * k;
    const cur = currentAt(this.x, this.y);
    this.vx += cur.x * dt * 2.2;
    this.vy += cur.y * dt * 2.2;
    const lim = this.maxSp * (this.fear > 0 ? 3 : 1.6) * (this.puff > 0.3 ? 0.35 : 1);
    const v = Math.hypot(this.vx, this.vy);
    if (v > lim) { this.vx *= lim / v; this.vy *= lim / v; }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // facing flips smoothly through edge-on, like a real turn
    if (Math.abs(this.vx) > 4) {
      const want = this.vx > 0 ? 1 : -1;
      this.face += (want - this.face) * ease(dt, 0.14);
    }
    const p = clamp(Math.atan2(this.vy, Math.abs(this.vx) + 1e-3), -0.6, 0.6);
    this.pitch += (p - this.pitch) * ease(dt, 0.2);
    // tail beat speeds up with swimming speed
    this.phase += dt * (5 + (v / L) * 2.2);
  }

  mouth() {
    return { x: this.x + Math.sign(this.face || 1) * this.L * 0.5 * Math.cos(this.pitch), y: this.y + this.L * 0.5 * Math.sin(this.pitch) };
  }

  eat(f) {
    f.eaten = true;
    this.chomp = 1;
    this.size = Math.min(this.size + 0.01, 1.4);
    this.food = (this.food || 0) + 1;
    if (this.food % 6 === 0) this.full = rand(4, 8); // had enough for now
    S_.nom();
    if (Math.random() < 0.5) bubble(this.mouth().x, this.mouth().y, 0.5);
  }

  scare(x, y, power = 1) {
    const dx = this.x - x, dy = this.y - y;
    const d = Math.hypot(dx, dy) || 1;
    this.fx = dx / d;
    this.fy = (dy / d) * 0.7;
    this.fear = 0.6 + power * 0.5;
    this.wa = Math.atan2(this.fy, this.fx);
    if (this.kind === 'puffer') this.puff = 1;
  }

  draw(c, t) {
    const L = this.L;
    c.save();
    c.translate(this.x, this.y);
    const f = this.face;
    c.scale(Math.abs(f) < 0.08 ? 0.08 * Math.sign(f || 1) : f, 1);
    c.rotate(this.pitch * Math.sign(f || 1));
    if (this.img) drawSprite(c, this, L, t);
    else drawFishBody(c, this, L, t);
    c.restore();
    if (this.nameT > 0 && this.name) {
      c.save();
      c.globalAlpha = clamp01(this.nameT);
      c.font = `italic 500 ${Math.round(S * 0.026)}px "Cormorant Garamond", Georgia, serif`;
      c.textAlign = 'center';
      c.fillStyle = '#fff';
      c.shadowColor = 'rgba(0,30,40,0.7)';
      c.shadowBlur = 8;
      c.fillText(this.name, this.x, this.y - L * 0.55);
      c.restore();
    }
  }
}

// --- procedural bodies: a swimming spine with a width profile -----------------------
function spine(fishObj, L, n = 12) {
  const sp = fishObj.sp;
  const amp = L * 0.1 * (0.6 + Math.min(1, Math.hypot(fishObj.vx, fishObj.vy) / (fishObj.maxSp || 1)) * 0.6);
  const depth = L * sp.depth * (1 + fishObj.puff * 0.9);
  const [pk, tb] = sp.prof;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const x = L * 0.5 - s * L * 0.76;
    const y = Math.sin(fishObj.phase - s * 2.6) * amp * s ** 1.7;
    // nose rounds in, the body peaks at pk, then narrows to the tail base tb
    let w = s < pk ? Math.sqrt(Math.sin((s / pk) * Math.PI / 2)) : 1 - ((s - pk) / (1 - pk)) ** 1.3 * (1 - tb);
    if (fishObj.puff > 0) w = lerp(w, Math.sqrt(Math.max(0, Math.sin(Math.min(1, s * 1.05) * Math.PI))) * 1.05 + 0.05, fishObj.puff * 0.85);
    pts.push({ x, y, w: Math.max(0.02, w) * depth * 0.5, s });
  }
  return pts;
}

function bodyPath(c, pts) {
  const top = pts.map((p) => [p.x, p.y - p.w]);
  const bot = pts.map((p) => [p.x, p.y + p.w]);
  c.beginPath();
  const nose = pts[0];
  c.moveTo(nose.x + pts[1].w * 0.25, nose.y);
  smoothThrough(c, top);
  const tail = pts[pts.length - 1];
  c.lineTo(tail.x, tail.y + tail.w);
  smoothThrough(c, bot.slice().reverse(), true);
  c.closePath();
}
function smoothThrough(c, P) {
  c.lineTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length - 1; i++) {
    const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
    c.quadraticCurveTo(P[i][0], P[i][1], mx, my);
  }
  c.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
}

const PALETTE = {
  clown: { body: '#ff7a1a', belly: '#ffa04d', back: '#e0560a', fin: '#ff8a2a', edge: '#1b1b1b' },
  tetra: { body: '#c9d6dc', belly: '#eef4f6', back: '#8aa0aa', fin: 'rgba(220,235,240,0.5)', edge: '#2a6f8f' },
  angel: { body: '#e8ecee', belly: '#ffffff', back: '#b8c4c9', fin: 'rgba(230,236,240,0.75)', edge: '#1f2328' },
  gold: { body: '#ff9a1f', belly: '#ffd27a', back: '#e86f0c', fin: 'rgba(255,160,60,0.7)', edge: '#c24f00' },
  puffer: { body: '#e8d79a', belly: '#fbf6e4', back: '#b9a160', fin: 'rgba(230,215,160,0.7)', edge: '#6b5a2c' },
};

function drawFishBody(c, F, L, t) {
  const pts = spine(F, L);
  const pal = PALETTE[F.kind];
  const tail = pts[pts.length - 1], pre = pts[pts.length - 3];
  const tailAng = Math.atan2(tail.y - pre.y, tail.x - pre.x) + Math.PI + Math.sin(F.phase - 3) * 0.25;
  const depth = L * F.sp.depth;
  if (F.hue) c.filter = 'none';

  // fins behind the body
  drawTail(c, F, tail, tailAng, L, depth, pal, t);
  drawDorsal(c, F, pts, L, pal, t);

  // body with a back-to-belly gradient
  bodyPath(c, pts);
  const g = c.createLinearGradient(0, -depth * 0.5, 0, depth * 0.5);
  g.addColorStop(0, pal.back);
  g.addColorStop(0.45, pal.body);
  g.addColorStop(1, pal.belly);
  c.fillStyle = g;
  c.fill();

  // markings, clipped to the body
  c.save();
  bodyPath(c, pts);
  c.clip();
  drawMarkings(c, F, pts, L, depth, pal, t);
  // soft top light
  const hl = c.createLinearGradient(0, -depth * 0.5, 0, depth * 0.1);
  hl.addColorStop(0, 'rgba(255,255,255,0.28)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = hl;
  c.fillRect(-L, -depth, L * 2, depth);
  c.restore();

  // outline
  bodyPath(c, pts);
  c.strokeStyle = 'rgba(20, 30, 40, 0.28)';
  c.lineWidth = Math.max(0.8, L * 0.012);
  c.stroke();

  // pectoral fin, flapping
  const pf = pts[3];
  c.save();
  c.translate(pf.x, pf.y + pf.w * 0.25);
  c.rotate(0.5 + Math.sin(t * 7 + F.id) * 0.35);
  c.fillStyle = pal.fin;
  c.beginPath();
  c.ellipse(-L * 0.06, 0, L * 0.08, L * 0.03, 0, 0, TAU);
  c.fill();
  c.restore();

  // eye
  const e = pts[1];
  const er = L * (F.kind === 'puffer' ? 0.075 : F.kind === 'tetra' ? 0.07 : 0.055);
  const ex = e.x - L * 0.02, ey = e.y - e.w * 0.2;
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(ex, ey, er, 0, TAU); c.fill();
  c.fillStyle = F.kind === 'gold' || F.kind === 'clown' ? '#1a1206' : '#101820';
  c.beginPath(); c.arc(ex + er * 0.15, ey, er * 0.62, 0, TAU); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.beginPath(); c.arc(ex + er * 0.35, ey - er * 0.3, er * 0.22, 0, TAU); c.fill();

  // mouth: opens when eating
  const mo = clamp01(F.chomp);
  c.strokeStyle = 'rgba(40,20,10,0.6)';
  c.lineWidth = Math.max(1, L * 0.012);
  c.beginPath();
  c.moveTo(pts[0].x + L * 0.01, pts[0].y + L * 0.01);
  c.lineTo(pts[0].x - L * 0.05, pts[0].y + L * 0.015 + mo * L * 0.03);
  c.stroke();
  if (mo > 0.2) {
    c.fillStyle = 'rgba(60,20,20,0.7)';
    c.beginPath(); c.ellipse(pts[0].x, pts[0].y + L * 0.01, L * 0.02, L * 0.02 * mo, 0, 0, TAU); c.fill();
  }

  // puffer spikes
  if (F.kind === 'puffer' && F.puff > 0.15) {
    c.strokeStyle = `rgba(110, 90, 40, ${F.puff})`;
    c.lineWidth = Math.max(1, L * 0.012);
    for (let i = 1; i < pts.length - 3; i++) {
      for (const sgn of [-1, 1]) {
        const p = pts[i];
        c.beginPath();
        c.moveTo(p.x, p.y + sgn * p.w * 0.95);
        c.lineTo(p.x - L * 0.02, p.y + sgn * (p.w + L * 0.07 * F.puff));
        c.stroke();
      }
    }
  }
}

function drawTail(c, F, tail, ang, L, depth, pal, t) {
  c.save();
  c.translate(tail.x, tail.y);
  c.rotate(ang - Math.PI);
  const tl = L * 0.3, tw = depth * 0.55;
  const flap = Math.sin(F.phase - 3.2);
  c.fillStyle = F.kind === 'tetra' ? 'rgba(230, 70, 70, 0.75)' : pal.fin;
  c.beginPath();
  switch (F.sp.tail) {
    case 'fork':
      c.moveTo(0, -tail.w);
      c.quadraticCurveTo(-tl * 0.6, -tw * 0.5, -tl, -tw * 0.9 + flap * tw * 0.1);
      c.quadraticCurveTo(-tl * 0.5, 0, -tl, tw * 0.9 + flap * tw * 0.1);
      c.quadraticCurveTo(-tl * 0.6, tw * 0.5, 0, tail.w);
      break;
    case 'lyre':
      c.moveTo(0, -tail.w);
      c.quadraticCurveTo(-tl * 0.5, -tw * 0.6, -tl * 1.3, -tw * 1.1);
      c.quadraticCurveTo(-tl * 0.8, 0, -tl * 1.3, tw * 1.1);
      c.quadraticCurveTo(-tl * 0.5, tw * 0.6, 0, tail.w);
      break;
    case 'veil': {
      // long flowing double tail that trails a wave behind
      const n = 8;
      c.moveTo(0, -tail.w);
      for (let i = 1; i <= n; i++) {
        const s = i / n;
        c.lineTo(-tl * 1.6 * s, -tw * (0.4 + s * 0.9) + Math.sin(F.phase - s * 3) * tw * 0.35 * s);
      }
      for (let i = n; i >= 1; i--) {
        const s = i / n;
        c.lineTo(-tl * 1.5 * s, tw * (0.4 + s * 0.9) + Math.sin(F.phase - s * 3 - 0.6) * tw * 0.35 * s);
      }
      c.lineTo(0, tail.w);
      break;
    }
    case 'fan':
      c.moveTo(0, -tail.w);
      c.quadraticCurveTo(-tl * 0.7, -tw * 0.7, -tl * 0.75, 0);
      c.quadraticCurveTo(-tl * 0.7, tw * 0.7, 0, tail.w);
      break;
    default: // round
      c.moveTo(0, -tail.w);
      c.bezierCurveTo(-tl * 0.5, -tw * 0.9, -tl * 1.1, -tw * 0.7, -tl, 0);
      c.bezierCurveTo(-tl * 1.1, tw * 0.7, -tl * 0.5, tw * 0.9, 0, tail.w);
  }
  c.closePath();
  c.fill();
  if (F.kind === 'clown') { c.strokeStyle = pal.edge; c.lineWidth = Math.max(1, L * 0.02); c.stroke(); }
  // fin rays
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 1;
  for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(0, 0); c.lineTo(-tl * 0.85, i * tw * 0.3); c.stroke(); }
  c.restore();
}

function drawDorsal(c, F, pts, L, pal, t) {
  const n = pts.length;
  const fins = {
    clown: [[0.25, 0.75, 0.12, 1], [0.45, 0.75, 0.08, -1]],
    tetra: [[0.4, 0.55, 0.12, 1], [0.5, 0.7, 0.06, -1]],
    angel: [[0.2, 0.7, 0.55, 1], [0.25, 0.7, 0.5, -1]],
    gold: [[0.2, 0.6, 0.18, 1], [0.55, 0.75, 0.12, -1]],
    puffer: [[0.6, 0.75, 0.1, 1], [0.6, 0.75, 0.08, -1]],
  }[F.kind] || [];
  c.fillStyle = pal.fin;
  for (const [a, b, h, sgn] of fins) {
    c.beginPath();
    const i0 = Math.round(a * (n - 1)), i1 = Math.round(b * (n - 1));
    c.moveTo(pts[i0].x, pts[i0].y + sgn * pts[i0].w * 0.8);
    // swept-back fin: peaks early, trails toward the tail
    const peak = pts[Math.round(lerp(i0, i1, F.kind === 'angel' ? 0.75 : 0.4))];
    const sway = Math.sin(F.phase - 1.5) * L * 0.02;
    const tipX = F.kind === 'angel' ? pts[i1].x - L * 0.18 : peak.x - L * 0.06;
    c.quadraticCurveTo(peak.x + L * 0.04, peak.y + sgn * (peak.w + L * h * 0.9), tipX + sway, peak.y + sgn * (peak.w + L * h));
    c.quadraticCurveTo(pts[i1].x, pts[i1].y + sgn * (pts[i1].w + L * h * 0.3), pts[i1].x, pts[i1].y + sgn * pts[i1].w * 0.8);
    c.closePath();
    c.fill();
    if (F.kind === 'clown') { c.strokeStyle = PALETTE.clown.edge; c.lineWidth = Math.max(1, L * 0.018); c.stroke(); }
    if (F.kind === 'angel') {
      c.save(); c.clip();
      c.strokeStyle = 'rgba(30,35,40,0.6)'; c.lineWidth = L * 0.05;
      for (const s of [0.35, 0.6]) { const p = pts[Math.round(s * (n - 1))]; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - L * 0.15, p.y + sgn * L * 0.6); c.stroke(); }
      c.restore();
    }
  }
}

function band(c, pts, s, width, color, depth, edge) {
  const n = pts.length;
  const i = clamp(Math.round(s * (n - 1)), 0, n - 1);
  const p = pts[i];
  c.save();
  c.translate(p.x, p.y);
  if (edge) {
    c.fillStyle = edge;
    c.beginPath(); c.ellipse(0, 0, width * 0.62, depth, 0, 0, TAU); c.fill();
  }
  c.fillStyle = color;
  c.beginPath(); c.ellipse(0, 0, width * 0.5, depth, 0, 0, TAU); c.fill();
  c.restore();
}

function drawMarkings(c, F, pts, L, depth, pal, t) {
  switch (F.kind) {
    case 'clown':
      band(c, pts, 0.14, L * 0.11, '#fffaf2', depth, pal.edge);
      band(c, pts, 0.47, L * 0.12, '#fffaf2', depth, pal.edge);
      band(c, pts, 0.86, L * 0.07, '#fffaf2', depth, pal.edge);
      break;
    case 'tetra': {
      // the neon stripe shimmers as it turns
      const shimmer = 0.7 + Math.sin(t * 3 + F.id) * 0.3;
      c.strokeStyle = `rgba(40, 200, 255, ${shimmer})`;
      c.lineWidth = depth * 0.22;
      c.lineCap = 'round';
      c.beginPath();
      for (let i = 1; i < pts.length - 2; i++) c.lineTo(pts[i].x, pts[i].y - pts[i].w * 0.15);
      c.stroke();
      c.fillStyle = 'rgba(235, 50, 60, 0.85)';
      c.beginPath();
      for (let i = 5; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y + pts[i].w * 0.1);
      for (let i = pts.length - 1; i >= 5; i--) c.lineTo(pts[i].x, pts[i].y + pts[i].w + 2);
      c.fill();
      break;
    }
    case 'angel':
      for (const s of [0.18, 0.42, 0.66]) band(c, pts, s, L * 0.06, 'rgba(30,35,40,0.75)', depth);
      break;
    case 'gold':
      c.fillStyle = 'rgba(255, 245, 225, 0.75)';
      c.beginPath(); c.ellipse(pts[5].x, pts[5].y + pts[5].w * 0.3, L * 0.1, depth * 0.18, 0.2, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(pts[2].x, pts[2].y - pts[2].w * 0.5, L * 0.05, depth * 0.1, 0, 0, TAU); c.fill();
      break;
    case 'puffer':
      c.fillStyle = 'rgba(110, 80, 30, 0.55)';
      for (let i = 0; i < 9; i++) {
        const p = pts[1 + (i * 7) % (pts.length - 3)];
        c.beginPath(); c.arc(p.x + ((i * 13) % 7 - 3) * L * 0.01, p.y - p.w * (0.3 + ((i * 5) % 4) * 0.15), L * 0.022, 0, TAU); c.fill();
      }
      break;
  }
}

// --- drawn fish: the picture is sliced into strips that ride a body wave -----------
function drawSprite(c, F, L, t) {
  const img = F.img;
  const iw = img.width, ih = img.height;
  const w = L, h = L * (ih / iw);
  const N = 24;
  const amp = h * 0.09 * (0.6 + Math.min(1, Math.hypot(F.vx, F.vy) / F.maxSp) * 0.7);
  const sw = iw / N;
  // soft shadow-less outline glow keeps drawings readable on the water
  for (let i = 0; i < N; i++) {
    // the drawing faces right: the head is the right edge, the tail the left
    const fromHead = 1 - (i + 0.5) / N;
    const off = Math.sin(F.phase - fromHead * 3.2) * amp * fromHead ** 1.6;
    const dx = -w / 2 + (i / N) * w;
    c.drawImage(img, i * sw, 0, sw + 1, ih, dx, -h / 2 + off, w / N + 1, h);
  }
  if (F.chomp > 0.2) {
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.beginPath(); c.arc(w * 0.5, 0, L * 0.03 * F.chomp, 0, TAU); c.fill();
  }
}

// ======================================================================
// Food, bubbles, motes
// ======================================================================
const food = [];
function dropFood(x, y, n = 1) {
  for (let i = 0; i < n; i++) {
    if (food.length > 160) food.shift();
    food.push({ x: x + rand(-8, 8), y: Math.max(SURF, y + rand(-6, 6)), vy: rand(14, 26), ph: rand(0, TAU), c: pick(['#c8743a', '#e2a24b', '#9b5a2c', '#d8c25a', '#b84a3a']), rest: 0, eaten: false, r: rand(1.6, 2.8) });
  }
}

const bubbles = [];
function bubble(x, y, size = 1) {
  bubbles.push({ x, y, r: rand(1.5, 4.5) * size * (S / 700), vy: rand(40, 80), ph: rand(0, TAU) });
}
const motes = [];
function seedMotes() {
  motes.length = 0;
  for (let i = 0; i < 60; i++) motes.push({ x: rand(0, W), y: rand(SURF, SAND), r: rand(0.6, 1.8), vx: rand(-4, 4), vy: rand(-3, 3), ph: rand(0, TAU) });
}

// ======================================================================
// Sound
// ======================================================================
const sfx = new Sfx();
const S_ = {
  bubble() { sfx.tone({ type: 'sine', freqs: [[0, rand(350, 600)], [0.07, rand(900, 1400)]], dur: 0.09, gain: 0.04 }); },
  plop() { sfx.tone({ type: 'sine', freqs: [[0, 900], [0.1, 260]], dur: 0.14, gain: 0.08 }); },
  nom() { sfx.tone({ type: 'triangle', freqs: [[0, rand(520, 640)], [0.06, rand(760, 880)]], dur: 0.08, gain: 0.05 }); },
  whoosh() { sfx.hiss({ dur: 0.45, gain: 0.1, freq: 500, q: 0.6 }); },
  splash() {
    sfx.hiss({ dur: 0.6, gain: 0.12, type: 'lowpass', freq: 1400 });
    [0, 0.08, 0.16, 0.24].forEach((d, i) => sfx.tone({ type: 'sine', freqs: [[0, 500 + i * 180], [0.08, 1200 + i * 200]], dur: 0.1, gain: 0.05, delay: d }));
  },
};

// ======================================================================
// Hands
// ======================================================================
let tracker = null;
let fakeHands = null; // test hook: list of 21-point hands in image space
let lastRef = null;
const hands = []; // smoothed, screen space
let scatterCool = 0;

function readHands(now, dt) {
  const list = fakeHands || tracker?.lastHands || [];
  const fresh = list !== lastRef;
  lastRef = list;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  if (fresh) {
    const seen = new Set();
    for (const lm of list) {
      const P = lm.map((p) => toScreen(p, vw, vh, W, H));
      const palm = dist(P[0], P[9]) || 1;
      const ext = (tip, pip) => dist(P[tip], P[0]) > dist(P[pip], P[0]) * 1.12;
      const iE = ext(8, 6), mE = ext(12, 10), rE = ext(16, 14), pE = ext(20, 18);
      const pinchD = dist(P[4], P[8]) / palm;
      const idxOut = dist(P[8], P[0]) > dist(P[5], P[0]) * 1.05;
      const center = { x: (P[0].x + P[5].x + P[9].x + P[13].x + P[17].x) / 5, y: (P[0].y + P[5].y + P[9].y + P[13].y + P[17].y) / 5 };
      // match to an existing hand
      let h = null, bd = S * 0.3;
      for (const o of hands) {
        if (seen.has(o)) continue;
        const d = dist(o.center, center);
        if (d < bd) { bd = d; h = o; }
      }
      if (!h) {
        h = { center: { ...center }, tip: { ...P[8] }, pinch: { x: (P[4].x + P[8].x) / 2, y: (P[4].y + P[8].y) / 2 }, vx: 0, vy: 0, pinched: false, g: 'relaxed', born: now, foodT: 0, sx: center.x, sy: center.y };
        hands.push(h);
      }
      seen.add(h);
      const ddt = Math.max((now - (h.seen || now - 33)) / 1000, 1 / 60);
      const nvx = (center.x - h.center.x) / ddt, nvy = (center.y - h.center.y) / ddt;
      if (h.seen) { h.vx += (nvx - h.vx) * 0.5; h.vy += (nvy - h.vy) * 0.5; }
      h.center = center;
      h.target = { tip: P[8], pinch: { x: (P[4].x + P[8].x) / 2, y: (P[4].y + P[8].y) / 2 }, palm: center };
      h.pinched = h.pinched ? pinchD < 0.5 && idxOut : pinchD < 0.33 && idxOut;
      h.g = h.pinched ? 'pinch' : iE && mE && rE ? 'open' : iE && !mE && !rE ? 'point' : !iE && !mE && !rE && !pE ? 'fist' : 'relaxed';
      h.seen = now;
      h.palmR = palm;
    }
  }
  // drop hands that left
  for (let i = hands.length - 1; i >= 0; i--) if (now - hands[i].seen > 400) hands.splice(i, 1);
  // smooth display positions every frame
  for (const h of hands) {
    const k = ease(dt, 0.05);
    h.tip.x += (h.target.tip.x - h.tip.x) * k;
    h.tip.y += (h.target.tip.y - h.tip.y) * k;
    h.pinch.x += (h.target.pinch.x - h.pinch.x) * k;
    h.pinch.y += (h.target.pinch.y - h.pinch.y) * k;
    h.sx += (h.target.palm.x - h.sx) * k;
    h.sy += (h.target.palm.y - h.sy) * k;
  }
}

function lureFor(f) {
  // the nearest pointing finger (or the mouse while it is held still) within reach
  let best = null, bd = S * 0.5;
  for (const h of hands) {
    if (h.g !== 'point' || drawing) continue;
    const d = Math.hypot(h.tip.x - f.x, h.tip.y - f.y);
    if (d < bd) { bd = d; best = h.tip; }
  }
  return best;
}

function handActions(dt, now) {
  if (drawing) return;
  scatterCool -= dt;
  for (const h of hands) {
    const speed = Math.hypot(h.vx, h.vy);
    if (h.g === 'pinch') {
      h.foodT -= dt;
      if (h.foodT <= 0 && h.pinch.y < SAND) {
        dropFood(h.pinch.x, h.pinch.y, 2);
        if (!h.wasPinch) S_.plop();
        h.foodT = 0.14;
      }
    }
    h.wasPinch = h.g === 'pinch';
    if (h.g === 'open') {
      // an open hand pushes water the way it moves, and nudges fish aside even when still
      addPush(h.sx, h.sy, h.vx * 0.6, h.vy * 0.6, S * 0.28, 0.5);
      for (const f of fish) {
        const d = Math.hypot(f.x - h.sx, f.y - h.sy);
        if (d < S * 0.12 && f.fear <= 0) { f.vx += ((f.x - h.sx) / d) * S * 0.6 * dt; f.vy += ((f.y - h.sy) / d) * S * 0.6 * dt; }
      }
    }
    if (speed > S * 2.2 && scatterCool <= 0 && h.g !== 'pinch' && now - h.born > 400) {
      scatterCool = 0.8;
      scatter(h.sx, h.sy, S * 0.45);
      addPush(h.sx, h.sy, h.vx, h.vy, S * 0.4, 0.8);
    }
  }
}

function scatter(x, y, r) {
  let n = 0;
  for (const f of fish) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < r) { f.scare(x, y, 1 - d / r); n++; }
  }
  for (let i = 0; i < 8; i++) bubble(x + rand(-30, 30), y + rand(-20, 20), 1.2);
  if (n) S_.whoosh();
}

// ======================================================================
// Mouse and touch in the tank
// ======================================================================
let ptr = null;
canvas.addEventListener('pointerdown', (e) => {
  sfx.init();
  ptr = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, lx: e.clientX, ly: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!ptr) return;
  const dx = e.clientX - ptr.lx, dy = e.clientY - ptr.ly;
  ptr.moved += Math.hypot(dx, dy);
  addPush(e.clientX, e.clientY, dx * 30, dy * 30, S * 0.22, 0.5);
  if (Math.hypot(dx, dy) > S * 0.08) scatter(e.clientX, e.clientY, S * 0.3);
  ptr.lx = e.clientX; ptr.ly = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (ptr && ptr.moved < 8) { dropFood(e.clientX, e.clientY, 5); S_.plop(); }
  ptr = null;
});

// ======================================================================
// Drawing your own fish
// ======================================================================
const panel = $('studio');
const pad = $('pad');
const pc = pad.getContext('2d', { willReadFrequently: true });
const airCursor = $('air-cursor');
let drawing = false;
let color = '#ff8a3d';
let erase = false, fillMode = false;
const undo = [];
const COLORS = ['#ff8a3d', '#ff4d6d', '#ffd23f', '#7bdc65', '#22b8cf', '#3b6cff', '#9b5cf6', '#ff9ad5', '#ffffff', '#8a5a3b', '#1d1d1f'];
const swatches = $('swatches');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', 'colour ' + c);
  b.setAttribute('aria-checked', String(i === 0));
  b.addEventListener('click', () => {
    color = c;
    erase = false;
    $('tool-erase').setAttribute('aria-pressed', 'false');
    for (const s of swatches.children) s.setAttribute('aria-checked', String(s === b));
  });
  swatches.appendChild(b);
});
const brush = $('brush');

function guideOutline() {
  // a faint dotted fish to trace over, not part of the drawing
  pad.style.backgroundImage = '';
}

function snapshot() {
  undo.push(pc.getImageData(0, 0, pad.width, pad.height));
  if (undo.length > 25) undo.shift();
}
function padPoint(cx, cy) {
  const r = pad.getBoundingClientRect();
  return { x: ((cx - r.left) / r.width) * pad.width, y: ((cy - r.top) / r.height) * pad.height, inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom };
}
let stroke = null;
function strokeTo(p) {
  pc.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  pc.strokeStyle = color;
  pc.lineCap = 'round';
  pc.lineJoin = 'round';
  pc.lineWidth = +brush.value * (erase ? 1.6 : 1);
  if (!stroke) {
    pc.beginPath();
    pc.fillStyle = color;
    pc.arc(p.x, p.y, pc.lineWidth / 2, 0, TAU);
    pc.fill();
  } else {
    // smooth with a midpoint curve
    const mx = (stroke.x + p.x) / 2, my = (stroke.y + p.y) / 2;
    pc.beginPath();
    pc.moveTo(stroke.mx ?? stroke.x, stroke.my ?? stroke.y);
    pc.quadraticCurveTo(stroke.x, stroke.y, mx, my);
    pc.stroke();
    p.mx = mx; p.my = my;
  }
  pc.globalCompositeOperation = 'source-over';
  stroke = p;
  updateRelease();
}
pad.addEventListener('pointerdown', (e) => {
  sfx.init();
  pad.setPointerCapture(e.pointerId);
  const p = padPoint(e.clientX, e.clientY);
  snapshot();
  if (fillMode) { floodFill(Math.floor(p.x), Math.floor(p.y), erase ? null : color); updateRelease(); return; }
  stroke = null;
  strokeTo(p);
});
pad.addEventListener('pointermove', (e) => { if (stroke) strokeTo(padPoint(e.clientX, e.clientY)); });
pad.addEventListener('pointerup', () => { stroke = null; });
pad.addEventListener('pointercancel', () => { stroke = null; });

function floodFill(x, y, hex) {
  const w = pad.width, h = pad.height;
  const img = pc.getImageData(0, 0, w, h);
  const d = img.data;
  const i0 = (y * w + x) * 4;
  const t = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  let fr = 0, fg = 0, fb = 0, fa = 0;
  if (hex) { const n = parseInt(hex.slice(1), 16); fr = n >> 16; fg = (n >> 8) & 255; fb = n & 255; fa = 255; }
  if (t[0] === fr && t[1] === fg && t[2] === fb && t[3] === fa) return;
  const same = (i) => Math.abs(d[i] - t[0]) + Math.abs(d[i + 1] - t[1]) + Math.abs(d[i + 2] - t[2]) + Math.abs(d[i + 3] - t[3]) < 90;
  const stack = [[x, y]];
  const seen = new Uint8Array(w * h);
  while (stack.length) {
    const [sx, sy] = stack.pop();
    let lx = sx;
    while (lx >= 0 && !seen[sy * w + lx] && same((sy * w + lx) * 4)) lx--;
    lx++;
    let up = false, dn = false;
    for (let xx = lx; xx < w; xx++) {
      const k = sy * w + xx;
      if (seen[k] || !same(k * 4)) break;
      seen[k] = 1;
      d[k * 4] = fr; d[k * 4 + 1] = fg; d[k * 4 + 2] = fb; d[k * 4 + 3] = fa;
      if (sy > 0) { const u = k - w; if (!seen[u] && same(u * 4)) { if (!up) { stack.push([xx, sy - 1]); up = true; } } else up = false; }
      if (sy < h - 1) { const v = k + w; if (!seen[v] && same(v * 4)) { if (!dn) { stack.push([xx, sy + 1]); dn = true; } } else dn = false; }
    }
  }
  // soften the hard fill edge against antialiased strokes
  pc.putImageData(img, 0, 0);
}

$('tool-erase').addEventListener('click', (e) => { erase = !erase; e.currentTarget.setAttribute('aria-pressed', String(erase)); });
$('tool-fill').addEventListener('click', (e) => { fillMode = !fillMode; e.currentTarget.setAttribute('aria-pressed', String(fillMode)); });
$('tool-undo').addEventListener('click', () => { const s = undo.pop(); if (s) pc.putImageData(s, 0, 0); updateRelease(); });
$('tool-clear').addEventListener('click', () => { snapshot(); pc.clearRect(0, 0, pad.width, pad.height); updateRelease(); });

function bbox() {
  const { width: w, height: h } = pad;
  const d = pc.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (d[(y * w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return { x0: Math.max(0, x0 - 4), y0: Math.max(0, y0 - 4), x1: Math.min(w, x1 + 5), y1: Math.min(h, y1 + 5) };
}
let releaseCheck = 0;
function updateRelease() {
  clearTimeout(releaseCheck);
  releaseCheck = setTimeout(() => { $('release').disabled = !bbox(); }, 60);
}

function openPanel() {
  drawing = true;
  panel.hidden = false;
  stroke = null;
  updateRelease();
  updateMineCount();
}
function closePanel() {
  drawing = false;
  panel.hidden = true;
  airCursor.hidden = true;
  stroke = null;
}
$('btn-draw').addEventListener('click', () => { sfx.init(); drawing ? closePanel() : openPanel(); });
$('draw-close').addEventListener('click', closePanel);

const NAMES = ['Bubbles', 'Sprinkle', 'Captain Fin', 'Noodle', 'Pebble', 'Ziggy', 'Marmalade', 'Doodle', 'Biscuit', 'Squiggle', 'Sunny', 'Pickle'];
const STORE = 'mood-tank-fish';
function loadMine() { try { return JSON.parse(localStorage.getItem(STORE) || '[]') || []; } catch (e) { return []; } }
function saveMine(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); return true; } catch (e) { return false; } }
function updateMineCount() {
  const n = fish.filter((f) => f.drawn).length;
  $('mine-count').textContent = n ? `${n} fish you drew ${n === 1 ? 'is' : 'are'} swimming.` : 'Your fish are saved in this browser.';
  $('clear-mine').hidden = !n;
}

function spriteFrom(dataUrl) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
}

$('release').addEventListener('click', async () => {
  const b = bbox();
  if (!b) return;
  sfx.init();
  // crop to the drawing and keep it small enough to store
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const sc = Math.min(1, 320 / w);
  const out = document.createElement('canvas');
  out.width = Math.max(8, Math.round(w * sc));
  out.height = Math.max(8, Math.round(h * sc));
  out.getContext('2d').drawImage(pad, b.x0, b.y0, w, h, 0, 0, out.width, out.height);
  const data = out.toDataURL('image/png');
  const name = $('fish-name').value.trim() || pick(NAMES);
  const img = await spriteFrom(data);
  releaseFish(img, name, true);
  const mine = loadMine();
  mine.push({ name, data });
  while (mine.length > 12) mine.shift();
  if (!saveMine(mine)) { mine.shift(); saveMine(mine); }
  // fresh page for the next one
  pc.clearRect(0, 0, pad.width, pad.height);
  undo.length = 0;
  $('fish-name').value = '';
  closePanel();
});

function releaseFish(img, name, splash) {
  const aspect = img.height / img.width;
  const f = new Fish('drawn', {
    img, name, nameT: splash ? 6 : 0, z: rand(0.6, 0.95),
    x: splash ? W / 2 : rand(W * 0.15, W * 0.85),
    y: splash ? SURF + 10 : rand(SURF + H * 0.1, SAND - H * 0.15),
  });
  // big, chunky drawings swim a bit slower
  f.sp = { len: 0.17, depth: aspect, speed: aspect > 0.7 ? 0.065 : 0.085, school: 0, prof: [0.4, 0.2] };
  if (splash) {
    f.vy = S * 0.25;
    f.vx = rand(-1, 1) * 30;
    for (let i = 0; i < 26; i++) bubble(W / 2 + rand(-40, 40), SURF + rand(0, 60), 1.4);
    S_.splash();
  }
  fish.push(f);
  updateMineCount();
  return f;
}

$('clear-mine').addEventListener('click', () => {
  for (let i = fish.length - 1; i >= 0; i--) if (fish[i].drawn) fish.splice(i, 1);
  saveMine([]);
  updateMineCount();
});

// air drawing: pinch in the air to put the pen down
function airDraw() {
  if (!drawing) return;
  const h = hands[0];
  if (!h) { airCursor.hidden = true; if (stroke?.air) stroke = null; return; }
  const p = padPoint(h.pinch.x, h.pinch.y);
  const r = pad.getBoundingClientRect();
  const wrap = pad.parentElement.getBoundingClientRect();
  airCursor.hidden = !p.inside;
  airCursor.style.left = (h.pinch.x - wrap.left) + 'px';
  airCursor.style.top = (h.pinch.y - wrap.top) + 'px';
  airCursor.classList.toggle('down', h.g === 'pinch');
  if (h.g === 'pinch' && p.inside) {
    if (!stroke || !stroke.air) { snapshot(); stroke = null; }
    p.air = true;
    strokeTo(p);
  } else if (stroke?.air) stroke = null;
}

// ======================================================================
// Rendering the tank
// ======================================================================
function drawPlants(c, t, front) {
  for (const p of decor.plants) {
    if (p.front !== front) continue;
    const base = sandY(p.x) + 4;
    const cur = currentAt(p.x, base - p.h * 0.6);
    p.bend += (clamp(cur.x * 0.004, -1.2, 1.2) - p.bend) * 0.05;
    const n = 9;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const sway = Math.sin(t * 0.9 + p.ph + s * 2.2) * p.h * 0.08 * s + p.bend * p.h * 0.3 * s * s;
      pts.push([p.x + sway, base - s * p.h]);
    }
    c.fillStyle = p.col;
    c.beginPath();
    for (let i = 0; i <= n; i++) { const w = p.w * (1 - (i / n) * 0.7) * (1 + Math.sin(i * 1.7 + p.ph) * 0.25); c.lineTo(pts[i][0] - w, pts[i][1]); }
    for (let i = n; i >= 0; i--) { const w = p.w * (1 - (i / n) * 0.7) * (1 + Math.sin(i * 1.7 + p.ph) * 0.25); c.lineTo(pts[i][0] + w, pts[i][1]); }
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.lineWidth = 1;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
  }
}

function drawCoral(c, cr, t) {
  const base = sandY(cr.x) + 4;
  c.strokeStyle = cr.c;
  c.lineCap = 'round';
  const branch = (x, y, a, len, w, depth) => {
    const sway = Math.sin(t * 0.7 + x * 0.01) * 0.03;
    const x2 = x + Math.cos(a + sway) * len, y2 = y + Math.sin(a + sway) * len;
    c.lineWidth = w;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
    if (depth > 0) { branch(x2, y2, a - 0.45, len * 0.72, w * 0.72, depth - 1); branch(x2, y2, a + 0.4, len * 0.7, w * 0.72, depth - 1); }
    else { c.fillStyle = shadeHex(cr.c, 0.35); c.beginPath(); c.arc(x2, y2, w * 0.7, 0, TAU); c.fill(); }
  };
  branch(cr.x, base, -Math.PI / 2, cr.s * 0.38, cr.s * 0.11, 3);
}
function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawChest(c, t) {
  const ch = decor.chest;
  const s = ch.s, x = ch.x, y = ch.y;
  const open = 0.25 + Math.max(0, Math.sin(t * 0.5)) * 0.35;
  c.save();
  c.translate(x, y);
  // box
  c.fillStyle = '#7a4a26';
  c.fillRect(-s, -s * 0.9, s * 2, s * 0.9);
  c.fillStyle = '#5c3519';
  for (let i = 0; i < 3; i++) c.fillRect(-s, -s * 0.9 + i * s * 0.3, s * 2, s * 0.04);
  c.fillStyle = '#d6a43b';
  c.fillRect(-s, -s * 0.9, s * 0.12, s * 0.9);
  c.fillRect(s * 0.88, -s * 0.9, s * 0.12, s * 0.9);
  // gold glint inside
  c.fillStyle = `rgba(255, 215, 90, ${0.5 + open * 0.5})`;
  c.beginPath(); c.ellipse(0, -s * 0.9, s * 0.85, s * 0.12 * (1 + open), 0, 0, TAU); c.fill();
  // lid, hinged at the back
  c.save();
  c.translate(0, -s * 0.9);
  c.scale(1, Math.cos(open * 1.3));
  c.fillStyle = '#8a552c';
  c.beginPath(); c.moveTo(-s, 0); c.lineTo(-s, -s * 0.35); c.quadraticCurveTo(0, -s * 0.75, s, -s * 0.35); c.lineTo(s, 0); c.closePath(); c.fill();
  c.fillStyle = '#d6a43b';
  c.fillRect(-s * 0.12, -s * 0.5, s * 0.24, s * 0.5);
  c.restore();
  c.restore();
  if (Math.random() < open * 0.12) bubble(x + rand(-s * 0.5, s * 0.5), y - s, 0.9);
}

function drawLight(c, t) {
  // god rays from the surface
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const x = W * (0.1 + i * 0.17) + Math.sin(t * 0.13 + i * 2) * W * 0.04;
    const a = 0.05 + Math.sin(t * 0.4 + i * 1.7) * 0.025;
    const g = c.createLinearGradient(0, 0, 0, H * 0.9);
    g.addColorStop(0, `rgba(220, 250, 255, ${a})`);
    g.addColorStop(1, 'rgba(220, 250, 255, 0)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x - W * 0.03, 0);
    c.lineTo(x + W * 0.03, 0);
    c.lineTo(x + W * 0.12, H * 0.9);
    c.lineTo(x - W * 0.02, H * 0.9);
    c.closePath();
    c.fill();
  }
  c.restore();
}

function drawCaustics(c, t) {
  // dancing light net on the sand
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.strokeStyle = 'rgba(255, 255, 230, 0.13)';
  c.lineWidth = 2;
  for (let row = 0; row < 3; row++) {
    c.beginPath();
    for (let x = 0; x <= W; x += 14) {
      const y = sandY(x) + 8 + row * (H - SAND) * 0.3 + Math.sin(x * 0.03 + t * 1.3 + row * 2) * 5 + Math.sin(x * 0.011 - t * 0.7) * 4;
      x ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
  c.restore();
}

function drawSurface(c, t) {
  const g = c.createLinearGradient(0, 0, 0, SURF * 1.6);
  g.addColorStop(0, 'rgba(210, 248, 255, 0.55)');
  g.addColorStop(1, 'rgba(210, 248, 255, 0)');
  c.fillStyle = g;
  c.fillRect(0, 0, W, SURF * 1.6);
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x <= W; x += 10) {
    const y = SURF + Math.sin(x * 0.02 + t * 1.6) * 2.5 + Math.sin(x * 0.007 - t) * 3;
    x ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();
}

function drawFood(c, dt, t) {
  for (const f of food) {
    if (f.eaten) continue;
    const cur = currentAt(f.x, f.y);
    if (f.y < sandY(f.x) - 2) {
      f.y += (f.vy + cur.y * 0.3) * dt;
      f.x += (Math.sin(t * 2 + f.ph) * 8 + cur.x * 0.3) * dt;
    } else f.rest += dt;
    c.fillStyle = f.c;
    c.globalAlpha = f.rest > 8 ? Math.max(0, 1 - (f.rest - 8) / 2) : 1;
    c.beginPath();
    c.ellipse(f.x, f.y, f.r * 1.4, f.r, f.ph + t, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;
  for (let i = food.length - 1; i >= 0; i--) if (food[i].eaten || food[i].rest > 10) food.splice(i, 1);
}

function drawBubbles(c, dt, t) {
  c.strokeStyle = 'rgba(235, 252, 255, 0.75)';
  c.fillStyle = 'rgba(235, 252, 255, 0.15)';
  c.lineWidth = 1;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.y -= b.vy * dt;
    b.x += Math.sin(t * 4 + b.ph) * 18 * dt;
    if (b.y < SURF) { bubbles.splice(i, 1); if (Math.random() < 0.15) S_.bubble(); continue; }
    c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.beginPath(); c.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.25, 0, TAU); c.fill();
    c.fillStyle = 'rgba(235, 252, 255, 0.15)';
  }
  // a bubbler in the corner
  if (Math.random() < 0.12) bubble(W * 0.965 + rand(-4, 4), sandY(W * 0.965) - 4, 0.8);
}

function drawMotes(c, dt, t) {
  c.fillStyle = 'rgba(230, 250, 255, 0.35)';
  for (const m of motes) {
    const cur = currentAt(m.x, m.y);
    m.x += (m.vx + cur.x * 0.5) * dt;
    m.y += (m.vy + Math.sin(t + m.ph) * 3 + cur.y * 0.5) * dt;
    if (m.x < 0) m.x += W; if (m.x > W) m.x -= W;
    if (m.y < SURF) m.y = SAND; if (m.y > SAND) m.y = SURF;
    c.beginPath(); c.arc(m.x, m.y, m.r, 0, TAU); c.fill();
  }
}

function drawHands(c, t) {
  if (drawing) return;
  for (const h of hands) {
    c.save();
    if (h.g === 'point') {
      const r = S * 0.03 + Math.sin(t * 5) * 3;
      c.strokeStyle = 'rgba(255, 245, 200, 0.95)';
      c.lineWidth = 2.5;
      c.beginPath(); c.arc(h.tip.x, h.tip.y, r, 0, TAU); c.stroke();
      c.strokeStyle = 'rgba(255, 245, 200, 0.35)';
      c.beginPath(); c.arc(h.tip.x, h.tip.y, r * 1.8 + ((t * 40) % 20), 0, TAU); c.stroke();
      c.fillStyle = 'rgba(255, 245, 200, 0.9)';
      c.beginPath(); c.arc(h.tip.x, h.tip.y, 4, 0, TAU); c.fill();
    } else if (h.g === 'pinch') {
      c.fillStyle = 'rgba(255, 190, 110, 0.9)';
      c.beginPath(); c.arc(h.pinch.x, h.pinch.y, 6, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255, 190, 110, 0.7)';
      c.lineWidth = 2;
      c.beginPath(); c.arc(h.pinch.x, h.pinch.y, S * 0.025, 0, TAU); c.stroke();
    } else if (h.g === 'open') {
      const g = c.createRadialGradient(h.sx, h.sy, 0, h.sx, h.sy, S * 0.12);
      g.addColorStop(0, 'rgba(220, 250, 255, 0.28)');
      g.addColorStop(1, 'rgba(220, 250, 255, 0)');
      c.fillStyle = g;
      c.beginPath(); c.arc(h.sx, h.sy, S * 0.12, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(220, 250, 255, 0.5)';
      c.lineWidth = 1.5;
      for (let i = 0; i < 2; i++) { c.beginPath(); c.arc(h.sx, h.sy, S * (0.05 + ((t * 0.06 + i * 0.05) % 0.1)), 0, TAU); c.stroke(); }
    } else {
      c.strokeStyle = 'rgba(220, 250, 255, 0.45)';
      c.lineWidth = 2;
      c.beginPath(); c.arc(h.sx, h.sy, S * 0.035, 0, TAU); c.stroke();
    }
    c.restore();
  }
}

// ======================================================================
// Loop
// ======================================================================
function populate() {
  fish.length = 0;
  for (const [kind, sp] of Object.entries(SPECIES)) for (let i = 0; i < sp.n; i++) fish.push(new Fish(kind));
  // tetras start together as a school
  const tx = rand(W * 0.3, W * 0.7), ty = rand(H * 0.3, H * 0.6);
  for (const f of fish) if (f.kind === 'tetra') { f.x = tx + rand(-60, 60); f.y = ty + rand(-40, 40); f.wa = 0; f.vx = 40; }
  for (const m of loadMine()) spriteFrom(m.data).then((img) => releaseFish(img, m.name, false)).catch(() => {});
}

function setStatus(st, text) { if (statusEl.dataset.state !== st) statusEl.dataset.state = st; if (statusText.textContent !== text) statusText.textContent = text; }
function setHint(text) { if (hint.textContent !== text) hint.textContent = text; }

let last = performance.now();
let hintShown = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;
  if (tracker) tracker.update(now, dt);
  readHands(now, dt);
  handActions(dt, now);
  airDraw();
  for (const p of pushes) p.life -= dt;
  for (let i = pushes.length - 1; i >= 0; i--) if (pushes[i].life <= 0) pushes.splice(i, 1);

  for (const f of fish) f.update(dt, t);

  const c = ctx;
  c.drawImage(bg, 0, 0, W, H);
  drawLight(c, t);
  drawCaustics(c, t);
  drawPlants(c, t, false);
  for (const cr of decor.corals) drawCoral(c, cr, t);
  // far fish, then a veil of water, then near fish
  const sorted = fish.slice().sort((a, b) => a.z - b.z);
  for (const f of sorted) if (f.z < 0.45) f.draw(c, t);
  c.fillStyle = 'rgba(30, 120, 150, 0.14)';
  c.fillRect(0, 0, W, H);
  drawChest(c, t);
  for (const f of sorted) if (f.z >= 0.45) f.draw(c, t);
  drawPlants(c, t, true);
  drawFood(c, dt, t);
  drawBubbles(c, dt, t);
  drawMotes(c, dt, t);
  drawSurface(c, t);
  drawHands(c, t);

  if (tracker?.running) {
    setStatus(hands.length ? 'active' : 'searching', hands.length ? (hands.length > 1 ? 'two hands in the water' : 'hand in the water') : 'show a hand');
    if (!drawing) setHint(hands.length ? '' : (hintShown++ < 600 ? 'Hold a hand up to the camera. Point a finger and the fish will come.' : ''));
    else setHint('');
  }
  const mine = fish.filter((f) => f.drawn).length;
  const txt = `${fish.length} fish${mine ? ` · ${mine} drawn by you` : ''}`;
  if (countEl.textContent !== txt) countEl.textContent = txt;
}

resize();
seedMotes();
populate();
requestAnimationFrame(frame);
window.addEventListener('resize', seedMotes);

setupToggle($('btn-mirror'), true, (v) => mirror.classList.toggle('hidden', !v));
setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
const guideToggle = setupToggle($('btn-guide'), true, (v) => guide.classList.toggle('hidden', !v));
$('guide-hide').addEventListener('click', () => guideToggle.set(false));
$('btn-feed').addEventListener('click', () => {
  sfx.init();
  for (let i = 0; i < 4; i++) dropFood(rand(W * 0.15, W * 0.85), SURF + 4, 4);
  S_.plop();
});

function enterTank(withCamera) {
  landing.classList.add('gone');
  hud.hidden = false;
  if (!withCamera) {
    mirror.classList.add('hidden');
    setStatus('active', 'mouse mode');
    setHint('Click to drop food. Drag to stir the water.');
    setTimeout(() => setHint(''), 6000);
  }
}

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Filling the tank…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new Tracker(video, { face: false });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    enterTank(true);
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    tracker = null;
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Hand tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});
$('no-camera').addEventListener('click', () => { sfx.init(); enterTank(false); });

// testing hook
window.tank = {
  fish, food, hands,
  setFakeHands(list) { fakeHands = list; },
  openPanel, closePanel,
  get drawing() { return drawing; },
  drawOnPad(fn) { fn(pc, pad); updateRelease(); },
  release: () => $('release').click(),
  scatter,
};
