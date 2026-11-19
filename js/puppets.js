// Shadow-puppet silhouettes, drawn from smooth tapered tubes and bezier petals so the
// shapes read as organic animals rather than stacked blocks. Every drawer works in unit
// space: facing +x, origin on the ground under the body, y negative is up.

// ---------- primitives ----------

// A smooth tube through control points with a half-width at each point (Catmull-Rom spine).
export function tube(c, pts, w, steps = 7) {
  const n = pts.length;
  const S = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let j = 0; j < steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      // smoothstep the width so bulges blend softly
      const tw = t * t * (3 - 2 * t);
      S.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]), w[i] + (w[i + 1] - w[i]) * tw]);
    }
  }
  S.push([pts[n - 1][0], pts[n - 1][1], w[n - 1]]);
  const m = S.length;
  const L = [], R = [], N = [];
  for (let k = 0; k < m; k++) {
    const a = S[Math.max(0, k - 1)], b = S[Math.min(m - 1, k + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const nx = -dy, ny = dx;
    N.push(Math.atan2(ny, nx));
    L.push([S[k][0] + nx * S[k][2], S[k][1] + ny * S[k][2]]);
    R.push([S[k][0] - nx * S[k][2], S[k][1] - ny * S[k][2]]);
  }
  c.beginPath();
  c.moveTo(L[0][0], L[0][1]);
  for (let k = 1; k < m; k++) c.lineTo(L[k][0], L[k][1]);
  c.arc(S[m - 1][0], S[m - 1][1], Math.max(S[m - 1][2], 1e-4), N[m - 1], N[m - 1] - Math.PI, true);
  for (let k = m - 1; k >= 0; k--) c.lineTo(R[k][0], R[k][1]);
  c.arc(S[0][0], S[0][1], Math.max(S[0][2], 1e-4), N[0] + Math.PI, N[0], true);
  c.closePath();
  c.fill();
}

// A leaf/ear/wing shape from base to tip; bend pushes the middle sideways.
export function petal(c, x0, y0, x1, y1, width, bend = 0) {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  c.beginPath();
  c.moveTo(x0, y0);
  c.quadraticCurveTo(mx + nx * (width + bend), my + ny * (width + bend), x1, y1);
  c.quadraticCurveTo(mx - nx * (width - bend), my - ny * (width - bend), x0, y0);
  c.closePath();
  c.fill();
}

export function ell(c, x, y, rx, ry, rot = 0) {
  c.beginPath();
  c.ellipse(x, y, Math.max(rx, 1e-4), Math.max(ry, 1e-4), rot, 0, Math.PI * 2);
  c.fill();
}

// two-bone IK: returns the joint between root and foot (dir +1 bends backward, -1 forward)
function ik(r, f, l1, l2, dir) {
  const dx = f[0] - r[0], dy = f[1] - r[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-4);
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d || 1))));
  const base = Math.atan2(dy, dx);
  const ang = base + dir * a;
  return [r[0] + Math.cos(ang) * l1, r[1] + Math.sin(ang) * l1];
}

// stance/swing foot motion: u in [0,1) → [x offset, lift]
function gait(u, A, H) {
  if (u < 0.62) return [A * (1 - (2 * u) / 0.62), 0];
  const v = (u - 0.62) / 0.38;
  const s = v * v * (3 - 2 * v);
  return [-A + 2 * A * s, Math.sin(Math.PI * v) * H];
}

// a wavy chain (tails, trunks): returns points
function chain(root, len, n, baseAng, curl, wag, t, speed = 6, lag = 0.7) {
  const pts = [root];
  let x = root[0], y = root[1], ang = baseAng;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    ang += curl / n + wag * Math.sin(t * speed - i * lag) * k * 0.6;
    x += Math.cos(ang) * (len / n);
    y += Math.sin(ang) * (len / n);
    pts.push([x, y]);
  }
  return pts;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- four-legged animals share one rig ----------
