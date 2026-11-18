import { Garden } from './garden.js';
import { Ambience } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const noCamBtn = $('no-camera');
const hud = $('hud');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const handsStatus = $('hands-status');
const btnCamera = $('btn-camera');
const btnAudio = $('btn-audio');
const btnReset = $('btn-reset');
const btnGuide = $('btn-guide');
const guide = $('guide');
const debugEl = $('debug');
const toast = $('toast');
const flashEl = document.querySelector('.flash');
const video = $('cam');
const mirror = $('mirror');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const moodLabel = $('mood-label');
const btnMirror = $('btn-mirror');
let CONN = null; // landmark connection lists, loaded with the tracker

let garden;
try {
  garden = new Garden(canvas);
} catch (e) {
  console.error(e);
  note.textContent = 'This browser could not start WebGL, which the garden needs to grow. Try a recent Chrome, Edge, Firefox or Safari.';
  note.classList.add('error');
  enterBtn.disabled = true;
  throw e;
}
const audio = new Ambience();
let tracker = null; // loaded lazily so the landing screen appears instantly

// mood values that can be overridden for testing via window.moodGarden.simulate
const sim = { active: false, values: {} };

let cameraOn = false;
let entered = false;
let lastSignals = null;

// ---------- UI helpers ----------
function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

let toastTimer;
function showToast(msg, ms = 5000) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

function cameraErrorMessage(err) {
  if (!window.isSecureContext) return 'Camera access needs a secure page. Open the garden over https:// or from http://localhost.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this page in your browser’s address bar or site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect a webcam and try again.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it and try again.';
    default:
      return err?.code === 'unsupported' ? err.message : 'The garden could not start the camera. ' + (err?.message || '');
  }
}

function enterGarden() {
  if (entered) return;
  entered = true;
  landing.classList.add('gone');
  hud.hidden = false;
}

async function startCamera() {
  setStatus('loading', 'starting camera…');
  if (!tracker) {
    const [{ Tracker }, vision] = await Promise.all([import('./tracking.js'), import('../vendor/mediapipe/vision_bundle.mjs')]);
    tracker = new Tracker(video);
    CONN = {
      tess: vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION,
      lines: [
        ...vision.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
        ...vision.FaceLandmarker.FACE_LANDMARKS_LIPS,
        ...vision.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
        ...vision.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
        ...vision.FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
        ...vision.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
      ],
      hand: vision.HandLandmarker.HAND_CONNECTIONS,
    };
  }
  // ask for the camera first so the permission prompt appears immediately,
  // and download the models in parallel
  const loading = tracker.load((msg) => { if (!entered) enterBtn.textContent = msg; });
  await tracker.startCamera();
  await loading;
  cameraOn = true;
  mirror.classList.remove('off');
  btnCamera.classList.remove('off');
  btnCamera.title = 'Turn camera off';
  setStatus('searching', 'looking for you');
}

function stopCamera() {
  tracker?.stopCamera();
  cameraOn = false;
  mirror.classList.add('off');
  octx.clearRect(0, 0, overlay.width, overlay.height);
  moodLabel.textContent = 'camera off';
  btnCamera.classList.add('off');
  btnCamera.title = 'Turn camera on';
  setStatus('off', 'camera off');
  handsStatus.textContent = '';
}

// ---------- landing ----------
enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Waking the garden…';
  note.classList.remove('error');
  note.textContent = 'When your browser asks, allow the camera. Frames are analysed on this device only and never saved or sent.';
  try {
    await startCamera();
    enterGarden();
  } catch (err) {
    console.error(err);
    stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name || err?.code ? cameraErrorMessage(err) : 'The face tracking models could not load. Check your connection and try again. (' + (err?.message || err) + ')';
    note.classList.add('error');
    noCamBtn.hidden = false;
  }
});

noCamBtn.addEventListener('click', () => {
  enterGarden();
  setStatus('off', 'camera off');
  btnCamera.classList.add('off');
  showToast('Wandering without a camera. Click the garden to send a ripple, or turn the camera on at the top right.');
});

// ---------- controls ----------
btnCamera.addEventListener('click', async () => {
  if (cameraOn) {
    stopCamera();
    return;
  }
  btnCamera.disabled = true;
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    stopCamera();
    setStatus('error', 'camera unavailable');
    showToast(cameraErrorMessage(err), 7000);
  } finally {
    btnCamera.disabled = false;
  }
});

function setMirror(visible) {
  mirror.classList.toggle('hidden', !visible);
  btnMirror.setAttribute('aria-pressed', String(visible));
  btnMirror.title = visible ? 'Hide your face' : 'Show your face';
  try { localStorage.setItem('mg-mirror', visible ? '1' : '0'); } catch {}
}
btnMirror.addEventListener('click', () => setMirror(mirror.classList.contains('hidden')));
try { if (localStorage.getItem('mg-mirror') === '0') setMirror(false); } catch {}

