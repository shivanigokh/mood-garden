// Turns a 360° spin of camera captures into a textured 3D body.
//
// 1. Each capture (frame + body mask + landmarks, at a known turn angle) is cropped
//    into a canonical box: one unit is the person's height, x runs -0.5..0.5 across
//    the turn axis and y runs 0 (feet) to 1.04.
// 2. Visual hull: a voxel grid is carved by every silhouette, so what is left is the
//    shape seen from all the angles (concave details like the gap under the nose are
//    beyond what silhouettes can see).
// 3. The occupancy is softened and meshed with surface nets, then smoothed.
// 4. For each vertex and each view, a weight says how squarely and how unblocked that
//    view saw the point; the shader blends the real camera images with those weights.
//
// All of this runs locally in the browser.

export const BOX = { u0: -0.5, u1: 0.5, y1: 1.04 };
export const CELL = { w: 512, h: 532 }; // texture crop size per view
const ATLAS_COLS = 6;

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

// --- 1. per-view preparation ------------------------------------------------------
// caps: [{ theta, w, h, mask: Float32Array, rgba: Uint8ClampedArray, lm }]
export function measure(caps) {
  const out = [];
  for (const c of caps) {
    const { w, h, mask, lm } = c;
    let x0 = null;
    if (lm) {
      const hv = (lm[23]?.visibility ?? 1) > 0.4 && (lm[24]?.visibility ?? 1) > 0.4;
      const a = hv ? lm[23] : lm[11], b = hv ? lm[24] : lm[12];
      x0 = ((a.x + b.x) / 2) * w;
    }
    // silhouette extent: rows with body pixels near the centre column
    let top = -1, bot = -1, sx = 0, sn = 0;
    const band = h * 0.45;
    for (let y = 0; y < h; y++) {
      let any = false;
      const xa = Math.max(0, Math.floor((x0 ?? w / 2) - band)), xb = Math.min(w, Math.ceil((x0 ?? w / 2) + band));
      for (let x = xa; x < xb; x++) if (mask[y * w + x] > 0.5) { any = true; sx += x; sn++; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (x0 == null && sn) x0 = sx / sn;
    out.push({ ...c, x0, top, bot, px: bot - top, cutFeet: bot >= h - 3, cutHead: top <= 1 });
  }
  const hs = out.filter((v) => v.px > 20).map((v) => v.px).sort((a, b) => a - b);
  const sMed = hs.length ? hs[Math.floor(hs.length / 2)] : 1;
  // people drift toward or away from the camera while turning: use each view's own
  // height when the whole body is in frame (smoothed over neighbours), else the median
  const own = out.map((v) => (v.px > 20 && !v.cutFeet && !v.cutHead && Math.abs(v.px / sMed - 1) < 0.25 ? v.px : sMed));
  out.forEach((v, i) => {
    const nb = [-2, -1, 0, 1, 2].map((d) => own[(i + d + out.length) % out.length]).sort((a, b) => a - b);
    v.s = out.length >= 5 ? nb[2] : sMed;
    v.yb = v.bot >= 0 ? v.bot : v.h;
  });
  // the turning axis: the middle of the body between hips and chest, from the mask
  // (hip landmarks wander when you're side-on or facing away)
  for (const v of out) {
    if (v.px <= 20) continue;
    const xs = [];
    for (let y = Math.round(v.yb - 0.72 * v.s); y <= Math.round(v.yb - 0.45 * v.s); y += 2) {
      if (y < 0 || y >= v.h) continue;
      // the run of body pixels nearest the current centre guess
      const cx = Math.round(v.x0 ?? v.w / 2);
      let a = -1, b = -1;
      for (let d = 0; d < v.w / 3 && a < 0; d++) {
        for (const x of [cx - d, cx + d]) if (x >= 0 && x < v.w && v.mask[y * v.w + x] > 0.5) { a = b = x; break; }
      }
      if (a < 0) continue;
      while (a > 0 && v.mask[y * v.w + a - 1] > 0.5) a--;
      while (b < v.w - 1 && v.mask[y * v.w + b + 1] > 0.5) b++;
      xs.push((a + b) / 2);
    }
    if (xs.length > 4) { xs.sort((p, q) => p - q); v.x0 = xs[Math.floor(xs.length / 2)]; }
  }
  // overall exposure: webcam shots indoors come out dark, so lift them a little
  let lum = 0, cnt = 0;
  for (const v of out) {
    if (!v.rgba) continue;
    for (let i = 0; i < v.mask.length; i += 97) if (v.mask[i] > 0.5) { lum += 0.299 * v.rgba[i * 4] + 0.587 * v.rgba[i * 4 + 1] + 0.114 * v.rgba[i * 4 + 2]; cnt++; }
  }
  const mean = cnt ? lum / cnt / 255 : 0.5;
  for (const v of out) v.gain = Math.max(1, Math.min(1.6, 0.48 / Math.max(mean, 0.05)));
  return out;
}

// Fix each shot's turn angle by silhouette consistency: the right angle for a shot is
// the one where carving with it removes nothing that the other shots can see.
// Works on a coarse grid; call after measure() and before prepare().
export async function alignViews(views, progress = () => {}) {
  const V = views.length;
  if (V < 6) return;
  const NU = 48, NV = 50, G = 40, GY = 42;
  const c = (BOX.u1 - BOX.u0) / G, cy = BOX.y1 / GY;
  // coarse masks on the (u, y) lattice
  const M = views.map((v) => {
    const m = new Uint8Array(NU * NV);
    for (let j = 0; j < NV; j++) {
      const y = ((j + 0.5) / NV) * BOX.y1, iy = Math.round(v.yb - y * v.s);
      for (let i = 0; i < NU; i++) {
        const u = BOX.u0 + ((i + 0.5) / NU) * (BOX.u1 - BOX.u0), ix = Math.round(v.x0 + u * v.s);
        if (ix < 0 || iy < 0 || ix >= v.w || iy >= v.h) { m[j * NU + i] = v.cutFeet && iy >= v.h ? 1 : 0; continue; }
        // a little generous: any body pixel in a 3x3 patch
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = ix + dx * 2, yy = iy + dy * 2;
          if (xx >= 0 && yy >= 0 && xx < v.w && yy < v.h && v.mask[yy * v.w + xx] > 0.5) { hit = 1; break; }
        }
        m[j * NU + i] = hit;
      }
    }
    return m;
  });
  const NVOX = G * GY * G;
  const vx = new Float32Array(NVOX), vz = new Float32Array(NVOX), vj = new Int16Array(NVOX);
  for (let iz = 0, q = 0; iz < G; iz++) for (let iy = 0; iy < GY; iy++) for (let ix = 0; ix < G; ix++, q++) {
    vx[q] = BOX.u0 + (ix + 0.5) * c; vz[q] = BOX.u0 + (iz + 0.5) * c;
    vj[q] = Math.min(NV - 1, Math.floor((((iy + 0.5) * cy) / BOX.y1) * NV));
  }
  const col = (q, th) => {
    const u = vx[q] * Math.cos(th) + vz[q] * Math.sin(th);
    return Math.floor(((u - BOX.u0) / (BOX.u1 - BOX.u0)) * NU);
  };
  const outside = (k, th, out) => {
    const cs = Math.cos(th), sn = Math.sin(th), m = M[k];
    for (let q = 0; q < NVOX; q++) {
      const ui = Math.floor(((vx[q] * cs + vz[q] * sn - BOX.u0) / (BOX.u1 - BOX.u0)) * NU);
      out[q] = ui < 0 || ui >= NU || !m[vj[q] * NU + ui] ? 1 : 0;
    }
  };
  const allow = 2;
  const outs = views.map((v, k) => { const o = new Uint8Array(NVOX); outside(k, v.theta, o); return o; });
  const miss = new Uint8Array(NVOX);
  for (let k = 0; k < V; k++) for (let q = 0; q < NVOX; q++) miss[q] += outs[k][q];
  const cand = new Uint8Array(NVOX), hit = new Uint8Array(NU * NV);
  // pixels of view j's mask that the kept voxels no longer cover
  const lost = (j, keep) => {
    hit.fill(0);
    const th = views[j].theta, cs = Math.cos(th), sn = Math.sin(th);
    for (let q = 0; q < NVOX; q++) {
      if (!keep(q)) continue;
      const ui = Math.floor(((vx[q] * cs + vz[q] * sn - BOX.u0) / (BOX.u1 - BOX.u0)) * NU);
      if (ui >= 0 && ui < NU) hit[vj[q] * NU + ui] = 1;
    }
    let n = 0;
    const m = M[j];
    for (let i = 0; i < hit.length; i++) if (m[i] && !hit[i]) n++;
    return n;
  };
  const STEP = (4 * Math.PI) / 180, RANGE = 7;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < V; k++) {
      const v = views[k];
      const others = [1, 3, 6, 9, 12, 15, 18, 21, V - 1].map((d) => (k + d) % V).filter((j, i, a) => j !== k && a.indexOf(j) === i);
      let best = v.theta, bestScore = Infinity;
      for (let r = -RANGE; r <= RANGE; r++) {
        const th = v.theta + r * STEP * (pass ? 0.5 : 1);
        outside(k, th, cand);
        const keep = (q) => miss[q] - outs[k][q] + cand[q] <= allow;
        let sc = 0;
        for (const j of others) sc += lost(j, keep);
        sc += Math.abs(r) * 0.5; // prefer small moves when it's a tie
        if (sc < bestScore) { bestScore = sc; best = th; }
      }
      if (best !== v.theta) {
        outside(k, best, cand);
        for (let q = 0; q < NVOX; q++) miss[q] += cand[q] - outs[k][q];
        outs[k].set(cand);
        v.theta = best;
      }
      progress((pass * V + k + 1) / (2 * V));
      if (k % 2 === 1) await yieldFrame();
    }
  }
  for (const v of views) { v.cos = Math.cos(v.theta); v.sin = Math.sin(v.theta); }
}