const QUAD = {
  dog: {
    hipX: -0.3, shoX: 0.25, backY: -0.6, shoLift: -0.02, bodyW: [0.06, 0.15, 0.135, 0.17], chest: [0.21, -0.52, 0.17, 0.16],
    l1: 0.29, l2: 0.31, legW: [0.075, 0.045, 0.034], stepA: 0.14, stepH: 0.08, neck: [0.38, -0.78], neckW: [0.13, 0.1],
    head: [0.5, -0.92], canSit: true,
  },
  cat: {
    hipX: -0.28, shoX: 0.22, backY: -0.5, shoLift: 0.0, bodyW: [0.04, 0.115, 0.1, 0.12], chest: [0.19, -0.45, 0.12, 0.11],
    l1: 0.25, l2: 0.25, legW: [0.06, 0.035, 0.026], stepA: 0.12, stepH: 0.07, neck: [0.32, -0.6], neckW: [0.09, 0.075],
    head: [0.4, -0.7], canSit: true,
  },
  deer: {
    hipX: -0.27, shoX: 0.24, backY: -0.82, shoLift: -0.03, bodyW: [0.05, 0.14, 0.12, 0.15], chest: [0.2, -0.76, 0.14, 0.15],
    l1: 0.4, l2: 0.42, legW: [0.06, 0.03, 0.02], stepA: 0.16, stepH: 0.1, neck: [0.4, -1.12], neckW: [0.09, 0.06],
    head: [0.47, -1.3], canSit: false,
  },
  elephant: {
    hipX: -0.3, shoX: 0.22, backY: -0.8, shoLift: -0.03, bodyW: [0.1, 0.23, 0.25, 0.23], chest: [0.16, -0.66, 0.2, 0.2],
    l1: 0.28, l2: 0.27, legW: [0.1, 0.082, 0.08], stepA: 0.1, stepH: 0.06, neck: [0.4, -0.84], neckW: [0.18, 0.17],
    head: [0.44, -0.9], canSit: false,
  },
};

function drawQuad(c, a, t, Q, kind) {
  const st = a.stride, cyc = a.cycle;
  const bob = -Math.abs(Math.sin(cyc * Math.PI * 2)) * 0.018 * st;
  const sit = Q.canSit ? a.sit : 0;
  const cr = a.crouch;
  const hip = [Q.hipX + sit * 0.1, Q.backY + bob + sit * (-Q.backY - 0.24) + cr * 0.05];
  const sho = [Q.shoX, Q.backY + bob + Q.shoLift + cr * 0.06 - sit * 0.04];
  const tailRoot = [hip[0] - 0.13, hip[1] - 0.03];

  // tail first so the body overlaps its root
  drawTail(c, a, t, kind, tailRoot);

  // legs: far pair, then near pair (a silhouette doesn't care, but the offsets give depth)
  const legs = [[true, 0.5, 0.035], [false, 0.75, 0.035], [true, 0, 0], [false, 0.25, 0]];
  for (const [hind, off, far] of legs) {
    const root = hind ? [hip[0] + far + 0.02, hip[1] + 0.05] : [sho[0] + far, sho[1] + 0.06];
    if (hind && sit > 0.5) {
      // folded haunch when sitting
      ell(c, hip[0] + 0.06, -0.13, 0.2 * (Q.l1 / 0.29), 0.12, -0.25);
      ell(c, hip[0] + 0.17, -0.025, 0.12 * (Q.l1 / 0.29), 0.032);
      continue;
    }
    const [fx, lift] = gait((cyc + off) % 1, Q.stepA * st, Q.stepH * st);
    const foot = [root[0] + fx + (hind ? -0.02 : 0.02), -lift];
    if (!hind && a.swat > 0.05 && !far) {
      // a cat paw raised to swat
      const paw = [root[0] + 0.16 + a.swat * 0.12, root[1] - 0.12 - a.swat * 0.22];
      tube(c, [root, ik(root, paw, Q.l1, Q.l2, -1), paw], Q.legW);
      ell(c, paw[0] + 0.02, paw[1], Q.legW[2] * 1.4, Q.legW[2] * 1.1);
      continue;
    }
    const knee = kind === 'elephant' ? [lerp(root[0], foot[0], 0.5) + 0.01, lerp(root[1], foot[1], 0.5)] : ik(root, foot, Q.l1, Q.l2, hind ? 1 : -1);
    tube(c, [root, knee, foot], Q.legW);
    if (kind === 'deer') ell(c, foot[0] + 0.012, foot[1] - 0.02, 0.028, 0.025);
    else ell(c, foot[0] + Q.legW[2] * 0.6, foot[1] - Q.legW[2] * 0.5, Q.legW[2] * 1.45, Q.legW[2] * 0.75);
  }

  // body: one smooth tube from rump to shoulders, plus a deep chest
  const mid = [(hip[0] + sho[0]) / 2, (hip[1] + sho[1]) / 2 + 0.02 - a.arch * 0.12];
  if (kind === 'elephant') {
    // a domed barrel: rounded rump, high shoulders, soft sagging belly
    ell(c, -0.02, -0.62 + bob, 0.4, 0.25, -0.06);
    ell(c, -0.24, -0.6 + bob, 0.17, 0.2);
    ell(c, 0.16, -0.66 + bob, 0.2, 0.22);
    ell(c, 0.0, -0.48 + bob, 0.3, 0.14);
  } else {
    tube(c, [[hip[0] - 0.1, hip[1] + 0.02], hip, mid, sho, [sho[0] + 0.07, sho[1] - 0.03]], Q.bodyW.concat([Q.bodyW[3] * 0.8]));
    ell(c, Q.chest[0], Q.chest[1] + bob + cr * 0.06, Q.chest[2], Q.chest[3]);
  }
  // belly tuck for slim animals
  if (kind !== 'elephant') ell(c, mid[0], mid[1] + 0.03, (sho[0] - hip[0]) * 0.42, Q.bodyW[2] * 0.85);

  // neck to head; the head reaches toward the hand
  const look = a.look;
  const hx = Q.head[0] + a.reach * clamp(look[0] - Q.head[0], -0.1, 0.25) * 0.6;
  const hy = Q.head[1] + bob + cr * 0.08 + a.reach * clamp(look[1] - Q.head[1], -0.25, 0.5) * 0.5 - sit * 0.02;
  const neck = [Q.neck[0], Q.neck[1] + bob + cr * 0.06];
  if (kind !== 'elephant') tube(c, [[sho[0] - 0.04, sho[1] - 0.02], neck, [hx, hy]], [Q.neckW[0], Q.neckW[1], Q.neckW[1] * 0.9]);
  c.save();
  c.translate(hx, hy);
  c.rotate(a.head);
  HEADS[kind](c, a, t);
  c.restore();
}

