// Small helpers shared by the Shadows and Pet pages.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (dt, tau) => 1 - Math.exp(-dt / tau); // frame-rate independent smoothing factor

export function cameraErrorMessage(err) {
  if (!window.isSecureContext) return 'Camera access needs a secure page. Open this over https:// or from http://localhost.';
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
      return 'The camera could not start. ' + (err?.message || '');
  }
}

// Map a normalized landmark to screen pixels as if the (mirrored) camera filled the screen.
export function toScreen(p, vw, vh, W, H) {
  const s = Math.max(W / vw, H / vh);
  const ox = (vw * s - W) / 2, oy = (vh * s - H) / 2;
  return { x: W - (p.x * vw * s - ox), y: p.y * vh * s - oy };
}

// Tiny synth for little creature sounds. Everything is generated; there are no audio files.
export class Sfx {
  constructor() {
    this.ac = null;
    this.on = true;
  }
  init() {
    if (this.ac) { this.ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = (this.ac = new AC());
    this.out = ac.createGain();
    this.out.gain.value = 0.7;
    const comp = ac.createDynamicsCompressor();
    this.out.connect(comp).connect(ac.destination);
    const n = ac.sampleRate;
    this.noise = ac.createBuffer(1, n, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  setOn(v) {
    this.on = v;
    if (this.out) this.out.gain.setTargetAtTime(v ? 0.7 : 0, this.ac.currentTime, 0.05);
  }
  get ready() { return !!this.ac && this.on && this.ac.state === 'running'; }
  // a pitched blip: freqs is a list of [time, Hz] points
  tone({ type = 'sine', freqs, dur, gain = 0.2, attack = 0.01, filter = null, q = 1, delay = 0 }) {
    if (!this.ready) return;
    const ac = this.ac, t = ac.currentTime + delay;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freqs[0][1], t);
    for (const [ft, f] of freqs.slice(1)) o.frequency.exponentialRampToValueAtTime(f, t + ft);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = filter;
      f.Q.value = q;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  hiss({ dur = 0.1, gain = 0.15, type = 'bandpass', freq = 2000, q = 1, delay = 0, am = 0 }) {
    if (!this.ready) return;
    const ac = this.ac, t = ac.currentTime + delay;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g);
    if (am) {
      // amplitude flutter, used for purring
      const lfo = ac.createOscillator();
      lfo.frequency.value = am;
      const depth = ac.createGain();
      depth.gain.value = 0.5;
      const amp = ac.createGain();
      amp.gain.value = 0.5;
      lfo.connect(depth).connect(amp.gain);
      g.connect(amp).connect(this.out);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    } else g.connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }
}

export function setupToggle(btn, initial, onChange) {
  let v = initial;
  btn.setAttribute('aria-pressed', String(v));
  btn.addEventListener('click', () => { v = !v; btn.setAttribute('aria-pressed', String(v)); onChange(v); });
  return { set(nv) { v = nv; btn.setAttribute('aria-pressed', String(v)); onChange(v); } };
}