// crop mask to the voxel lattice, and the image to a texture cell
export function prepare(views, res) {
  const NU = res.nu, NV = res.nv;
  const atlas = document.createElement('canvas');
  const rows = Math.ceil(views.length / ATLAS_COLS);
  atlas.width = CELL.w * ATLAS_COLS;
  atlas.height = CELL.h * rows;
  const actx = atlas.getContext('2d');
  views.forEach((v, i) => {
    v.col = i % ATLAS_COLS;
    v.row = Math.floor(i / ATLAS_COLS);
    v.cos = Math.cos(v.theta);
    v.sin = Math.sin(v.theta);
    // mask on the voxel lattice (row 0 = feet), dilated by one cell to forgive small errors
    const m = new Uint8Array(NU * NV);
    for (let j = 0; j < NV; j++) {
      const y = ((j + 0.5) / NV) * BOX.y1;
      const iy = Math.round(v.yb - y * v.s);
      for (let i = 0; i < NU; i++) {
        const u = BOX.u0 + ((i + 0.5) / NU) * (BOX.u1 - BOX.u0);
        const ix = Math.round(v.x0 + u * v.s);
        if (ix < 0 || iy < 0 || ix >= v.w || iy >= v.h) { m[j * NU + i] = v.cutFeet && iy >= v.h ? 1 : 0; continue; }
        m[j * NU + i] = v.mask[iy * v.w + ix] > 0.5 ? 1 : 0;
      }
    }
    v.maskCrop = dilate(m, NU, NV);
    v.maskTight = erode(m, NU, NV);
    // texture cell, with body colours pushed out past the edge so nothing pale bleeds in
    const cw = CELL.w, ch = CELL.h;
    const img = new ImageData(cw, ch);
    const d = img.data;
    const fg = new Uint8Array(cw * ch);
    // brighten dark webcam shots with a gentle gamma lift (keeps highlights)
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, 1 / (v.gain || 1));
    for (let y = 0; y < ch; y++) {
      const yy = (1 - (y + 0.5) / ch) * BOX.y1;
      const sy = v.yb - yy * v.s;
      for (let x = 0; x < cw; x++) {
        const u = BOX.u0 + ((x + 0.5) / cw) * (BOX.u1 - BOX.u0);
        const sx = v.x0 + u * v.s;
        const o = (y * cw + x) * 4;
        if (sx < 0 || sy < 0 || sx >= v.w - 1 || sy >= v.h - 1) { d[o + 3] = 255; continue; }
        // bilinear sample
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * v.w + x0) * 4, i10 = i00 + 4, i01 = i00 + v.w * 4, i11 = i01 + 4;
        for (let k = 0; k < 3; k++) {
          d[o + k] = lut[Math.round((v.rgba[i00 + k] * (1 - fx) + v.rgba[i10 + k] * fx) * (1 - fy) + (v.rgba[i01 + k] * (1 - fx) + v.rgba[i11 + k] * fx) * fy)];
        }
        d[o + 3] = 255;
        fg[y * cw + x] = v.mask[y0 * v.w + x0] > 0.5 ? 1 : 0;
      }
    }
    bleed(d, fg, cw, ch, 6);
    actx.putImageData(img, v.col * CELL.w, v.row * CELL.h);
  });
  return { atlas, cols: ATLAS_COLS, rows };
}

