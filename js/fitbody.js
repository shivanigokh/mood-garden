// Fitted game body: instead of carving the raw silhouettes (which a single webcam
// turns into lumps), build a smooth, game-style body and size every part of it to
// you: head, neck, torso, hips or skirt, arms, legs and feet, measured from the
// front and side shots of your spin. The photos are then painted onto it.
//
// Body frame (same as scan3d.js): height 1 from the feet, x = your left (image
// right in the front shot), z = toward the camera in the front shot.
import * as THREE from 'three';
import { BONES, BOX, restJoints } from './scan3d.js?v=10';

const SEG = 36; // vertices around each ring

// --- measuring the shots -----------------------------------------------------------
// runs of body pixels on the row at height y, in body units (u = sideways from the axis)
function runs(v, y) {
  const iy = Math.round(v.yb - y * v.s);
  if (iy < 0 || iy >= v.h) return [];
  const out = [];
  let a = -1, gap = 0;
  const row = iy * v.w;
  for (let x = 0; x <= v.w; x++) {
    const on = x < v.w && v.mask[row + x] > 0.5;
    if (on) { if (a < 0) a = x; gap = 0; }
    else if (a >= 0) {
      gap++;
      if (gap > 2 || x === v.w) {
        const b = x - gap;
        if (b - a >= 3) out.push([(a - v.x0) / v.s, (b + 1 - v.x0) / v.s]);
        a = -1; gap = 0;
      }
    }
  }
  return out;
}
// the run that holds (or is nearest to) u
function runNear(v, y, u, reach = 0.04) {
  let best = null, bd = reach;
  for (const r of runs(v, y)) {
    const d = u < r[0] ? r[0] - u : u > r[1] ? u - r[1] : 0;
    if (d <= bd) { bd = d; best = r; }
  }
  return best;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const median = (xs) => { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// --- building the shape ------------------------------------------------------------
// a tube through a path of rings: [{ p: Vector3, rx, rz }], with rounded caps
function tube(pts, capA = true, capB = true) {
  const pos = [], idx = [];
  const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
  const frames = pts.map((q, i) => {
    const t = new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)].p, pts[Math.max(i - 1, 0)].p).normalize();
    let a = new THREE.Vector3().crossVectors(t, Z);
    if (a.lengthSq() < 1e-4) a = new THREE.Vector3().crossVectors(t, X);
    a.normalize();
    const b = new THREE.Vector3().crossVectors(a, t).normalize();
    return { t, a, b };
  });
  const ring = (c, a, b, rx, rz) => {
    for (let k = 0; k < SEG; k++) {
      const f = (k / SEG) * Math.PI * 2;
      pos.push(c.x + a.x * rx * Math.cos(f) + b.x * rz * Math.sin(f), c.y + a.y * rx * Math.cos(f) + b.y * rz * Math.sin(f), c.z + a.z * rx * Math.cos(f) + b.z * rz * Math.sin(f));
    }
  };
  const rings = [];
  const addCap = (i, dir) => {
    const q = pts[i], F = frames[i], r = Math.min(q.rx, q.rz);
    // two shrinking rings and a tip make a soft dome
    const out = [];
    for (const [d, k] of [[0.55, 0.82], [0.9, 0.45]]) out.push({ c: q.p.clone().addScaledVector(F.t, dir * r * d), rx: q.rx * k, rz: q.rz * k, F });
    return { rings: out, tip: q.p.clone().addScaledVector(F.t, dir * r * 1.02) };
  };
  const start = capA ? addCap(0, -1) : null, end = capB ? addCap(pts.length - 1, 1) : null;
  if (start) for (const r of start.rings.slice().reverse()) rings.push(r);
  pts.forEach((q, i) => rings.push({ c: q.p, rx: q.rx, rz: q.rz, F: frames[i] }));
  if (end) for (const r of end.rings) rings.push(r);
  for (const r of rings) ring(r.c, r.F.a, r.F.b, r.rx, r.rz);
  for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < SEG; k++) {
    const a = i * SEG + k, b = i * SEG + ((k + 1) % SEG), c = a + SEG, d = b + SEG;
    idx.push(a, c, b, b, c, d);
  }
  if (start) {
    const tip = pos.length / 3;
    pos.push(start.tip.x, start.tip.y, start.tip.z);
    for (let k = 0; k < SEG; k++) idx.push(tip, k, (k + 1) % SEG);
  }
  if (end) {
    const tip = pos.length / 3, base = (rings.length - 1) * SEG;
    pos.push(end.tip.x, end.tip.y, end.tip.z);
    for (let k = 0; k < SEG; k++) idx.push(tip, base + ((k + 1) % SEG), base + k);
  }
  return { pos, idx, rings };
}

