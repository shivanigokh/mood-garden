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
    bmp.close();
    self.postMessage({ type: 'result', landmarks: r ? r.landmarks : null });
  }
};