function dilate(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) { v = 1; break; }
    }
    o[y * w + x] = v;
  }
  return o;
}
function erode(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] ? 1 : 0;
  }
  return o;
}
// grow foreground colours outward a few pixels
function bleed(d, fg, w, h, passes) {
  const known = fg.slice();
  for (let p = 0; p < passes; p++) {
    const next = known.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const j of [i - 1, i + 1, i - w, i + w]) if (known[j]) { r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; n++; }
      if (n) { d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n; next[i] = 1; }
    }
    known.set(next);
  }
}

// --- 2. visual hull -----------------------------------------------------------------
export async function carve(views, res, progress = () => {}) {
  const { nx, ny, nz, nu, nv } = res;
  const c = (BOX.u1 - BOX.u0) / nx; // cubic cells
  const miss = new Uint8Array(nx * ny * nz);
  const allow = views.length >= 16 ? 2 : 1; // forgive a couple of shaky frames
  for (let k = 0; k < views.length; k++) {
    const v = views[k];
    const m = v.maskCrop;
    for (let iz = 0; iz < nz; iz++) {
      const z = BOX.u0 + (iz + 0.5) * c;
      for (let ix = 0; ix < nx; ix++) {
        const x = BOX.u0 + (ix + 0.5) * c;
        const u = x * v.cos + z * v.sin;
        const ui = Math.floor(((u - BOX.u0) / (BOX.u1 - BOX.u0)) * nu);
        const base = (iz * ny) * nx + ix; // index = (iz*ny + iy)*nx + ix
        if (ui < 0 || ui >= nu) { for (let iy = 0; iy < ny; iy++) miss[base + iy * nx] = 255; continue; }
        for (let iy = 0; iy < ny; iy++) {
          const vi = Math.min(nv - 1, Math.floor(((iy + 0.5) / ny) * nv));
          if (!m[vi * nu + ui]) { const idx = base + iy * nx; if (miss[idx] < 255) miss[idx]++; }
        }
      }
    }
    progress((k + 1) / views.length);
    if (k % 3 === 2) await yieldFrame();
  }
  const occ = new Uint8Array(miss.length);
  for (let i = 0; i < miss.length; i++) occ[i] = miss[i] <= allow ? 1 : 0;
  keepLargest(occ, nx, ny, nz);
  return { occ, c };
}