// ---------- face + hand overlay on the mirrored preview ----------
const GESTURE_COL = { open: '#f6d98c', fist: '#f0a3b2', pinch: '#c4b5f5', relaxed: '#fff6e6' };
function drawOverlay(s, m) {
  if (mirror.classList.contains('hidden') || !CONN) return;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  if (overlay.width !== vw) { overlay.width = vw; overlay.height = vh; }
  octx.clearRect(0, 0, vw, vh);
  const face = tracker?.lastFace;
  if (face && s.faceFound) {
    // mood tints the mesh: gold when smiling, rose when stormy, blue when sad
    const r = Math.round(255 - m.sad * 60 - m.angry * 10), g = Math.round(244 - m.angry * 90 - m.sad * 20 + m.smile * 4), b = Math.round(225 - m.smile * 70 + m.sad * 30 - m.angry * 40);
    const col = `${r},${g},${b}`;
    octx.lineWidth = 0.7;
    octx.strokeStyle = `rgba(${col},0.16)`;
    octx.beginPath();
    for (const c of CONN.tess) {
      const a = face[c.start], z = face[c.end];
      octx.moveTo(a.x * vw, a.y * vh);
      octx.lineTo(z.x * vw, z.y * vh);
    }
    octx.stroke();
    octx.lineWidth = 1.8;
    octx.strokeStyle = `rgba(${col},0.9)`;
    octx.beginPath();
    for (const c of CONN.lines) {
      const a = face[c.start], z = face[c.end];
      octx.moveTo(a.x * vw, a.y * vh);
      octx.lineTo(z.x * vw, z.y * vh);
    }
    octx.stroke();
  }
  const hands = tracker?.lastHands || [];
  hands.forEach((lm, i) => {
    const gesture = s.hands[i]?.gesture || 'relaxed';
    const col = GESTURE_COL[gesture];
    octx.strokeStyle = col;
    octx.lineWidth = 2.4;
    octx.beginPath();
    for (const c of CONN.hand) {
      octx.moveTo(lm[c.start].x * vw, lm[c.start].y * vh);
      octx.lineTo(lm[c.end].x * vw, lm[c.end].y * vh);
    }
    octx.stroke();
    octx.fillStyle = '#fffaf0';
    for (const p of lm) {
      octx.beginPath();
      octx.arc(p.x * vw, p.y * vh, 3, 0, Math.PI * 2);
      octx.fill();
    }
  });
}

function moodWord(m, s) {
  if (!s.faceFound) return cameraOn ? 'looking for you…' : 'camera off';
  if (!s.calibrated) return 'learning your face…';
  const c = [
    ['smiling', m.smile], ['stormy', m.angry], ['blue', m.sad],
    ['breezy', m.brow * 0.9], ['ah!', m.mouth], ['tilting', Math.min(1, Math.abs(m.roll) * 3)],
  ].sort((a, b) => b[1] - a[1])[0];
  if (s.hands.length && c[1] < 0.35) return s.hands.map((h) => ({ open: 'open palm', fist: 'fist', pinch: 'pinch', relaxed: 'hand' })[h.gesture]).join(' · ');
  return c[1] > 0.35 ? c[0] : 'calm';
}

btnAudio.addEventListener('click', async () => {
  const on = await audio.toggle();
  btnAudio.setAttribute('aria-pressed', String(on));
  btnAudio.title = on ? 'Mute ambient sound' : 'Ambient sound';
});

btnReset.addEventListener('click', () => {
  garden.reset();
  tracker?.reset(); // re-learn the neutral face too
  if (cameraOn) setStatus('searching', 'recalibrating');
  showToast('The garden is resting again. Hold a relaxed face for a second while it re-learns you.', 3500);
});

function setGuide(visible) {
  guide.classList.toggle('hidden', !visible);
  btnGuide.setAttribute('aria-pressed', String(visible));
  try { localStorage.setItem('mg-guide', visible ? '1' : '0'); } catch {}
}
btnGuide.addEventListener('click', () => setGuide(guide.classList.contains('hidden')));
$('guide-hide').addEventListener('click', () => setGuide(false));
try { if (localStorage.getItem('mg-guide') === '0') setGuide(false); } catch {}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'd' || e.key === 'D') debugEl.hidden = !debugEl.hidden;
});

// without a camera, a click sends a ripple from that spot
canvas.addEventListener('click', (e) => {
  if (!entered || cameraOn) return;
  const f = garden.plantAtScreen(e.clientX / innerWidth, e.clientY / innerHeight);
  garden.pulse(0.8, f.pos.x, f.pos.y);
  audio.swell(0.6);
});

garden.onLightning = (s) => {
  audio.thunder(s);
};