function drawTail(c, a, t, kind, root) {
  const wag = a.wag;
  if (kind === 'dog') {
    const pts = chain(root, 0.36, 5, -2.35 - a.happy * 0.35 + a.tailDown * 1.3, 0.5, wag, t, 14 + a.happy * 10, 0.6);
    tube(c, pts, [0.045, 0.04, 0.034, 0.026, 0.018, 0.01]);
  } else if (kind === 'cat') {
    const up = a.happy * 0.6 + (a.sit > 0.5 ? -1.3 : 0);
    const pts = chain(root, 0.62, 7, -2.6 + up, 1.6 - a.sit * 2.2, 0.35 + wag * 0.3, t, 2.2 + a.happy * 2, 0.55);
    tube(c, pts, [0.035, 0.034, 0.032, 0.03, 0.028, 0.026, 0.024, 0.02]);
  } else if (kind === 'deer') {
    const pts = chain(root, 0.12, 3, -2.0 - a.alert * 0.6, 0.2, wag * 0.5, t, 10, 0.5);
    tube(c, pts, [0.04, 0.04, 0.032, 0.02]);
  } else if (kind === 'elephant') {
    const pts = chain([root[0] + 0.02, root[1] + 0.05], 0.32, 4, 1.9, -0.2, 0.4 + wag * 0.3, t, 3, 0.6);
    tube(c, pts, [0.025, 0.018, 0.014, 0.012, 0.028]);
  }
}