// drop floating specks: keep the biggest connected blob
function keepLargest(occ, nx, ny, nz) {
  const label = new Int32Array(occ.length);
  let best = 0, bestSize = 0, cur = 0;
  const stack = new Int32Array(occ.length);
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i] || label[i]) continue;
    cur++;
    let sp = 0, size = 0;
    stack[sp++] = i;
    label[i] = cur;
    while (sp) {
      const j = stack[--sp];
      size++;
      const ix = j % nx, iy = Math.floor(j / nx) % ny, iz = Math.floor(j / (nx * ny));
      const nb = [ix > 0 ? j - 1 : -1, ix < nx - 1 ? j + 1 : -1, iy > 0 ? j - nx : -1, iy < ny - 1 ? j + nx : -1, iz > 0 ? j - nx * ny : -1, iz < nz - 1 ? j + nx * ny : -1];
      for (const q of nb) if (q >= 0 && occ[q] && !label[q]) { label[q] = cur; stack[sp++] = q; }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  // keep big pieces too (a head or arm that a thin neck/elbow failed to join), drop specks
  const sizes = new Int32Array(cur + 1);
  for (let i = 0; i < occ.length; i++) if (occ[i]) sizes[label[i]]++;
  const minKeep = Math.max(200, bestSize * 0.01);
  for (let i = 0; i < occ.length; i++) if (occ[i] && label[i] !== best && sizes[label[i]] < minKeep) occ[i] = 0;
}

