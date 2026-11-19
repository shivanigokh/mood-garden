// Full-body tracking with MediaPipe Pose. Used by the Party and Avatar pages.
// Frames go from the <video> element straight into the local model and are never
// stored or sent anywhere.
//
// Landmarks are in the camera image's normalised space (x 0..1 left to right of the
// unmirrored image). Pages mirror them with toScreen() from shared.js.
// Index cheat sheet: 0 nose, 2/5 eyes, 7/8 ears, 11/12 shoulders, 13/14 elbows,
// 15/16 wrists, 17-22 hand points, 23/24 hips, 25/26 knees, 27/28 ankles, 31/32 toes.
// Odd indices are the person's LEFT side, which shows on the screen's left in a mirror.

const WASM_PATH = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const POSE_MODEL = new URL('../models/pose_landmarker_lite.task', import.meta.url).href;

// One-euro filter: smooth when still, responsive when moving fast.
class OneEuro {
  constructor(minCut = 1.6, beta = 6, dCut = 1.2) { this.minCut = minCut; this.beta = beta; this.dCut = dCut; this.x = null; this.dx = 0; }
  alpha(cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); }
  step(v, dt) {
    if (this.x === null) { this.x = v; return v; }
    const d = (v - this.x) / dt;
    this.dx += (d - this.dx) * this.alpha(this.dCut, dt);
    const cut = this.minCut + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * this.alpha(cut, dt);
    return this.x;
  }
}

class SmoothPose {
  constructor() {
    this.f = Array.from({ length: 33 }, () => [new OneEuro(), new OneEuro(), new OneEuro(1, 2)]);
    this.lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, v: 0 }));
    this.raw = null;
    this.seen = 0;
    this.born = 0;
  }
  push(raw, now) {
    const dt = this.seen ? Math.max((now - this.seen) / 1000, 1 / 120) : 1 / 30;
    for (let i = 0; i < 33; i++) {
      const p = raw[i], o = this.lm[i], f = this.f[i];
      o.x = f[0].step(p.x, dt);
      o.y = f[1].step(p.y, dt);
      o.z = f[2].step(p.z, dt);
      const vis = p.visibility ?? 1;
      o.v += (vis - o.v) * 0.5;
    }
    this.raw = raw;
    this.seen = now;
  }
  get center() { const l = this.lm; return { x: (l[11].x + l[12].x) / 2, y: (l[11].y + l[12].y) / 2 }; }
}

export class PoseTracker {
  constructor(video, opts = {}) {
    this.video = video;
    this.numPoses = opts.numPoses || 1;
    this.masks = !!opts.masks; // body segmentation, used by the 3D scan
    this._captures = new Map();
    this._capId = 0;
    this.stream = null;
    this.running = false;
    this.ready = false;
    this.lastVideoTime = -1;
    this.aspect = 16 / 9;
    this.people = []; // SmoothPose, sorted left-to-right on screen
    this.fake = null; // test hook: arrays of 33 landmarks
  }