// ---------- adaptive quality: step down if frames are consistently slow ----------
const perf = { t: 0, n: 0, level: 2, warm: 2.5 };
function adaptQuality(dt) {
  if (document.hidden) return;
  if (perf.warm > 0) { perf.warm -= dt; return; } // ignore shader-compile hitches
  perf.t += dt; perf.n++;
  if (perf.t < 2) return;
  const fps = perf.n / perf.t;
  perf.t = 0; perf.n = 0;
  if (fps < 45 && perf.level > 0) {
    perf.level--;
    garden.setQuality(perf.level);
    perf.warm = 1.5;
  }
}

// ---------- main loop ----------
const neutral = { newResult: false, smile: 0, brow: 0, mouth: 0, angry: 0, sad: 0, eyes: 0, roll: 0, yaw: 0, pitch: 0, fx: 0, fy: 0, hands: [], events: { blink: false, pulse: 0, pinches: [] }, faceFound: false, presence: 0 };
let last = performance.now();
let faceLostAt = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  let s = tracker && cameraOn ? tracker.update(now, dt) : neutral;
  if (tracker && !cameraOn) tracker.update(now, dt); // let smoothed values relax
  lastSignals = s;

  // status indicator
  if (cameraOn) {
    if (s.faceFound) {
      faceLostAt = 0;
      setStatus('active', s.calibrated ? 'face tracking active' : 'learning your face…');
    } else {
      faceLostAt ||= now;
      if (now - faceLostAt > 600) setStatus('searching', 'looking for you');
    }
    handsStatus.textContent = s.hands.length ? `${s.hands.length} hand${s.hands.length > 1 ? 's' : ''}` : '';
  }

  // the face only influences the garden while it is present; otherwise it rests
  const p = s.presence ?? 0;
  const m = {
    smile: s.smile * p,
    brow: s.brow * p,
    mouth: s.mouth * p,
    angry: s.angry * p,
    sad: s.sad * p,
    roll: s.roll * p,
    yaw: s.yaw * p,
    pitch: s.pitch * p,
    fx: s.fx * p,
    fy: s.fy * p,
    hands: s.hands,
    handGust: 0,
  };
  for (const h of s.hands) {
    const speed = Math.hypot(h.vx, h.vy);
    m.handGust = Math.max(m.handGust, Math.min(1.6, Math.max(0, (speed - 0.9) * 0.9)));
  }
  if (sim.active) Object.assign(m, sim.values);

  // one-shot events
  if (s.events.blink) { garden.blink(); audio.chime(0.8); }
  if (s.events.pulse) { garden.pulse(s.events.pulse); audio.swell(s.events.pulse); }
  for (const pin of s.events.pinches) { garden.plantAtScreen(pin.x, pin.y); audio.pluck(); }

  garden.update(dt, m);
  adaptQuality(dt);
  if (cameraOn && (s.newResult || !s.faceFound)) drawOverlay(s, m);
  if (cameraOn) {
    const word = moodWord(m, s);
    if (moodLabel.textContent !== word) moodLabel.textContent = word;
  }
  audio.update(m, garden.wind);
  flashEl.style.opacity = String(Math.min(0.45, garden.flashLevel * 0.4));

  if (!debugEl.hidden) {
    const bar = (v) => '▮'.repeat(Math.round(Math.max(0, Math.min(1, v)) * 12)).padEnd(12, '·');
    debugEl.textContent =
      `smile  ${bar(m.smile)} ${m.smile.toFixed(2)}\n` +
      `brows  ${bar(m.brow)} ${m.brow.toFixed(2)}\n` +
      `mouth  ${bar(m.mouth)} ${m.mouth.toFixed(2)}\n` +
      `eyes   ${bar(s.eyes)} ${(s.eyes ?? 0).toFixed(2)}\n` +
      `angry  ${bar(m.angry)} ${m.angry.toFixed(2)}\n` +
      `sad    ${bar(m.sad)} ${m.sad.toFixed(2)}\n` +
      `tilt   ${(m.roll * 57.3).toFixed(0)}°  yaw ${m.yaw.toFixed(2)}\n` +
      `wind   ${garden.wind.toFixed(2)}\n` +
      `hands  ${s.hands.map((h) => h.gesture).join(', ') || '-'}\n` +
      `fps    ${(1 / Math.max(dt, 1e-3)).toFixed(0)}`;
  }
}
requestAnimationFrame(frame);

// small console API for testing reactions without a camera
window.moodGarden = {
  garden,
  simulate(values) { sim.active = true; Object.assign(sim.values, values); },
  stopSimulating() { sim.active = false; sim.values = {}; },
  blink: () => garden.blink(),
  pulse: (s = 1) => garden.pulse(s),
  plant: (x = 0.5, y = 0.7) => garden.plantAtScreen(x, y),
  get signals() { return lastSignals; },
  enter: enterGarden,
};