// --- 3. mesh -------------------------------------------------------------------------
export function blurField(occ, nx, ny, nz, passes = 2) {
  let f = new Float32Array(occ.length);
  for (let i = 0; i < occ.length; i++) f[i] = occ[i];
  let t = new Float32Array(occ.length);
  const strides = [1, nx, nx * ny], dims = [nx, ny, nz];
  for (let p = 0; p < passes; p++) {
    for (let a = 0; a < 3; a++) {
      const st = strides[a], n = dims[a];
      for (let i = 0; i < f.length; i++) {
        const coord = a === 0 ? i % nx : a === 1 ? Math.floor(i / nx) % ny : Math.floor(i / (nx * ny));
        const l = coord > 0 ? f[i - st] : 0, r = coord < n - 1 ? f[i + st] : 0;
        t[i] = (l + f[i] * 2 + r) / 4;
      }
      [f, t] = [t, f];
    }
  }
  return f;
}

export function surfaceNets(f, nx, ny, nz, c, iso = 0.5) {
  const idx = (x, y, z) => (z * ny + y) * nx + x;
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const pos = [];
  const cidx = (x, y, z) => (z * (ny - 1) + y) * (nx - 1) + x;
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let mask = 0;
    for (let k = 0; k < 8; k++) {
      const [dx, dy, dz] = corners[k];
      val[k] = f[idx(x + dx, y + dy, z + dz)];
      if (val[k] > iso) mask |= 1 << k;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      const ia = val[a] > iso, ib = val[b] > iso;
      if (ia === ib) continue;
      const t = (iso - val[a]) / (val[b] - val[a]);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      n++;
    }
    cellVert[cidx(x, y, z)] = pos.length / 3;
    pos.push(BOX.u0 + (x + 0.5 + sx / n) * c, (y + 0.5 + sy / n) * c, BOX.u0 + (z + 0.5 + sz / n) * c);
  }
  const tris = [];
  const quad = (a, b, cc, d, flip) => {
    if (a < 0 || b < 0 || cc < 0 || d < 0) return;
    if (flip) tris.push(a, cc, b, a, d, cc); else tris.push(a, b, cc, a, cc, d);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const inside = f[idx(x, y, z)] > iso;
    // edge along +x
    if (x < nx - 1 && inside !== (f[idx(x + 1, y, z)] > iso)) {
      quad(cellVert[cidx(x, y - 1, z - 1)], cellVert[cidx(x, y, z - 1)], cellVert[cidx(x, y, z)], cellVert[cidx(x, y - 1, z)], !inside);
    }
    if (y < ny - 1 && inside !== (f[idx(x, y + 1, z)] > iso)) {
      quad(cellVert[cidx(x - 1, y, z - 1)], cellVert[cidx(x - 1, y, z)], cellVert[cidx(x, y, z)], cellVert[cidx(x, y, z - 1)], !inside);
    }
    if (z < nz - 1 && inside !== (f[idx(x, y, z + 1)] > iso)) {
      quad(cellVert[cidx(x - 1, y - 1, z)], cellVert[cidx(x, y - 1, z)], cellVert[cidx(x, y, z)], cellVert[cidx(x - 1, y, z)], !inside);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tris) };
}

