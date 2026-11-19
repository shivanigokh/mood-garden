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
    try { r = pose.detectForVideo(bmp, ts); } catch (err) { /* skip a bad frame */ }
    const msg = { type: 'result', landmarks: r ? r.landmarks : null };
    const transfer = [];
    if (d.capture) {
      // a scan capture: hand back the full frame, its body mask and 3D landmarks
      const w = bmp.width, h = bmp.height;
      let mask = null;
      try {
        const m = r?.segmentationMasks?.[0];
        if (m) { mask = new Float32Array(m.getAsFloat32Array()); }
      } catch (err) { mask = null; }
      let rgba = null;
      try {
        const oc = new OffscreenCanvas(w, h);
        const oc2 = oc.getContext('2d');
        oc2.drawImage(bmp, 0, 0);
        rgba = oc2.getImageData(0, 0, w, h).data;
      } catch (err) { rgba = null; }
      msg.capture = { id: d.capture, w, h, mask, rgba, world: r?.worldLandmarks?.[0] || null, lm: r?.landmarks?.[0] || null };
      if (mask) transfer.push(mask.buffer);
      if (rgba) transfer.push(rgba.buffer);
    }
    try { r?.segmentationMasks?.forEach((m) => m.close()); } catch (err) { /* already closed */ }
    bmp.close();
    self.postMessage(msg, transfer);
  }
};