const HEADS = {
  dog(c, a, t) {
    // skull + muzzle + jaw + ear
    ell(c, 0.0, 0.0, 0.135, 0.115);
    tube(c, [[0.03, 0.0], [0.15, 0.025], [0.24, 0.035]], [0.085, 0.065, 0.055]);
    ell(c, 0.27, 0.02, 0.04, 0.035); // nose
    c.save();
    c.translate(0.06, 0.06);
    c.rotate(a.jaw * 0.5);
    tube(c, [[0, 0], [0.12, 0.012], [0.19, 0.01]], [0.045, 0.035, 0.022]);
    c.restore();
    // ear: floppy → perked, swinging with a little lag
    const e = a.ear, sw = a.earSwing;
    const base = [-0.04, -0.08];
    const tip = [lerp(-0.14, -0.05, e) + sw * 0.04, lerp(0.14, -0.27, e)];
    petal(c, base[0] + 0.05, base[1], tip[0], tip[1], 0.065, -0.02);
    petal(c, base[0], base[1] + 0.01, tip[0] - 0.02, tip[1] + 0.02, 0.06, 0.01);
  },
  cat(c, a, t) {
    ell(c, 0, 0, 0.11, 0.1);
    ell(c, 0.09, 0.035, 0.065, 0.05);
    ell(c, 0.155, 0.025, 0.025, 0.022);
    const back = a.earBack;
    for (const [ex, ph] of [[-0.06, 0], [0.04, 0.4]]) {
      c.beginPath();
      c.moveTo(ex - 0.05, -0.05);
      c.quadraticCurveTo(ex - 0.04 - back * 0.05, -0.15, ex - back * 0.08 + Math.sin(t * 3 + ph) * 0.005, -0.21 + back * 0.08);
      c.quadraticCurveTo(ex + 0.03, -0.14, ex + 0.06, -0.06);
      c.closePath();
      c.fill();
    }
    c.lineWidth = 0.006;
    c.lineCap = 'round';
    for (const [wy, wl] of [[0.035, 0.18], [0.055, 0.17], [0.075, 0.15]]) {
      c.beginPath(); c.moveTo(0.14, wy); c.quadraticCurveTo(0.22, wy - 0.01, 0.14 + wl, wy + (wy - 0.05) * 0.8); c.stroke();
    }
  },
  deer(c, a, t) {
    ell(c, 0, 0, 0.09, 0.075, 0.2);
    tube(c, [[0.04, 0.01], [0.13, 0.05], [0.19, 0.07]], [0.06, 0.045, 0.035]);
    ell(c, 0.2, 0.065, 0.028, 0.025);
    // ears
    const e = a.alert;
    petal(c, -0.03, -0.05, -0.16 + e * 0.04, -0.12 - e * 0.06, 0.035, 0.0);
    // antlers: branching tines
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const tine = (pts, w) => tube(c, pts, w, 5);
    tine([[-0.01, -0.07], [-0.04, -0.2], [-0.02, -0.33], [0.03, -0.42]], [0.018, 0.015, 0.012, 0.008]);
    tine([[-0.035, -0.18], [0.04, -0.24], [0.08, -0.28]], [0.012, 0.01, 0.007]);
    tine([[-0.025, -0.3], [-0.1, -0.37], [-0.13, -0.42]], [0.011, 0.009, 0.006]);
    tine([[0.02, -0.07], [0.04, -0.17], [0.09, -0.26]], [0.016, 0.012, 0.008]);
  },
  elephant(c, a, t) {
    // big domed head
    ell(c, 0.0, -0.02, 0.19, 0.2);
    ell(c, 0.09, 0.06, 0.13, 0.14);
    // trunk: hangs and sways, curls up to trumpet, reaches for your hand
    const reachAng = Math.atan2(a.look[1] - (-0.86 + 0.1), a.look[0] - 0.55);
    const raise = a.trunkUp;
    let base = lerp(1.35, -0.6, raise);
    base = lerp(base, clamp(reachAng, -1.4, 1.6), a.reach * 0.8);
    const curl = lerp(-0.4, -1.6, raise) * (1 - a.reach * 0.7);
    const pts = chain([0.14, 0.1], 0.55, 7, base, curl, 0.25, t, 1.6, 0.5);
    tube(c, pts, [0.085, 0.075, 0.064, 0.054, 0.045, 0.038, 0.033, 0.035]);
    // ear flap with secondary motion
    const flap = a.earSwing;
    c.save();
    c.translate(-0.12, -0.08);
    c.rotate(-0.1 + flap * 0.4);
    c.beginPath();
    c.moveTo(0.02, -0.12);
    c.bezierCurveTo(-0.22, -0.22, -0.34, 0.08, -0.22, 0.3);
    c.bezierCurveTo(-0.14, 0.42, 0.02, 0.34, 0.06, 0.16);
    c.closePath();
    c.fill();
    c.restore();
  },
};