// make every triangle face outward: compare with the field gradient
export function orient(mesh, f, nx, ny, nz, c) {
  const P = mesh.positions, I = mesh.indices;
  const at = (x, y, z) => {
    const ix = Math.max(0, Math.min(nx - 1, Math.round((x - BOX.u0) / c - 0.5)));
    const iy = Math.max(0, Math.min(ny - 1, Math.round(y / c - 0.5)));
    const iz = Math.max(0, Math.min(nz - 1, Math.round((z - BOX.u0) / c - 0.5)));
    return f[(iz * ny + iy) * nx + ix];
  };
  let flips = 0, total = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    const cx = (P[a] + P[b] + P[d]) / 3, cy = (P[a + 1] + P[b + 1] + P[d + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[d + 2]) / 3;
    const l = Math.hypot(nxv, nyv, nzv) || 1;
    const e = c * 1.5;
    const outside = at(cx + (nxv / l) * e, cy + (nyv / l) * e, cz + (nzv / l) * e);
    const inside = at(cx - (nxv / l) * e, cy - (nyv / l) * e, cz - (nzv / l) * e);
    total++;
    if (outside > inside) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; flips++; }
  }
  return flips / Math.max(1, total);
}

export function smooth(mesh, iters = 4) {
  const P = mesh.positions, I = mesh.indices, n = P.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const adj = nb.map((s) => Array.from(s));
  const tmp = new Float32Array(P.length);
  const step = (lam) => {
    for (let i = 0; i < n; i++) {
      const a = adj[i];
      if (!a.length) { tmp[i * 3] = P[i * 3]; tmp[i * 3 + 1] = P[i * 3 + 1]; tmp[i * 3 + 2] = P[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (const j of a) { x += P[j * 3]; y += P[j * 3 + 1]; z += P[j * 3 + 2]; }
      x /= a.length; y /= a.length; z /= a.length;
      tmp[i * 3] = P[i * 3] + (x - P[i * 3]) * lam;
      tmp[i * 3 + 1] = P[i * 3 + 1] + (y - P[i * 3 + 1]) * lam;
      tmp[i * 3 + 2] = P[i * 3 + 2] + (z - P[i * 3 + 2]) * lam;
    }
    P.set(tmp);
  };
  for (let k = 0; k < iters; k++) { step(0.55); step(-0.58); } // Taubin: smooth without shrinking
}

// --- 4. which views see each vertex ------------------------------------------------
export function viewWeights(mesh, normals, views, occ, res, c) {
  const { nx, ny, nz, nu, nv } = res;
  const P = mesh.positions, n = P.length / 3, V = views.length;
  const W = new Float32Array(n * 24);
  const inside = (x, y, z) => {
    const ix = Math.floor((x - BOX.u0) / c), iy = Math.floor(y / c), iz = Math.floor((z - BOX.u0) / c);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
    return occ[(iz * ny + iy) * nx + ix] === 1;
  };
  const tmp = new Float32Array(V);
  for (let i = 0; i < n; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const nxv = normals[i * 3], nyv = normals[i * 3 + 1], nzv = normals[i * 3 + 2];
    let any = false, bestF = -2, bestK = 0;
    for (let k = 0; k < V; k++) {
      const v = views[k];
      // direction from the body toward the camera for this view
      const dx = -v.sin, dz = v.cos;
      const facing = nxv * dx + nzv * dz;
      if (facing > bestF) { bestF = facing; bestK = k; }
      tmp[k] = 0;
      if (facing < 0.12) continue;
      // the point must project inside the (slightly shrunk) silhouette
      const u = px * v.cos + pz * v.sin;
      const ui = Math.floor(((u - BOX.u0) / (BOX.u1 - BOX.u0)) * nu), vi = Math.floor((py / BOX.y1) * nv);
      if (ui < 0 || vi < 0 || ui >= nu || vi >= nv || !v.maskTight[vi * nu + ui]) continue;
      // and nothing else of the body may stand between it and the camera
      let blocked = false;
      for (let s = 3; s < 90; s += 1.5) {
        const x = px + nxv * c * 1.5 + dx * c * s, z = pz + nzv * c * 1.5 + dz * c * s, y = py + nyv * c * 1.5;
        if (inside(x, y, z)) { blocked = true; break; }
        if (Math.abs(x) > 0.5 || Math.abs(z) > 0.5) break;
      }
      if (blocked) continue;
      tmp[k] = Math.pow(facing, 14);
      any = true;
    }
    if (!any) tmp[bestK] = 1; // seen by nobody (top of the head, under the arms): nearest guess
    // keep the three strongest views so the texture stays crisp
    const order = Array.from(tmp.keys()).sort((a, b) => tmp[b] - tmp[a]).slice(0, 2);
    let sum = 0;
    for (const k of order) sum += tmp[k];
    for (const k of order) if (tmp[k] > 0) W[i * 24 + k] = tmp[k] / sum;
  }
  return W;
}

// bake colours per vertex (for export and as a fallback)
export function bakeColors(mesh, W, views, atlas) {
  const ctx = atlas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, atlas.width, atlas.height).data;
  const P = mesh.positions, n = P.length / 3;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < views.length; k++) {
      const w = W[i * 24 + k];
      if (!w) continue;
      const v = views[k];
      const u = P[i * 3] * v.cos + P[i * 3 + 2] * v.sin;
      const cx = Math.min(CELL.w - 1, Math.max(0, Math.floor(((u - BOX.u0) / (BOX.u1 - BOX.u0)) * CELL.w)));
      const cy = Math.min(CELL.h - 1, Math.max(0, Math.floor((1 - P[i * 3 + 1] / BOX.y1) * CELL.h)));
      const o = ((v.row * CELL.h + cy) * atlas.width + v.col * CELL.w + cx) * 4;
      r += data[o] * w; g += data[o + 1] * w; b += data[o + 2] * w;
    }
    col[i * 3] = r / 255; col[i * 3 + 1] = g / 255; col[i * 3 + 2] = b / 255;
  }
  return col;
}

