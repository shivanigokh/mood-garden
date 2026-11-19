// Runs MediaPipe Pose (full-body landmarks) off the main thread.
// Classic worker: the CommonJS build of tasks-vision is loaded with importScripts.
/* eslint-disable no-restricted-globals */
self.exports = {};
self.module = { exports: self.exports };
importScripts('../vendor/mediapipe/vision_bundle_classic.js');
const { PoseLandmarker, FilesetResolver } = self.module.exports;

let pose = null;
let lastTs = 0;

async function create(fileset, opts) {
  try {
    return { task: await PoseLandmarker.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }), delegate: 'GPU' };
  } catch (e) {
    return { task: await PoseLandmarker.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }), delegate: 'CPU' };
  }
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    try {
      const fileset = await FilesetResolver.forVisionTasks(d.wasm);
      const p = await create(fileset, {
        baseOptions: { modelAssetPath: d.model },
        runningMode: 'VIDEO',
        numPoses: d.numPoses || 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: !!d.masks,
      });
      pose = p.task;
      self.postMessage({ type: 'ready', delegate: p.delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (d.type === 'frame') {
    const bmp = d.bitmap;
    const ts = Math.max(d.ts, lastTs + 1);
    lastTs = ts;
    let r = null;
    let detErr = '';
    try { r = pose.detectForVideo(bmp, ts); } catch (err) { detErr = String(err?.message || err); }
    const msg = { type: 'result', landmarks: r ? r.landmarks : null };
    const transfer = [];
    if (d.capture) {
      // a scan capture: hand back this frame's body mask and 3D landmarks
      let mask = null, err = r ? '' : 'pose failed: ' + detErr;
      const m = r?.segmentationMasks?.[0];
      if (m) {
        // On Macs, MediaPipe's mask read-back checks 'ontouchend' in document, which a
        // worker doesn't have. Lend it an empty one just for this call.
        const shim = typeof self.document === 'undefined';
        if (shim) self.document = {};
        try { mask = new Float32Array(m.getAsFloat32Array()); } catch (e1) {
          try { mask = Float32Array.from(m.getAsUint8Array(), (x) => x / 255); } catch (e2) { err = 'mask read: ' + (e1?.message || e1); }
        }
        if (shim) delete self.document;
      } else if (r) err = 'no person in this frame';
      msg.capture = { id: d.capture, mw: m?.width || bmp.width, mh: m?.height || bmp.height, mask, err, world: r?.worldLandmarks?.[0] || null, lm: r?.landmarks?.[0] || null };
      if (mask) transfer.push(mask.buffer);
    }
    try { r?.segmentationMasks?.forEach((m) => m.close()); } catch (err) { /* already closed */ }
    bmp.close();
    self.postMessage(msg, transfer);
  }
};