// ---------- other bodies ----------
function drawRabbit(c, a, t) {
  const air = a.airK; // 0 on the ground, 1 mid-hop
  const squat = a.crouch;
  c.save();
  c.translate(0, -0.25);
  c.rotate(-air * 0.15);
  c.scale(1 + air * 0.12, 1 - air * 0.08 - squat * 0.05);
  c.translate(0, 0.25);
  // hind foot
  if (air > 0.3) tube(c, [[-0.18, -0.2], [-0.3, -0.1], [-0.42, -0.05]], [0.06, 0.04, 0.03]);
  else ell(c, -0.08, -0.03, 0.2, 0.04);
  // tail puff
  ell(c, -0.36, -0.3, 0.075, 0.07);
  // body hunch
  tube(c, [[-0.3, -0.18], [-0.2, -0.36], [0.0, -0.4], [0.14, -0.36]], [0.16, 0.2, 0.18, 0.13]);
  ell(c, -0.15, -0.22, 0.19, 0.17);
  // front paws
  const fp = air > 0.3 ? [0.32, -0.2] : [0.2, -0.02];
  tube(c, [[0.1, -0.3], [0.17, -0.15], fp], [0.05, 0.035, 0.03]);
  // head
  const hx = 0.26 + a.reach * 0.06, hy = -0.47 + squat * 0.06 + a.reach * 0.05;
  c.save();
  c.translate(hx, hy);
  c.rotate(a.head * 0.5);
  ell(c, 0, 0, 0.13, 0.11);
  ell(c, 0.1, 0.035 + Math.sin(t * 28) * 0.004 * a.sniff, 0.07, 0.06);
  // ears with lag
  const back = a.earBack, sw = a.earSwing;
  petal(c, -0.04, -0.06, -0.08 - back * 0.3 + sw * 0.03, -0.42 + back * 0.22, 0.055, 0.01);
  petal(c, 0.02, -0.07, 0.0 - back * 0.32 + sw * 0.05, -0.41 + back * 0.24, 0.05, -0.01);
  c.restore();
  c.restore();
}

function drawSnake(c, a, t) {
  const n = 11;
  const pts = [];
  const rear = a.reach; // how far the head rises toward your hand
  const wave = a.cycle * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const x = lerp(-0.85, 0.22, k);
    let y = -0.05 - Math.max(0, Math.sin(wave - i * 0.95)) * 0.05 * (0.5 + a.stride * 0.5);
    // the front third lifts when rearing
    const lift = clamp((k - 0.6) / 0.4, 0, 1);
    const hy = lerp(-0.06, clamp(a.look[1], -0.75, -0.08), rear);
    y = lerp(y, hy * lift * lift + y * (1 - lift), lift);
    pts.push([x + rear * lift * 0.05, y]);
  }
  // sway the raised head
  const last = pts[n - 1];
  last[0] += Math.sin(t * 2) * 0.03 * rear;
  tube(c, pts, [0.008, 0.028, 0.045, 0.06, 0.07, 0.076, 0.076, 0.07, 0.062, 0.054, 0.05]);
  const prev = pts[n - 2];
  const ang = Math.atan2(last[1] - prev[1], last[0] - prev[0]) * 0.7;
  c.save();
  c.translate(last[0], last[1]);
  c.rotate(ang);
  ell(c, 0.05, 0, 0.1, 0.06);
  ell(c, 0.12, 0.008, 0.06, 0.042);
  if (a.tongue > 0) {
    c.lineWidth = 0.008;
    c.lineCap = 'round';
    const L = 0.07 * a.tongue;
    c.beginPath();
    c.moveTo(0.14, 0.01); c.lineTo(0.14 + L, 0.01);
    c.lineTo(0.17 + L, -0.01); c.moveTo(0.14 + L, 0.01); c.lineTo(0.17 + L, 0.03);
    c.stroke();
  }
  c.restore();
}