// --- rig: bones from the front view's landmarks -------------------------------------
export const BONES = ['hips', 'spine', 'head', 'uArmL', 'fArmL', 'uArmR', 'fArmR', 'thighL', 'shinL', 'thighR', 'shinR'];
export const PARENT = { hips: null, spine: 'hips', head: 'spine', uArmL: 'spine', fArmL: 'uArmL', uArmR: 'spine', fArmR: 'uArmR', thighL: 'hips', shinL: 'thighL', thighR: 'hips', shinR: 'thighR' };
// landmark pairs that give each bone's direction (live and at rest)
export const DIRS = { spine: ['hipMid', 'shMid'], head: ['shMid', 'eyeMid'], uArmL: [11, 13], fArmL: [13, 15], uArmR: [12, 14], fArmR: [14, 16], thighL: [23, 25], shinL: [25, 27], thighR: [24, 26], shinR: [26, 28] };

export function landmarkPoint(lm, key) {
  const m = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2, z: ((lm[a].z || 0) + (lm[b].z || 0)) / 2, visibility: Math.min(lm[a].visibility ?? 1, lm[b].visibility ?? 1) });
  if (key === 'hipMid') return m(23, 24);
  if (key === 'shMid') return m(11, 12);
  if (key === 'eyeMid') return m(2, 5);
  return lm[key];
}

export function restJoints(front) {
  const { lm, w, h, x0, yb, s } = front;
  const B = (p) => ({ x: (p.x * w - x0) / s, y: (yb - p.y * h) / s, z: 0 });
  const L = (k) => B(landmarkPoint(lm, k));
  const J = {
    hipMid: L('hipMid'), shMid: L('shMid'), eyeMid: L('eyeMid'),
    11: L(11), 12: L(12), 13: L(13), 14: L(14), 15: L(15), 16: L(16),
    23: L(23), 24: L(24), 25: L(25), 26: L(26), 27: L(27), 28: L(28),
  };
  return J;
}