// ---------------------------------------------------------------------------------
export function fitBody(views, front) {
  const J = restJoints(front);
  const V = (o) => new THREE.Vector3(o.x, o.y, o.z || 0);
  // side shots: the two closest to a quarter turn either way
  const sideScore = (v) => Math.abs(Math.sin(v.theta));
  const sides = views.slice().sort((a, b) => sideScore(b) - sideScore(a)).slice(0, 4);
  const backs = views.filter((v) => Math.cos(v.theta) < -0.9);
  const sideWidth = (y, near = 0) => median(sides.map((v) => { const r = runNear(v, y, near, 0.06); return r ? r[1] - r[0] : null; }));
  const frontRun = (y, u, reach) => runNear(front, y, u, reach);

  const sw = Math.abs(J[11].x - J[12].x); // shoulder joint spacing
  const hipJ = Math.max(0.05, Math.abs(J[23].x - J[24].x));
  const k = clamp(sw / 0.22, 0.75, 1.3); // overall build, for parts we can't measure well
  const parts = [];

  // --- head (hair included: the front outline at eye height) ---
  const eyeY = J.eyeMid.y;
  const topY = clamp(median(views.map((v) => (v.top >= 0 ? (v.yb - v.top) / v.s : null))) ?? 1, eyeY + 0.04, 1.03);
  const hr = frontRun(eyeY, J.eyeMid.x, 0.05);
  // a slightly big, rounded game head (long hair makes the outline wide, so cap it)
  const headW = clamp(hr ? hr[1] - hr[0] : 0.13, 0.11, 0.16) * 1.06;
  const headX = J.eyeMid.x;
  const headD = clamp(sideWidth(eyeY) ?? headW * 1.15, headW * 1.0, headW * 1.25);
  const chin0 = eyeY - (topY - eyeY) * 0.85;
  const headH = clamp(topY - chin0, headW * 1.15, headW * 1.4);
  const chinY = Math.min(chin0, topY - headH);
  {
    const top = chinY + headH;
    const cy = (top + chinY) / 2, ry = headH / 2;
    const pts = [];
    const n = 20;
    for (let i = 0; i <= n; i++) {
      // cosine spacing puts more rings near the crown and chin, so both stay round
      const f = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
      const y = chinY + f * headH;
      const e = Math.sqrt(Math.max(0.0004, 1 - Math.pow((y - cy) / ry, 2)));
      const jaw = y < cy ? lerp(0.86, 1, Math.min(1, (y - chinY) / (cy - chinY) * 1.3)) : 1;
      pts.push({ p: new THREE.Vector3(headX, y, 0.004), rx: (headW / 2) * e * jaw, rz: (headD / 2) * e });
    }
    parts.push({ ...tube(pts, false, false), bones: [['head', V(J.shMid), new THREE.Vector3(headX, top, 0)]] });
  }
  // --- neck (runs up inside the head so there's no gap) ---
  {
    const nr = 0.036 * k;
    parts.push({ ...tube([{ p: V(J.shMid).setY(J.shMid.y - 0.04), rx: nr * 1.1, rz: nr }, { p: new THREE.Vector3(headX, chinY + 0.05, -0.004), rx: nr * 0.92, rz: nr * 0.92 }], false, false), bones: [['spine', V(J.hipMid), V(J.shMid)], ['head', V(J.shMid), new THREE.Vector3(headX, topY, 0)]] });
  }
  // --- torso: hips to shoulders, width from the front outline, depth from the side ---
  const hipY = J.hipMid.y, shY = J.shMid.y;
  const hipRun = frontRun(hipY, J.hipMid.x, 0.04);
  const hipW = clamp(hipRun ? hipRun[1] - hipRun[0] : hipJ * 1.8, hipJ * 1.4, hipJ * 2.8);
  const torsoW = (t, y, cx) => {
    const r = frontRun(y, cx, 0.03);
    const maxW = lerp(hipW * 1.08, sw * 1.28, t), minW = lerp(hipW * 0.8, sw * 0.95, t);
    // arms resting against your sides widen the outline, so keep it in range
    return clamp(r ? r[1] - r[0] : lerp(hipW, sw * 1.15, t), minW, maxW);
  };
  {
    const pts = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = lerp(hipY - 0.02, shY - 0.015, t), cx = lerp(J.hipMid.x, J.shMid.x, t);
      const w = torsoW(t, y, cx);
      const d = clamp(sideWidth(y) ?? w * 0.6, w * 0.5, w * 0.78);
      pts.push({ p: new THREE.Vector3(cx, y, 0), rx: w / 2, rz: d / 2 });
    }
    // even out the bumps (arms touching your sides, loose clothes)
    for (let pass = 0; pass < 3; pass++) {
      const rx = pts.map((q) => q.rx), rz = pts.map((q) => q.rz);
      for (let i = 1; i < pts.length - 1; i++) { pts[i].rx = 0.25 * rx[i - 1] + 0.5 * rx[i] + 0.25 * rx[i + 1]; pts[i].rz = 0.25 * rz[i - 1] + 0.5 * rz[i] + 0.25 * rz[i + 1]; }
    }
    // rounded shoulders that slope into the neck
    const last = pts[pts.length - 1];
    for (const [dy, kx, kz] of [[0.015, 0.97, 0.97], [0.03, 0.88, 0.92], [0.045, 0.68, 0.8], [0.056, 0.4, 0.55]]) {
      pts.push({ p: new THREE.Vector3(J.shMid.x, shY - 0.015 + dy, -0.004), rx: last.rx * kx, rz: last.rz * kz });
    }
    parts.push({ ...tube(pts, true, false), bones: [['hips', V(J[24]), V(J[23])], ['spine', V(J.hipMid), V(J.shMid)]] });
  }
  // --- hair: its own shape, measured from the back and front shots ---
  const hair = buildHair();
  function buildHair() {
    const back = views.reduce((a, b) => (Math.cos(b.theta) < Math.cos(a.theta) ? b : a));
    const px = (v, u, y) => {
      const x = Math.round(v.x0 + u * v.s), yy = Math.round(v.yb - y * v.s);
      if (x < 0 || yy < 0 || x >= v.w || yy >= v.h) return null;
      const i = yy * v.w + x;
      if (v.mask[i] < 0.5) return null;
      return [v.rgba[i * 4], v.rgba[i * 4 + 1], v.rgba[i * 4 + 2]];
    };
    // hair colour: the median of a patch at the back of the head, just under the crown
    const bu = -headX; // the back shot is mirrored left to right
    const samples = [];
    for (let dy = 0.015; dy <= 0.06; dy += 0.008) for (let du = -0.03; du <= 0.03; du += 0.01) { const c = px(back, bu + du, topY - dy); if (c) samples.push(c); }
    if (samples.length < 5) return null;
    const med = [0, 1, 2].map((k) => median(samples.map((c) => c[k])));
    const isHair = (c) => {
      if (!c) return false;
      const d = Math.hypot(c[0] - med[0], c[1] - med[1], c[2] - med[2]);
      const lum = (c[0] + c[1] + c[2]) / 3, ml = (med[0] + med[1] + med[2]) / 3;
      return d < 52 + ml * 0.12 && Math.abs(lum - ml) < 55;
    };
    // the hair's width on each row of the back shot, centred near the spine
    const rowHair = (v, cu, y, half) => {
      let a = null, b = null;
      for (let u = cu; u >= cu - half; u -= 0.004) { if (isHair(px(v, u, y))) a = u; else if (a != null && cu - u > 0.02) break; }
      for (let u = cu; u <= cu + half; u += 0.004) { if (isHair(px(v, u, y))) b = u; else if (b != null && u - cu > 0.02) break; }
      return a != null && b != null && b - a > 0.025 ? [a, b] : null;
    };
    const rows = [];
    let miss = 0;
    for (let y = eyeY; y > hipY + 0.02; y -= 0.012) {
      const r = rowHair(back, bu, y, Math.max(headW * 0.8, sw * 0.75));
      if (!r) { if (++miss >= 2) break; continue; }
      miss = 0;
      rows.push({ y, w: r[1] - r[0], cx: -(r[0] + r[1]) / 2 });
    }
    const endY = rows.length ? rows[rows.length - 1].y : eyeY;
    const out = [];
    // cap over the crown and the back of the head
    {
      const top = chinY + headH, cy = (top + chinY) / 2, ry = headH / 2;
      const y0 = eyeY + 0.012;
      const pts = [];
      const n = 12;
      for (let i = 0; i <= n; i++) {
        const f = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
        const y = y0 + f * (top + 0.008 - y0);
        const e = Math.sqrt(Math.max(0.0004, 1 - Math.pow((y - cy) / (ry + 0.008), 2)));
        pts.push({ p: new THREE.Vector3(headX, y, -0.006), rx: (headW / 2 + 0.008) * e, rz: (headD / 2 + 0.008) * e });
      }
      out.push({ ...tube(pts, true, false), bones: [['head', V(J.shMid), new THREE.Vector3(headX, topY, 0)]] });
    }
    // the length that falls down the back
    if (endY < chinY + 0.02) {
      const depthAt = (y) => (y > chinY ? headD : y > shY ? 0.07 * k : clamp(sideWidth(y) ?? 0.18, 0.12, 0.3));
      const pts = [];
      const step = Math.max(1, Math.floor(rows.length / 14));
      for (let i = 0; i < rows.length; i += step) {
        const r = rows[i];
        const th = r.y > shY ? 0.024 : 0.019;
        const w = clamp(r.w, 0.05, Math.max(headW * 1.15, sw * 1.1));
        pts.push({ p: new THREE.Vector3(r.cx, r.y, -depthAt(r.y) / 2 - th * 0.4), rx: w / 2, rz: th });
      }
      // taper to the tips
      const lastR = rows[rows.length - 1];
      pts.push({ p: new THREE.Vector3(lastR.cx, endY - 0.015, -depthAt(endY) / 2 - 0.006), rx: Math.min(lastR.w, 0.2) * 0.35, rz: 0.008 });
      if (pts.length >= 2) out.push({ ...tube(pts, false, true), bones: [['head', V(J.shMid), new THREE.Vector3(headX, topY, 0)], ['spine', V(J.hipMid), V(J.shMid)]] });
    }
    // strands that fall forward over the shoulders, seen in the front shot
    for (const sd of [1, -1]) {
      const pts = [];
      let gone = 0;
      for (let y = chinY + 0.01; y > hipY + 0.05; y -= 0.012) {
        // look beside the neck, out to the shoulder
        let a = null, b = null;
        for (let u = headX + sd * 0.035; Math.abs(u - headX) < sw * 0.62; u += sd * 0.004) {
          if (isHair(px(front, u, y))) { if (a == null) a = u; b = u; } else if (a != null && Math.abs(u - b) > 0.015) break;
        }
        if (a == null || Math.abs(b - a) < 0.015) { if (++gone >= 2) break; continue; }
        gone = 0;
        const d = clamp(sideWidth(y) ?? 0.16, 0.1, 0.28);
        pts.push({ p: new THREE.Vector3((a + b) / 2, y, y > shY ? 0.01 : d / 2 + 0.006), rx: Math.abs(b - a) / 2, rz: 0.014 });
      }
      if (pts.length >= 3) {
        // start inside the side of the head so the strand hangs from it
        pts.unshift({ p: new THREE.Vector3(headX + sd * headW * 0.38, eyeY, 0), rx: 0.025, rz: 0.03 });
        out.push({ ...tube(pts, false, true), bones: [['head', V(J.shMid), new THREE.Vector3(headX, topY, 0)], ['spine', V(J.hipMid), V(J.shMid)]] });
      }
    }
    return { parts: out, length: endY };
  }
  if (hair) parts.push(...hair.parts);
  // --- lower body: from the hips down to where the outline splits into two legs ---
  // (just below the crotch in trousers, at the hem of a skirt or dress)
  const kneeY = (J[25].y + J[26].y) / 2;
  let splitY = hipY - 0.06;
  for (let y = hipY - 0.03; y > kneeY - 0.12 && y > 0.12; y -= 0.006) {
    const rs = runs(front, y).filter((r) => r[1] - r[0] > 0.02 && r[1] > J.hipMid.x - 0.2 && r[0] < J.hipMid.x + 0.2);
    const l = rs.some((r) => (r[0] + r[1]) / 2 > J.hipMid.x + 0.01), rr = rs.some((r) => (r[0] + r[1]) / 2 < J.hipMid.x - 0.01);
    const one = rs.some((r) => r[0] < J.hipMid.x - 0.01 && r[1] > J.hipMid.x + 0.01);
    if (l && rr && !one) { splitY = y; break; }
  }
  const skirt = splitY < hipY - 0.12;
  {
    const pts = [];
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = lerp(hipY + 0.02, splitY + 0.01, t);
      const r = frontRun(y, J.hipMid.x, 0.03);
      const w = clamp(r ? r[1] - r[0] : hipW, hipW * 0.75, hipW * (skirt ? 1.6 : 1.15));
      const cx = r ? (r[0] + r[1]) / 2 : J.hipMid.x;
      const d = clamp(sideWidth(y) ?? w * 0.65, w * 0.5, w * 0.82);
      pts.push({ p: new THREE.Vector3(cx, y, 0), rx: w / 2, rz: d / 2 });
    }
    parts.push({ ...tube(pts, true, !skirt), bones: [['hips', V(J[24]), V(J[23])], ['thighL', V(J[23]), V(J[25])], ['thighR', V(J[24]), V(J[26])]], skirt });
  }
  // --- legs, following the outline of each leg below the split ---
  for (const [hip, knee, ankle, th, sh] of [[23, 25, 27, 'thighL', 'shinL'], [24, 26, 28, 'thighR', 'shinR']]) {
    const pts = [];
    // legs always reach the feet (the ankle mark sits high when the feet are out of shot)
    const yA = clamp(J[ankle].y, 0.045, 0.075), y0 = splitY + 0.03;
    const n = 10;
    const legX = (y) => (y > J[knee].y ? lerp(J[knee].x, J[hip].x, (y - J[knee].y) / Math.max(0.01, J[hip].y - J[knee].y)) : lerp(J[ankle].x, J[knee].x, (y - J[ankle].y) / Math.max(0.01, J[knee].y - J[ankle].y)));
    for (let i = 0; i <= n; i++) {
      const y = lerp(y0, yA, i / n);
      const want = legX(y);
      const r = frontRun(y, want, 0.03);
      const def = lerp(0.075 * k, 0.05 * k, i / n);
      // a run wider than one leg means the legs touch here: keep this leg's half
      let w = r ? r[1] - r[0] : def, cx = r ? (r[0] + r[1]) / 2 : want;
      if (r && w > def * 1.6) { w = def; cx = want; }
      w = clamp(w, 0.035, 0.15);
      pts.push({ p: new THREE.Vector3(cx, y, 0), rx: w / 2, rz: (w / 2) * 0.95 });
    }
    parts.push({ ...tube(pts), bones: [[th, V(J[hip]), V(J[knee])], [sh, V(J[knee]), V(J[ankle])]] });
    // foot
    const fx = pts[pts.length - 1].p.x, fr = 0.032 * k;
    parts.push({ ...tube([{ p: new THREE.Vector3(fx, 0.04, -0.015), rx: fr, rz: fr * 0.8 }, { p: new THREE.Vector3(fx, 0.025, 0.05), rx: fr * 1.05, rz: fr * 0.7 }, { p: new THREE.Vector3(fx, 0.022, 0.09), rx: fr * 0.9, rz: fr * 0.6 }].map((q) => ({ ...q, p: q.p.clone() }))), bones: [[sh, V(J[knee]), V(J[ankle])]] });
  }
  // --- arms: shoulder, elbow, wrist and a hand ---
  for (const [s, e, w, ua, fa] of [[11, 13, 15, 'uArmL', 'fArmL'], [12, 14, 16, 'uArmR', 'fArmR']]) {
    const S = V(J[s]), E = V(J[e]), W = V(J[w]);
    const H = W.clone().addScaledVector(W.clone().sub(E).normalize(), 0.07);
    const S0 = S.clone().addScaledVector(S.clone().sub(E).normalize(), 0.025).setY(S.y + 0.005);
    const pts = [
      { p: S0, rx: 0.046 * k, rz: 0.046 * k },
      { p: S.clone().lerp(E, 0.15), rx: 0.042 * k, rz: 0.042 * k },
      { p: S.clone().lerp(E, 0.5), rx: 0.034 * k, rz: 0.036 * k },
      { p: E, rx: 0.03 * k, rz: 0.031 * k },
      { p: E.clone().lerp(W, 0.5), rx: 0.028 * k, rz: 0.028 * k },
      { p: W, rx: 0.022 * k, rz: 0.02 * k },
      { p: W.clone().lerp(H, 0.55), rx: 0.03 * k, rz: 0.016 * k },
      { p: H, rx: 0.022 * k, rz: 0.013 * k },
    ];
    parts.push({ ...tube(pts), bones: [[ua, S, E], [fa, E, W]] });
  }

  // --- merge, with normals and skin weights per part ---
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), indices = new Uint32Array(ni);
  const si = new Uint16Array(nv * 4), swt = new Float32Array(nv * 4);
  let ov = 0, oi = 0;
  const seg = (p, a, b) => { const ab = b.clone().sub(a), t = clamp(p.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1); return p.distanceTo(a.clone().addScaledVector(ab, t)); };
  const P = new THREE.Vector3();
  for (const part of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
    g.setIndex(part.idx);
    g.computeVertexNormals();
    const n = part.pos.length / 3;
    positions.set(part.pos, ov * 3);
    normals.set(g.getAttribute('normal').array, ov * 3);
    for (let i = 0; i < part.idx.length; i++) indices[oi + i] = part.idx[i] + ov;
    for (let i = 0; i < n; i++) {
      P.set(part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]);
      const ds = part.bones.map(([, a, b]) => seg(P, a, b));
      const order = ds.map((d, j) => j).sort((a, b) => ds[a] - ds[b]);
      const j0 = order[0], j1 = order[1] ?? order[0];
      const w0 = 1 / Math.pow(ds[j0] + 0.01, 4), w1 = j1 === j0 ? 0 : 1 / Math.pow(ds[j1] + 0.01, 4);
      const o = (ov + i) * 4;
      si[o] = BONES.indexOf(part.bones[j0][0]); si[o + 1] = BONES.indexOf(part.bones[j1][0]);
      swt[o] = w0 / (w0 + w1); swt[o + 1] = w1 / (w0 + w1);
    }
    g.dispose();
    ov += n; oi += part.idx.length;
  }
  return { mesh: { positions, indices }, normals, skin: { si, sw: swt }, parts, J, skirt, backs: backs.length, hair: hair ? { parts: hair.parts.length, end: +hair.length.toFixed(3), eyeY: +eyeY.toFixed(3) } : null };
}