  async load() {
    if (this.ready) return;
    if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && !/[?&]noworker/.test(location.search)) {
      try { await this._loadWorker(); this.mode = 'worker'; this.ready = true; return; } catch (e) {
        console.warn('Pose worker unavailable, running on the main thread instead.', e);
        this.worker?.terminate(); this.worker = null;
      }
    }
    const { PoseLandmarker, FilesetResolver } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: this.numPoses, outputSegmentationMasks: this.masks, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { this.pose = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch (e) { this.pose = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
    this.mode = 'main';
    this.ready = true;
  }

  _loadWorker() {
    return new Promise((resolve, reject) => {
      const w = (this.worker = new Worker(new URL('./pose-worker.js?v=9', import.meta.url)));
      const timer = setTimeout(() => reject(new Error('pose worker init timed out')), 45000);
      w.onerror = (e) => { clearTimeout(timer); reject(e.error || new Error(e.message || 'worker error')); };
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') { clearTimeout(timer); resolve(); }
        else if (d.type === 'error') { clearTimeout(timer); reject(new Error(d.message)); }
        else if (d.type === 'result') {
          this._pending = d.landmarks || [];
          this._busy = false;
          if (d.capture) { const cb = this._captures.get(d.capture.id); this._captures.delete(d.capture.id); cb?.(d.capture); }
        }
      };
      w.postMessage({ type: 'init', wasm: WASM_PATH, model: POSE_MODEL, numPoses: this.numPoses, masks: this.masks });
    });
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('This browser does not support camera access.'), { code: 'unsupported' });
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((res) => { if (this.video.readyState >= 2) return res(); this.video.addEventListener('loadeddata', res, { once: true }); });
    this.aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    this.running = true;
  }

  stopCamera() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  // Call every animation frame. Returns true when new landmarks arrived.
  update(now) {
    let res = null;
    if (this.fake) res = this.fake;
    else if (this.running && this.ready && this.video.readyState >= 2) {
      const vt = this.video.currentTime;
      if (this.mode === 'worker') {
        if (!this._busy && vt !== this.lastVideoTime) {
          this.lastVideoTime = vt;
          this._busy = true;
          this._busySince = now;
          const vw = this.video.videoWidth, vh = this.video.videoHeight;
          const cap = this._wantCapture;
          this._wantCapture = null;
          if (cap) {
            // full resolution for a scan capture so the texture stays sharp
            createImageBitmap(this.video)
              .then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: performance.now(), capture: cap }, [bitmap]))
              .catch(() => { this._busy = false; const cb = this._captures.get(cap); this._captures.delete(cap); cb?.(null); });
            return this._finishUpdate(now);
          }
          const scale = Math.min(1, 640 / Math.max(vw, 1));
          const o = scale < 1 ? { resizeWidth: Math.round(vw * scale), resizeHeight: Math.round(vh * scale), resizeQuality: 'medium' } : undefined;
          (o ? createImageBitmap(this.video, o).catch(() => createImageBitmap(this.video)) : createImageBitmap(this.video))
            .then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]))
            .catch(() => { this._busy = false; });
        } else if (this._busy && now - this._busySince > 2000) this._busy = false;
        if (this._pending) { res = this._pending; this._pending = null; }
      } else if (vt !== this.lastVideoTime) {
        this.lastVideoTime = vt;
        try {
          const r = this.pose.detectForVideo(this.video, now);
          res = r.landmarks;
          if (this._wantCapture) {
            const id = this._wantCapture;
            this._wantCapture = null;
            const w = this.video.videoWidth, h = this.video.videoHeight;
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const c2 = cv.getContext('2d');
            c2.drawImage(this.video, 0, 0);
            const m = r.segmentationMasks?.[0];
            const cap = { id, w, h, mask: m ? new Float32Array(m.getAsFloat32Array()) : null, rgba: c2.getImageData(0, 0, w, h).data, world: r.worldLandmarks?.[0] || null, lm: r.landmarks?.[0] || null };
            const cb = this._captures.get(id); this._captures.delete(id); cb?.(cap);
          }
          r.segmentationMasks?.forEach((mm) => mm.close());
        } catch (e) { /* skip */ }
      }
    }
    return this._finishUpdate(now, res);
  }

  _finishUpdate(now, res = null) {
    if (!res) {
      // forget people we have not seen for a moment
      this.people = this.people.filter((p) => now - p.seen < 600);
      return false;
    }
    this._match(res, now);
    return true;
  }

  // Ask for the next camera frame at full resolution with its body mask.
  // Resolves to { w, h, mask, rgba, world, lm } or null.
  capture() {
    const id = ++this._capId;
    return new Promise((resolve) => {
      this._captures.set(id, resolve);
      this._wantCapture = id;
      setTimeout(() => { if (this._captures.has(id)) { this._captures.delete(id); if (this._wantCapture === id) this._wantCapture = null; resolve(null); } }, 3000);
    });
  }

  // keep identities stable between frames by matching shoulder centres
  _match(list, now) {
    const next = [];
    const pool = this.people.slice();
    for (const raw of list) {
      const c = { x: (raw[11].x + raw[12].x) / 2, y: (raw[11].y + raw[12].y) / 2 };
      let best = -1, bd = 0.25;
      pool.forEach((p, i) => { const pc = p.center; const d = Math.hypot(pc.x - c.x, pc.y - c.y); if (d < bd) { bd = d; best = i; } });
      const sp = best >= 0 ? pool.splice(best, 1)[0] : Object.assign(new SmoothPose(), { born: now });
      sp.push(raw, now);
      next.push(sp);
    }
    // keep briefly-lost people so a dropped frame does not reset them
    for (const p of pool) if (now - p.seen < 400) next.push(p);
    // sort by screen position: the mirror flips x, so larger image x is further left on screen
    next.sort((a, b) => b.center.x - a.center.x);
    this.people = next;
  }
}