function drawCroc(c, a, t) {
  const st = a.stride, cyc = a.cycle;
  const sway = Math.sin(t * 1.5) * 0.015;
  // short splayed legs
  for (const [rx, off, far] of [[-0.35, 0.5, 0.03], [0.12, 0.75, 0.03], [-0.32, 0, 0], [0.15, 0.25, 0]]) {
    const root = [rx + far, -0.12];
    const [fx, lift] = gait((cyc + off) % 1, 0.08 * st, 0.05 * st);
    const foot = [root[0] + fx + 0.04, -lift];
    tube(c, [root, [root[0] - 0.05, root[1] + 0.08], foot], [0.04, 0.032, 0.03]);
    ell(c, foot[0] + 0.03, foot[1] - 0.01, 0.045, 0.015);
  }
  const body = [[-1.0, -0.06 + sway], [-0.72, -0.09 + sway * 0.5], [-0.42, -0.13], [-0.1, -0.15], [0.18, -0.14], [0.3, -0.135]];
  tube(c, body, [0.008, 0.035, 0.07, 0.095, 0.085, 0.07]);
  // ridges along the back
  for (let x = -0.85; x < 0.2; x += 0.07) {
    const k = clamp((x + 0.95) / 0.5, 0, 1);
    const y = x < -0.42 ? lerp(-0.08, -0.2, (x + 0.85) / 0.43) : -0.22 - (x > 0 ? (x - 0) * 0.05 : 0);
    const h = 0.03 * k;
    c.beginPath(); c.moveTo(x - 0.025, y + 0.02); c.lineTo(x, y - h); c.lineTo(x + 0.025, y + 0.02); c.closePath(); c.fill();
  }
  // jaws hinge open
  const j = a.jaw;
  const lift = a.reach * 0.08;
  c.save();
  c.translate(0.3, -0.14 - lift);
  c.rotate(-a.reach * 0.15);
  c.save();
  c.rotate(-j * 0.45);
  tube(c, [[-0.02, -0.01], [0.16, -0.015], [0.4, -0.005]], [0.06, 0.042, 0.026]);
  ell(c, 0.02, -0.06, 0.035, 0.028); // eye bump
  c.restore();
  c.save();
  c.rotate(j * 0.3);
  tube(c, [[-0.02, 0.02], [0.16, 0.025], [0.37, 0.02]], [0.045, 0.03, 0.02]);
  if (j > 0.15) {
    // teeth
    for (let x = 0.06; x < 0.34; x += 0.045) { c.beginPath(); c.moveTo(x - 0.012, 0.0); c.lineTo(x, -0.03 * j); c.lineTo(x + 0.012, 0.0); c.closePath(); c.fill(); }
  }
  c.restore();
  c.restore();
}

function drawSwan(c, a, t) {
  const bob = Math.sin(t * 1.6) * 0.008;
  c.save();
  c.translate(0, bob);
  // hull and tail
  tube(c, [[-0.4, -0.36], [-0.28, -0.26], [-0.05, -0.2], [0.18, -0.24], [0.27, -0.3]], [0.01, 0.1, 0.13, 0.12, 0.08]);
  ell(c, -0.02, -0.17, 0.3, 0.09);
  // wing lifts with joy or alarm
  const w = a.wing;
  petal(c, -0.2, -0.27, 0.16 - w * 0.12, -0.34 - w * 0.36, 0.1 + w * 0.05, 0.03);
  petal(c, -0.12, -0.27, -0.32 - w * 0.1, -0.38 - w * 0.3, 0.07 * (0.6 + w), -0.02);
  // S-neck that bends toward your hand
  const tx = lerp(0.3, clamp(a.look[0], 0.1, 0.75), a.reach);
  const ty = lerp(-0.86, clamp(a.look[1], -1.0, -0.3), a.reach);
  const neck = [[0.2, -0.3], [0.32, -0.45], [lerp(0.24, (0.32 + tx) / 2, a.reach), lerp(-0.66, (-0.6 + ty) / 2, a.reach)], [tx, ty]];
  tube(c, neck, [0.065, 0.042, 0.036, 0.034]);
  const hd = Math.atan2(ty - neck[2][1], tx - neck[2][0]);
  c.save();
  c.translate(tx, ty);
  c.rotate(hd + Math.PI / 2 * (1 - a.reach) * 0.85 - 0.1);
  ell(c, 0.02, 0, 0.055, 0.045);
  tube(c, [[0.04, 0.005], [0.1, 0.02], [0.15, 0.03]], [0.03, 0.02, 0.008]);
  c.restore();
  c.restore();
}