// Voxelise the fitted body (for the "can this camera see this point" test when painting)
export function occupancy(parts, res) {
  const { nx, ny, nz } = res;
  const c = (BOX.u1 - BOX.u0) / nx;
  const occ = new Uint8Array(nx * ny * nz);
  const tmp = new THREE.Vector3();
  for (const part of parts) {
    const R = part.rings;
    for (let i = 0; i < R.length - 1; i++) {
      const A = R[i], B = R[i + 1];
      const r = Math.max(A.rx, A.rz, B.rx, B.rz);
      const lo = new THREE.Vector3(Math.min(A.c.x, B.c.x) - r, Math.min(A.c.y, B.c.y) - r, Math.min(A.c.z, B.c.z) - r);
      const hi = new THREE.Vector3(Math.max(A.c.x, B.c.x) + r, Math.max(A.c.y, B.c.y) + r, Math.max(A.c.z, B.c.z) + r);
      const ab = B.c.clone().sub(A.c), L2 = Math.max(1e-8, ab.lengthSq());
      const x0 = Math.max(0, Math.floor((lo.x - BOX.u0) / c)), x1 = Math.min(nx - 1, Math.ceil((hi.x - BOX.u0) / c));
      const y0 = Math.max(0, Math.floor(lo.y / c)), y1 = Math.min(ny - 1, Math.ceil(hi.y / c));
      const z0 = Math.max(0, Math.floor((lo.z - BOX.u0) / c)), z1 = Math.min(nz - 1, Math.ceil((hi.z - BOX.u0) / c));
      for (let iz = z0; iz <= z1; iz++) for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
        tmp.set(BOX.u0 + (ix + 0.5) * c, (iy + 0.5) * c, BOX.u0 + (iz + 0.5) * c);
        const t = clamp(tmp.clone().sub(A.c).dot(ab) / L2, 0, 1);
        const cc = A.c.clone().addScaledVector(ab, t);
        const d = tmp.sub(cc);
        const F = t < 0.5 ? A.F : B.F;
        const rx = lerp(A.rx, B.rx, t), rz = lerp(A.rz, B.rz, t);
        const da = d.dot(F.a) / rx, db = d.dot(F.b) / rz;
        if (da * da + db * db <= 1) occ[(iz * ny + iy) * nx + ix] = 1;
      }
    }
  }
  return { occ, c };
}