// Build a plausible standing pose for tests and demos. cx, cy: shoulder centre in
// image space; s: shoulder width. arms: {l:[angle,bend], r:[angle,bend]} in degrees,
// angle 0 = straight down, 90 = straight out to the side, 180 = straight up.
export function makePose(cx = 0.5, cy = 0.42, s = 0.16, arms = {}, extra = {}) {
  const P = Array.from({ length: 33 }, () => ({ x: cx, y: cy, z: 0, visibility: 0.95 }));
  const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 0.95 }; };
  const head = cy - s * 0.95 + (extra.duck || 0);
  const hx = cx + (extra.lean || 0);
  set(0, hx, head);
  set(2, hx + s * 0.12, head - s * 0.08); set(5, hx - s * 0.12, head - s * 0.08);
  set(1, hx + s * 0.07, head - s * 0.08); set(3, hx + s * 0.17, head - s * 0.08);
  set(4, hx - s * 0.07, head - s * 0.08); set(6, hx - s * 0.17, head - s * 0.08);
  set(7, hx + s * 0.28, head - s * 0.02); set(8, hx - s * 0.28, head - s * 0.02);
  set(9, hx + s * 0.07, head + s * 0.15); set(10, hx - s * 0.07, head + s * 0.15);
  const sy = cy + (extra.duck || 0) * 0.7;
  // person's left (odd) is at larger image x
  set(11, cx + s / 2 + (extra.lean || 0) * 0.6, sy); set(12, cx - s / 2 + (extra.lean || 0) * 0.6, sy);
  const arm = (side, si, ei, wi, a, bend) => {
    const sh = P[si];
    const dir = side === 'l' ? 1 : -1;
    const rad = (a * Math.PI) / 180;
    const ux = Math.sin(rad) * dir, uy = Math.cos(rad);
    const e = { x: sh.x + ux * s * 0.85, y: sh.y + uy * s * 0.85 };
    const r2 = rad + ((bend || 0) * Math.PI) / 180 * dir * dir;
    const w = { x: e.x + Math.sin(r2) * dir * s * 0.8, y: e.y + Math.cos(r2) * s * 0.8 };
    set(ei, e.x, e.y); set(wi, w.x, w.y);
    for (const [k, off] of [[17, 0.1], [19, 0.14], [21, 0.06]]) set(k + (side === 'l' ? 0 : 1), w.x + Math.sin(r2) * dir * s * off, w.y + Math.cos(r2) * s * off);
  };
  const al = arms.l || [10, 0], ar = arms.r || [10, 0];
  arm('l', 11, 13, 15, al[0], al[1]);
  arm('r', 12, 14, 16, ar[0], ar[1]);
  const hy = sy + s * 1.55;
  set(23, cx + s * 0.32, hy); set(24, cx - s * 0.32, hy);
  set(25, cx + s * 0.34, hy + s * 1.2); set(26, cx - s * 0.34, hy + s * 1.2);
  set(27, cx + s * 0.35, hy + s * 2.3); set(28, cx - s * 0.35, hy + s * 2.3);
  set(29, cx + s * 0.33, hy + s * 2.4); set(30, cx - s * 0.33, hy + s * 2.4);
  set(31, cx + s * 0.45, hy + s * 2.45); set(32, cx - s * 0.45, hy + s * 2.45);
  return P;
}