function drawBird(c, a, t) {
  c.save();
  c.translate(0, -0.2);
  c.rotate(a.tilt);
  if (a.mode !== 'fly') {
    tube(c, [[-0.02, 0.08], [-0.03, 0.2]], [0.012, 0.009]);
    tube(c, [[0.04, 0.08], [0.05, 0.2]], [0.012, 0.009]);
  }
  tube(c, [[-0.2, 0.02], [-0.05, 0.02], [0.1, -0.02], [0.18, -0.06]], [0.04, 0.11, 0.1, 0.07]);
  petal(c, -0.15, 0.0, -0.46, -0.03, 0.06, 0.0);
  const hy = -0.09 + (a.peck > 0 ? Math.sin(a.peck * Math.PI) * 0.16 : 0);
  ell(c, 0.2, hy, 0.08, 0.072);
  c.beginPath(); c.moveTo(0.26, hy - 0.025); c.quadraticCurveTo(0.34, hy - 0.01, 0.4, hy + 0.012 + a.beak * 0.02); c.lineTo(0.26, hy + 0.02); c.closePath(); c.fill();
  if (a.mode === 'fly') {
    const f = Math.sin(a.flap), f2 = Math.sin(a.flap - 0.6); // the tip lags the shoulder
    for (const k of [1, 0.75]) {
      c.beginPath();
      c.moveTo(0.1, -0.04);
      c.bezierCurveTo(0.04, -0.2 * f * k, -0.1, -0.38 * f2 * k, -0.24, -0.5 * f2 * k - 0.02);
      c.bezierCurveTo(-0.16, -0.25 * f * k, -0.12, -0.05, -0.1, 0.01);
      c.closePath();
      c.fill();
    }
  } else {
    petal(c, 0.1, -0.04, -0.24, 0.0 - a.wingUp * 0.25, 0.07, 0.02);
  }
  c.restore();
}

function drawButterfly(c, a, t) {
  c.save();
  c.translate(0, -0.18);
  c.rotate(a.tilt * 0.6 + 0.25);
  const o = a.mode === 'fly' ? 0.15 + 0.85 * Math.abs(Math.cos(a.flap)) : 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(t * 1.4));
  for (const s of [-1, 1]) {
    const k = s * o;
    c.beginPath();
    c.moveTo(0, -0.02);
    c.bezierCurveTo(0.08 * k, -0.34, 0.42 * k, -0.4, 0.38 * k, -0.14);
    c.bezierCurveTo(0.36 * k, -0.04, 0.12 * k, -0.01, 0, 0);
    c.fill();
    c.beginPath();
    c.moveTo(0, 0.01);
    c.bezierCurveTo(0.22 * k, 0.02, 0.3 * k, 0.24, 0.14 * k, 0.27);
    c.bezierCurveTo(0.06 * k, 0.29, 0.02 * k, 0.14, 0, 0.02);
    c.fill();
  }
  tube(c, [[0, -0.1], [0, 0.04], [0, 0.16]], [0.022, 0.02, 0.01]);
  ell(c, 0, -0.12, 0.028, 0.026);
  c.lineWidth = 0.01;
  c.lineCap = 'round';
  for (const s of [-1, 1]) {
    c.beginPath(); c.moveTo(0, -0.13); c.quadraticCurveTo(s * 0.04, -0.25, s * 0.09, -0.28); c.stroke();
    ell(c, s * 0.09, -0.28, 0.014, 0.014);
  }
  c.restore();
}

export const DRAW = {
  dog: (c, a, t) => drawQuad(c, a, t, QUAD.dog, 'dog'),
  cat: (c, a, t) => drawQuad(c, a, t, QUAD.cat, 'cat'),
  deer: (c, a, t) => drawQuad(c, a, t, QUAD.deer, 'deer'),
  elephant: (c, a, t) => drawQuad(c, a, t, QUAD.elephant, 'elephant'),
  rabbit: drawRabbit,
  snake: drawSnake,
  croc: drawCroc,
  swan: drawSwan,
  bird: drawBird,
  butterfly: drawButterfly,
};

// body length as a fraction of the shorter screen side
export const SIZE = { dog: 0.27, cat: 0.25, rabbit: 0.24, deer: 0.27, elephant: 0.3, snake: 0.34, croc: 0.34, swan: 0.3, bird: 0.15, butterfly: 0.17 };
export const NAMES = { dog: 'dog', cat: 'cat', rabbit: 'rabbit', deer: 'deer', elephant: 'elephant', snake: 'snake', croc: 'crocodile', swan: 'swan', bird: 'bird', butterfly: 'butterfly' };
export const FLIERS = new Set(['bird', 'butterfly']);

// all the pose fields a drawer may read, at rest
export function restPose() {
  return {
    cycle: 0, stride: 0, sit: 0, crouch: 0, reach: 0, head: 0, jaw: 0, ear: 0.5, earBack: 0, earSwing: 0, arch: 0, swat: 0, sniff: 0,
    happy: 0, wag: 0.3, tailDown: 0, alert: 0, trunkUp: 0, tongue: 0, wing: 0, look: [0.6, -0.6], airK: 0,
    mode: 'fly', flap: 0, tilt: 0, peck: 0, beak: 0, wingUp: 0,
  };
}