// where each bone sits, and the segment that its vertices hug
export function boneLayout(J) {
  const ext = (a, b, f) => ({ x: b.x + (b.x - a.x) * f, y: b.y + (b.y - a.y) * f, z: 0 });
  const headTop = { x: J.eyeMid.x, y: 1.0, z: 0 };
  const foot = (k, a) => ({ x: a.x, y: 0, z: 0.02 });
  return {
    hips: { at: J.hipMid, seg: [J[23], J[24]] },
    spine: { at: J.hipMid, seg: [J.hipMid, J.shMid] },
    head: { at: J.shMid, seg: [{ x: J.shMid.x, y: J.shMid.y + 0.02, z: 0 }, headTop] },
    uArmL: { at: J[11], seg: [J[11], J[13]] },
    fArmL: { at: J[13], seg: [J[13], ext(J[13], J[15], 0.45)] },
    uArmR: { at: J[12], seg: [J[12], J[14]] },
    fArmR: { at: J[14], seg: [J[14], ext(J[14], J[16], 0.45)] },
    thighL: { at: J[23], seg: [J[23], J[25]] },
    shinL: { at: J[25], seg: [J[25], foot(27, J[27])] },
    thighR: { at: J[24], seg: [J[24], J[26]] },
    shinR: { at: J[26], seg: [J[26], foot(28, J[28])] },
  };
}

function segDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p[0] - a.x, apy = p[1] - a.y, apz = p[2] - a.z;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / (abx * abx + aby * aby + abz * abz || 1)));
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}

export function skinWeights(mesh, layout) {
  const P = mesh.positions, n = P.length / 3;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const segs = BONES.map((b) => layout[b].seg);
  const d = new Float32Array(BONES.length);
  for (let i = 0; i < n; i++) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    for (let k = 0; k < BONES.length; k++) d[k] = segDist(p, segs[k][0], segs[k][1]);
    const order = Array.from(d.keys()).sort((a, b) => d[a] - d[b]).slice(0, 2);
    const w0 = 1 / Math.pow(d[order[0]] + 0.004, 4), w1 = 1 / Math.pow(d[order[1]] + 0.004, 4);
    si[i * 4] = order[0]; si[i * 4 + 1] = order[1];
    sw[i * 4] = w0 / (w0 + w1); sw[i * 4 + 1] = w1 / (w0 + w1);
  }
  return { si, sw };
}

// --- export: a minimal binary glTF with vertex colours --------------------------------
export function toGLB(positions, normals, colors, indices, scale = 1.7) {
  const n = positions.length / 3;
  const pos = new Float32Array(positions.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const v = positions[i * 3 + k] * scale;
    pos[i * 3 + k] = v;
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { col[i * 4] = srgbToLinear(colors[i * 3]); col[i * 4 + 1] = srgbToLinear(colors[i * 3 + 1]); col[i * 4 + 2] = srgbToLinear(colors[i * 3 + 2]); col[i * 4 + 3] = 1; }
  const parts = [pos, new Float32Array(normals), col, new Uint32Array(indices)];
  const offsets = [];
  let len = 0;
  for (const p of parts) { offsets.push(len); len += Math.ceil(p.byteLength / 4) * 4; }
  const bin = new Uint8Array(len);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]));
  const json = {
    asset: { version: '2.0', generator: 'Mood Garden avatar scan' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'avatar' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, name: 'scan' }],
    buffers: [{ byteLength: len }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength, target: i === 3 ? 34963 : 34962 })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: n, type: 'VEC4' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = Math.ceil(js.length / 4) * 4;
  const jsonChunk = new Uint8Array(jpad).fill(0x20);
  jsonChunk.set(js);
  const total = 12 + 8 + jpad + 8 + len;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jpad, true); dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jpad).set(jsonChunk);
  dv.setUint32(20 + jpad, len, true); dv.setUint32(24 + jpad, 0x004e4942, true);
  new Uint8Array(out, 28 + jpad, len).set(bin);
  return new Blob([out], { type: 'model/gltf-binary' });
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
