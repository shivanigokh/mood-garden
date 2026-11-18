// Face + hand tracking with MediaPipe Tasks Vision.
// All processing is local: frames go from the <video> element straight into
// the WASM/WebGL models and are never stored or sent anywhere.


const WASM_PATH = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const FACE_MODEL = new URL('../models/face_landmarker.task', import.meta.url).href;
const HAND_MODEL = new URL('../models/hand_landmarker.task', import.meta.url).href;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist2 = (a, b, ax = 1) => Math.hypot((a.x - b.x) * ax, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Exponential smoothing that is framerate independent, with separate
// attack (rising) and release (falling) time constants in seconds.
class Smooth {
  constructor(attack = 0.25, release = 0.5, value = 0) {
    this.attack = attack;
    this.release = release;
    this.value = value;
  }
  step(target, dt) {
    const tau = target > this.value ? this.attack : this.release;
    const k = 1 - Math.exp(-dt / Math.max(tau, 1e-3));
    this.value += (target - this.value) * k;
    return this.value;
  }
}

// Face mesh landmark indices used below.
const L = {
  // eyes (person's right eye = image-left, indices 33..133)
  rEyeOuter: 33, rEyeInner: 133, rEyeTop: 159, rEyeBot: 145, rEyeTop2: 160, rEyeBot2: 144, rEyeTop3: 158, rEyeBot3: 153,
  lEyeOuter: 263, lEyeInner: 362, lEyeTop: 386, lEyeBot: 374, lEyeTop2: 385, lEyeBot2: 380, lEyeTop3: 387, lEyeBot3: 373,
  rBrow: 105, lBrow: 334, rBrowInner: 55, lBrowInner: 285,
  mouthL: 61, mouthR: 291, lipTop: 13, lipBot: 14,
  forehead: 10, chin: 152, nose: 1, cheekR: 234, cheekL: 454,
};

export class Tracker {
  constructor(video) {
    this.video = video;
    this.face = null;
    this.hands = null;
    this.stream = null;
    this.running = false;
    this.ready = false;
    this.lastVideoTime = -1;
    this.frame = 0;
    this.aspect = 4 / 3;

    // smoothed outputs
    this.s = {
      smile: new Smooth(0.35, 0.9),
      brow: new Smooth(0.25, 0.7),
      mouth: new Smooth(0.12, 0.35),
      angry: new Smooth(0.6, 1.4),
      sad: new Smooth(0.7, 1.6),
      eyes: new Smooth(0.03, 0.05),
      roll: new Smooth(0.35, 0.35),
      yaw: new Smooth(0.4, 0.4),
      pitch: new Smooth(0.4, 0.4),
      fx: new Smooth(0.45, 0.45),
      fy: new Smooth(0.45, 0.45),
      presence: new Smooth(0.3, 0.8),
    };

    this.reset();
  }

  reset() {
    // personal neutral baseline; captured over the first ~1.5s of face data
    this.base = null;
    this.calib = { n: 0, sum: {} };
    this.blink = { closed: false, lastFire: 0, closedAt: 0 };
    this.mouthEvt = { open: false, lastFire: 0 };
    this.handState = new Map();
    this.faceSeenAt = 0;
    this.raw = {};
    for (const k in this.s) if (k !== 'presence') this.s[k].value = 0;
  }

  async load(onProgress = () => {}) {
    if (this.ready) return;
    onProgress('Waking the garden…');
    // Preferred: run the models in a worker so the render loop never waits.
    if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && !/[?&]noworker/.test(location.search)) {
      try {
        await this._loadWorker();
        this.mode = 'worker';
        this.ready = true;
        return;
      } catch (e) {
        console.warn('Worker tracking unavailable, running on the main thread instead.', e);
        this.worker?.terminate();
        this.worker = null;
      }
    }
    await this._loadMain();
    this.mode = 'main';
    this.ready = true;
  }

  _loadWorker() {
    return new Promise((resolve, reject) => {
      const w = (this.worker = new Worker(new URL('./tracker-worker.js', import.meta.url)));
      const timer = setTimeout(() => reject(new Error('worker init timed out')), 45000);
      w.onerror = (e) => { clearTimeout(timer); reject(e.error || new Error(e.message || 'worker error')); };
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') { clearTimeout(timer); this.delegate = d.delegate; resolve(); }
        else if (d.type === 'error') { clearTimeout(timer); reject(new Error(d.message)); }
        else if (d.type === 'result') { this._pending = d; this._busy = false; }
      };
      w.postMessage({ type: 'init', wasm: WASM_PATH, faceModel: FACE_MODEL, handModel: HAND_MODEL });
    });
  }

  async _loadMain() {
    const { FaceLandmarker, HandLandmarker, FilesetResolver } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const make = async (Cls, opts) => {
      try {
        return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } });
      } catch (e) {
        console.warn('GPU delegate unavailable, falling back to CPU', e);
        return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
      }
    };
    [this.face, this.hands] = await Promise.all([
      make(FaceLandmarker, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      make(HandLandmarker, {
        baseOptions: { modelAssetPath: HAND_MODEL },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ]);
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('This browser does not support camera access.'), { code: 'unsupported' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.addEventListener('loadeddata', res, { once: true });
    });
    this.aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    this.running = true;
    this.lastVideoTime = -1;
  }

  stopCamera() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  // Called once per animation frame. Returns the current smoothed signals
  // plus one-shot events.
  update(nowMs, dt) {
    const out = {
      tracking: this.running,
      faceFound: false,
      events: { blink: false, pulse: 0, pinches: [] },
      hands: [],
    };
    let faceResult = null;
    let handResult = null;

    if (this.running && this.ready && this.video.readyState >= 2) {
      const vt = this.video.currentTime;
      if (this.mode === 'worker') {
        // hand the newest frame to the worker whenever it is free
        if (!this._busy && vt !== this.lastVideoTime) {
          this.lastVideoTime = vt;
          this._busy = true;
          this._busySince = nowMs;
          createImageBitmap(this.video)
            .then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]))
            .catch(() => { this._busy = false; });
        } else if (this._busy && nowMs - this._busySince > 2000) {
          this._busy = false; // a lost frame should never stall tracking
        }
        if (this._pending) {
          faceResult = this._pending.face;
          handResult = this._pending.hands;
          this._pending = null;
        }
      } else if (vt !== this.lastVideoTime) {
        this.lastVideoTime = vt;
        this.frame++;
        try {
          // alternate the two models so no single frame does both
          if (this.frame % 2 === 0) faceResult = this.face.detectForVideo(this.video, nowMs);
          else handResult = this.hands.detectForVideo(this.video, nowMs);
        } catch (e) {
          console.warn('detect failed', e);
        }
      }
    }
    if (faceResult) this.lastFace = faceResult.faceLandmarks?.[0] || null;
    if (handResult) this.lastHands = handResult.landmarks || [];
    if (!this.running) { this.lastFace = null; this.lastHands = []; this._pending = null; }
    out.newResult = !!(faceResult || handResult);

    // ---------- face ----------
    const lm = faceResult?.faceLandmarks?.[0];
    if (faceResult) this._hasFace = !!lm;
    if (lm) {
      const bs = {};
      for (const c of faceResult.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
      this._processFace(lm, bs, nowMs, out);
    }
    if (!this._hasFace || !this.running) {
      // no face: relax everything toward neutral
      this._targets = { smile: 0, brow: 0, mouth: 0, angry: 0, sad: 0, eyes: 0, roll: 0, yaw: 0, pitch: 0, fx: 0, fy: 0 };
    }
    out.faceFound = !!this._hasFace && this.running;
    const t = this._targets || {};
    for (const k in this.s) {
      if (k === 'presence') continue;
      this.s[k].step(t[k] ?? 0, dt);
    }
    this.s.presence.step(out.faceFound ? 1 : 0, dt);

    // blink + mouth events run on raw (lightly filtered) values with hysteresis
    if (lm) {
      out.events.blink = this._blinkEdge(nowMs);
      out.events.pulse = this._mouthEdge(nowMs);
    }

    // ---------- hands ----------
    if (handResult) this._processHands(handResult, nowMs);
    if (!this.running) this.handState.clear();
    for (const [key, h] of this.handState) {
      if (nowMs - h.seen > 400) { this.handState.delete(key); continue; }
      out.hands.push(h);
      if (h.pinchEvent) { out.events.pinches.push({ x: h.x, y: h.y }); h.pinchEvent = false; }
    }

    const v = (k) => this.s[k].value;
    out.smile = v('smile');
    out.brow = v('brow');
    out.mouth = v('mouth');
    out.angry = v('angry');
    out.sad = v('sad');
    out.eyes = v('eyes');
    out.roll = v('roll');
    out.yaw = v('yaw');
    out.pitch = v('pitch');
    out.fx = v('fx');
    out.fy = v('fy');
    out.presence = v('presence');
    out.calibrated = !!this.base;
    return out;
  }

  _processFace(lm, bs, nowMs, out) {
    const ax = this.aspect; // correct x distances for non-square video
    const faceH = dist2(lm[L.forehead], lm[L.chin], ax) || 1;
    const faceW = dist2(lm[L.cheekR], lm[L.cheekL], ax) || 1;

    // eye aspect ratio (6-point EAR averaged over both eyes)
    const ear = (o, i, t1, b1, t2, b2, t3, b3) =>
      (dist2(lm[t1], lm[b1], ax) + dist2(lm[t2], lm[b2], ax) + dist2(lm[t3], lm[b3], ax)) / (3 * dist2(lm[o], lm[i], ax));
    const earR = ear(L.rEyeOuter, L.rEyeInner, L.rEyeTop, L.rEyeBot, L.rEyeTop2, L.rEyeBot2, L.rEyeTop3, L.rEyeBot3);
    const earL = ear(L.lEyeOuter, L.lEyeInner, L.lEyeTop, L.lEyeBot, L.lEyeTop2, L.lEyeBot2, L.lEyeTop3, L.lEyeBot3);
    const EAR = (earR + earL) / 2;

    // brow height above upper eyelid, normalised by face height
    const browH = ((lm[L.rEyeTop].y - lm[L.rBrow].y) + (lm[L.lEyeTop].y - lm[L.lBrow].y)) / 2 / faceH;
    // inner brow gap (shrinks when furrowing)
    const browGap = dist2(lm[L.rBrowInner], lm[L.lBrowInner], ax) / faceW;

    // mouth geometry
    const mouthW = dist2(lm[L.mouthL], lm[L.mouthR], ax);
    const MAR = dist2(lm[L.lipTop], lm[L.lipBot], ax) / (mouthW || 1);
    const lipMidY = (lm[L.lipTop].y + lm[L.lipBot].y) / 2;
    const cornerLift = (lipMidY - (lm[L.mouthL].y + lm[L.mouthR].y) / 2) / faceH; // + when corners go up
    const mouthWidth = mouthW / faceW;

    const eyeMidY = (lm[L.rEyeTop].y + lm[L.lEyeTop].y) / 2;
    const pitchGeo = (lm[L.nose].y - eyeMidY) / faceH;

    const avg = (a, b) => ((bs[a] ?? 0) + (bs[b] ?? 0)) / 2;
    const raw = {
      pitch: pitchGeo, EAR, browH, browGap, MAR, cornerLift, mouthWidth,
      bSmile: avg('mouthSmileLeft', 'mouthSmileRight'),
      bBlink: avg('eyeBlinkLeft', 'eyeBlinkRight'),
      bBrowInner: bs.browInnerUp ?? 0,
      bBrowOuter: avg('browOuterUpLeft', 'browOuterUpRight'),
      bBrowDown: avg('browDownLeft', 'browDownRight'),
      bJaw: bs.jawOpen ?? 0,
      bFrown: avg('mouthFrownLeft', 'mouthFrownRight'),
      bSneer: avg('noseSneerLeft', 'noseSneerRight'),
      bPress: avg('mouthPressLeft', 'mouthPressRight'),
      bStretch: avg('mouthStretchLeft', 'mouthStretchRight'),
      bLowerDown: avg('mouthLowerDownLeft', 'mouthLowerDownRight'),
    };
    this.raw = raw;

    // --- calibration: average a neutral face over ~45 frames ---
    if (!this.base) {
      if (this.calib.n === 0) this.faceSeenAt = nowMs;
      this.calib.n++;
      for (const k in raw) this.calib.sum[k] = (this.calib.sum[k] ?? 0) + raw[k];
      if (this.calib.n >= 45 || (this.calib.n >= 6 && nowMs - this.faceSeenAt > 1200)) {
        this.base = {};
        for (const k in raw) this.base[k] = this.calib.sum[k] / this.calib.n;
      }
    }
    const b = this.base || raw; // until calibrated, treat current face as neutral

    // --- expressions, each combining landmark geometry with blendshapes ---
    const geoSmile = clamp01((raw.cornerLift - b.cornerLift) / 0.035) * 0.5 + clamp01((raw.mouthWidth - b.mouthWidth) / 0.08) * 0.5;
    const bsSmile = clamp01((raw.bSmile - Math.min(b.bSmile, 0.3)) / 0.6);
    let smile = clamp01(0.65 * bsSmile + 0.35 * geoSmile);
    smile = smile * smile * (3 - 2 * smile) * 0.35 + smile * 0.65; // gentle curve, keeps intensity graded

    const geoBrow = clamp01((raw.browH - b.browH) / 0.03);
    const bsBrow = clamp01(((raw.bBrowInner + raw.bBrowOuter) / 2 - Math.min((b.bBrowInner + b.bBrowOuter) / 2, 0.3)) / 0.45);
    const brow = clamp01(0.5 * geoBrow + 0.5 * bsBrow);

    const geoMouth = clamp01((raw.MAR - b.MAR) / 0.55);
    const bsMouth = clamp01((raw.bJaw - Math.min(b.bJaw, 0.15)) / 0.5);
    const mouth = clamp01(0.5 * geoMouth + 0.5 * bsMouth);

    const browDown = clamp01((raw.bBrowDown - Math.min(b.bBrowDown, 0.3)) / 0.4);
    const furrow = clamp01((b.browGap - raw.browGap) / 0.035);
    const browLower = clamp01((b.browH - raw.browH) / 0.02);
    const sneer = clamp01((raw.bSneer - Math.min(b.bSneer, 0.2)) / 0.35);
    let angry = clamp01(0.45 * browDown + 0.25 * furrow + 0.15 * browLower + 0.15 * sneer);
    angry *= 1 - 0.85 * smile;
    angry *= 1 - 0.7 * brow;
    angry = clamp01((angry - 0.08) / 0.75);

    const frown = clamp01((raw.bFrown - Math.min(b.bFrown, 0.15)) / 0.3);
    const cornerDrop = clamp01((b.cornerLift - raw.cornerLift) / 0.02);
    const innerUp = clamp01(((raw.bBrowInner - raw.bBrowOuter) - Math.max(0, b.bBrowInner - b.bBrowOuter)) / 0.35);
    const pout = clamp01((raw.bPress + raw.bLowerDown * 0.5 - Math.min(b.bPress + b.bLowerDown * 0.5, 0.25)) / 0.4);
    let sad = clamp01(0.4 * frown + 0.3 * cornerDrop + 0.2 * clamp01(innerUp) + 0.1 * pout);
    sad *= 1 - 0.9 * smile;
    sad *= 1 - 0.5 * mouth;
    sad = clamp01((sad - 0.08) / 0.7);

    // eye closure: blendshape + EAR, whichever is more confident
    const earClosure = clamp01((b.EAR * 0.92 - raw.EAR) / (b.EAR * 0.55));
    const bsClosure = clamp01((raw.bBlink - Math.min(b.bBlink, 0.35)) / 0.45);
    const eyes = Math.max(earClosure, bsClosure * 0.9 + earClosure * 0.1);
    this._eyesRaw = eyes;
    this._mouthRaw = mouth;

    // head pose from landmarks, mirrored so it matches the user's mirror image
    const pR = lm[L.rEyeOuter], pL = lm[L.lEyeOuter];
    const roll = Math.atan2(pR.y - pL.y, (pL.x - pR.x) * ax); // + = tilting clockwise on screen
    const midCheekX = (lm[L.cheekR].x + lm[L.cheekL].x) / 2;
    const yaw = -((lm[L.nose].x - midCheekX) * ax) / (faceW || 1) * 2; // + = turned to user's left
    const pitchRaw = raw.pitch;
    // pitch relative to the calibrated neutral pose
    const pitch = (pitchRaw - (this.base?.pitch ?? pitchRaw)) * 6;

    let cx = 0, cy = 0;
    for (const i of [L.nose, L.forehead, L.chin, L.cheekL, L.cheekR]) { cx += lm[i].x; cy += lm[i].y; }
    cx /= 5; cy /= 5;

    // slow baseline drift so long sessions stay calibrated (only while near neutral)
    if (this.base && smile < 0.1 && brow < 0.1 && mouth < 0.1 && angry < 0.1 && sad < 0.1 && eyes < 0.2) {
      const a = 0.003;
      for (const k in raw) this.base[k] += (raw[k] - this.base[k]) * a;
    }

    this._targets = {
      smile, brow, mouth, angry, sad, eyes,
      roll: clamp(roll, -0.6, 0.6),
      yaw: clamp(yaw, -1, 1),
      pitch: clamp(pitch, -1, 1),
      fx: clamp((0.5 - cx) * 2, -1, 1), // mirrored
      fy: clamp((0.5 - cy) * 2, -1, 1),
    };
    this._signalsRaw = { smile, brow, mouth, angry, sad, eyes };
  }

  _blinkEdge(now) {
    if (!this.base) return false;
    const e = this._eyesRaw ?? 0;
    const B = this.blink;
    if (!B.closed && e > 0.6) {
      B.closed = true;
      B.closedAt = now;
      // fire once per closure; ignore rapid flutter
      if (now - B.lastFire > 280) { B.lastFire = now; return true; }
    } else if (B.closed && e < 0.32) {
      B.closed = false;
    }
    return false;
  }

  _mouthEdge(now) {
    if (!this.base) return 0;
    const m = this._mouthRaw ?? 0;
    const M = this.mouthEvt;
    if (!M.open && m > 0.5) {
      M.open = true;
      if (now - M.lastFire > 1100) { M.lastFire = now; return clamp01(0.55 + m * 0.6); }
    } else if (M.open && m < 0.22) {
      M.open = false;
    }
    return 0;
  }

  _processHands(res, now) {
    const lms = res.landmarks || [];
    const seenKeys = new Set();
    lms.forEach((lm, i) => {
      const label = res.handedness?.[i]?.[0]?.categoryName ?? `h${i}`;
      let key = label;
      if (seenKeys.has(key)) key = key + i;
      seenKeys.add(key);

      const palmIdx = [0, 5, 9, 13, 17];
      let px = 0, py = 0;
      for (const j of palmIdx) { px += lm[j].x; py += lm[j].y; }
      px /= 5; py /= 5;
      const palm = dist3(lm[0], lm[9]) || 1e-3;
      const tips = [8, 12, 16, 20];
      let ext = 0;
      for (const j of tips) ext += dist3(lm[j], lm[0]) / palm;
      ext /= tips.length;
      const open = clamp01((ext - 1.15) / 0.7);
      const pinchD = dist3(lm[4], lm[8]) / palm;

      let h = this.handState.get(key);
      const x = 1 - px; // mirror
      const y = py;
      if (!h) {
        h = { key, x, y, sx: x, sy: y, vx: 0, vy: 0, open, sOpen: open, pinched: false, pinchEvent: false, gesture: 'relaxed', seen: now, lastPinch: 0, born: now };
        this.handState.set(key, h);
      }
      const dt = Math.max((now - h.seen) / 1000, 1 / 60);
      const k = 1 - Math.exp(-dt / 0.08);
      const nx = h.sx + (x - h.sx) * k;
      const ny = h.sy + (y - h.sy) * k;
      const vx = (nx - h.sx) / dt, vy = (ny - h.sy) / dt;
      h.vx += (vx - h.vx) * (1 - Math.exp(-dt / 0.12));
      h.vy += (vy - h.vy) * (1 - Math.exp(-dt / 0.12));
      h.sx = nx; h.sy = ny;
      h.x = nx; h.y = ny;
      h.sOpen += (open - h.sOpen) * (1 - Math.exp(-dt / 0.15));
      h.open = h.sOpen;
      h.seen = now;

      // pinch with hysteresis
      if (!h.pinched && pinchD < 0.3 && h.sOpen < 0.95) {
        h.pinched = true;
        if (now - h.lastPinch > 700 && now - h.born > 300) { h.pinchEvent = true; h.lastPinch = now; }
      } else if (h.pinched && pinchD > 0.48) {
        h.pinched = false;
      }

      h.gesture = h.pinched ? 'pinch' : h.sOpen > 0.6 ? 'open' : h.sOpen < 0.22 ? 'fist' : 'relaxed';
    });
  }
}
