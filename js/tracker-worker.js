// Runs MediaPipe face + hand landmarking off the main thread so rendering
// never stalls while a frame is being analysed. Classic worker: the CommonJS
// build of tasks-vision is loaded with importScripts.
/* eslint-disable no-restricted-globals */
self.exports = {};
self.module = { exports: self.exports };
importScripts('../vendor/mediapipe/vision_bundle_classic.js'); // CommonJS build, renamed .js so every server sends a JS MIME type
const { FaceLandmarker, HandLandmarker, FilesetResolver } = self.module.exports;

let face = null;
let hands = null;
let lastTs = 0;

async function create(Cls, fileset, opts) {
  try {
    return { task: await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }), delegate: 'GPU' };
  } catch (e) {
    return { task: await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }), delegate: 'CPU' };
  }
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    try {
      const fileset = await FilesetResolver.forVisionTasks(d.wasm);
      const wantFace = d.face !== false; // the music studio only needs hands
      const [f, h] = await Promise.all([
        wantFace ? create(FaceLandmarker, fileset, {
          baseOptions: { modelAssetPath: d.faceModel },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }) : Promise.resolve({ task: null, delegate: null }),
        d.hands === false ? Promise.resolve({ task: null, delegate: null }) : create(HandLandmarker, fileset, {
          baseOptions: { modelAssetPath: d.handModel },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      ]);
      face = f.task;
      hands = h.task;
      self.postMessage({ type: 'ready', delegate: f.delegate || h.delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }

  if (d.type === 'frame') {
    const bmp = d.bitmap;
    const ts = Math.max(d.ts, lastTs + 1); // MediaPipe needs strictly increasing timestamps
    lastTs = ts;
    let fr = null, hr = null;
    try {
      if (face) fr = face.detectForVideo(bmp, ts);
      if (hands) hr = hands.detectForVideo(bmp, ts);
    } catch (err) {
      // keep going; one bad frame shouldn't stop tracking
    }
    bmp.close();
    self.postMessage({
      type: 'result',
      face: fr && {
        faceLandmarks: fr.faceLandmarks,
        faceBlendshapes: (fr.faceBlendshapes || []).map((b) => ({ categories: b.categories.map((c) => ({ categoryName: c.categoryName, score: c.score })) })),
      },
      hands: hr && {
        landmarks: hr.landmarks,
        handedness: (hr.handedness || []).map((arr) => arr.map((c) => ({ categoryName: c.categoryName, score: c.score }))),
      },
    });
  }
};