// Map a close-up face photo onto the front of the head. The eyes in the close-up are
// lined up with the eyes in the front spin shot, so the photo lands where your face is.
// Returns a texture canvas plus a uv and a blend weight for every vertex (0 = no face).
export function faceMap(fit, faceCap, front) {
  const { positions } = fit.mesh, normals = fit.normals, n = positions.length / 3;
  const L = faceCap.lm, F = front.lm;
  if (!L || !F) return null;
  const B = (p) => ({ x: (p.x * front.w - front.x0) / front.s, y: (front.yb - p.y * front.h) / front.s });
  const mL = B(F[2]), mR = B(F[5]);
  const pL = { x: L[2].x * faceCap.w, y: -L[2].y * faceCap.h }, pR = { x: L[5].x * faceCap.w, y: -L[5].y * faceCap.h }; // y up
  const dm = { x: mL.x - mR.x, y: mL.y - mR.y }, dp = { x: pL.x - pR.x, y: pL.y - pR.y };
  const lm = Math.hypot(dm.x, dm.y), lp = Math.hypot(dp.x, dp.y);
  if (lm < 0.01 || lp < 10) return null;
  const S = lp / lm, phi = Math.atan2(dp.y, dp.x) - Math.atan2(dm.y, dm.x);
  const cs = Math.cos(phi) * S, sn = Math.sin(phi) * S;
  const mM = { x: (mL.x + mR.x) / 2, y: (mL.y + mR.y) / 2 }, pM = { x: (pL.x + pR.x) / 2, y: (pL.y + pR.y) / 2 };
  const toPhoto = (x, y) => { const dx = x - mM.x, dy = y - mM.y; return { x: pM.x + cs * dx - sn * dy, y: -(pM.y + sn * dx + cs * dy) }; };
  // crop around the face
  const half = lp * 2.4, cx = pM.x, cy = -pM.y + lp * 0.35;
  const x0 = Math.max(0, Math.round(cx - half)), y0 = Math.max(0, Math.round(cy - half));
  const x1 = Math.min(faceCap.w, Math.round(cx + half)), y1 = Math.min(faceCap.h, Math.round(cy + half));
  if (x1 - x0 < 40 || y1 - y0 < 40) return null;
  const src = document.createElement('canvas');
  src.width = faceCap.w; src.height = faceCap.h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(faceCap.rgba.buffer, faceCap.rgba.byteOffset, faceCap.rgba.length), faceCap.w, faceCap.h), 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const g = canvas.getContext('2d');
  g.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, 512, 512);
  // match the close-up's brightness to the spin shot's face
  const lift = front.gain || 1;
  if (lift > 1.02) {
    const img = g.getImageData(0, 0, 512, 512), d = img.data, lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 1 / lift);
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    g.putImageData(img, 0, 0);
  }
  const uv = new Float32Array(n * 2), w = new Float32Array(n);
  const headIdx = BONES.indexOf('head');
  const eyeSep = lm;
  const fc = { x: mM.x, y: mM.y - eyeSep * 0.35 }; // around the nose
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) {
    if (fit.skin.si[i * 4] !== headIdx || fit.skin.sw[i * 4] < 0.6) continue;
    const nz = normals[i * 3 + 2];
    const x = positions[i * 3], y = positions[i * 3 + 1];
    const d = Math.hypot(x - fc.x, (y - fc.y) * 0.85) / (eyeSep * 2.1);
    // stop at the chin, so the collar in the close-up doesn't land on the neck
    const wt = sstep(0.1, 0.5, nz) * (1 - sstep(0.75, 1.0, d)) * sstep(mM.y - eyeSep * 1.85, mM.y - eyeSep * 1.5, y);
    if (wt <= 0) continue;
    const p = toPhoto(x, y);
    const u = (p.x - x0) / (x1 - x0), v = (p.y - y0) / (y1 - y0);
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    uv[i * 2] = u; uv[i * 2 + 1] = 1 - v;
    w[i] = wt;
  }
  return { canvas, uv, w };
}
