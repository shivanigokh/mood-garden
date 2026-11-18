// Generative ambient sound with the Web Audio API. Nothing is loaded from
// files: a soft pad, wind noise, rain, chimes for blinks and a swell for pulses.

const PENTA = [0, 2, 4, 7, 9];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Ambience {
  constructor() {
    this.ctx = null;
    this.on = false;
  }

  _init() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // simple feedback-delay "reverb" for chimes
    this.verb = ctx.createDelay(1.5);
    this.verb.delayTime.value = 0.37;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const vf = ctx.createBiquadFilter();
    vf.type = 'lowpass';
    vf.frequency.value = 2200;
    this.verb.connect(vf).connect(fb).connect(this.verb);
    const vOut = ctx.createGain();
    vOut.gain.value = 0.5;
    this.verb.connect(vOut).connect(this.master);

    // pad: a few detuned oscillators through a breathing lowpass
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.6;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.11;
    this.padFilter.connect(this.padGain).connect(this.master);
    this.padOsc = [];
    const chord = [50, 57, 62, 64, 69]; // D-ish, open voicing
    chord.forEach((n, i) => {
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = midi(n);
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.16 / (i + 1);
        o.connect(g).connect(this.padFilter);
        o.start();
        this.padOsc.push({ o, base: n });
      }
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 260;
    lfo.connect(lfoG).connect(this.padFilter.frequency);
    lfo.start();

    // noise source shared by wind + rain
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.15; }
    const mkNoise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.02;
    mkNoise().connect(this.windFilter).connect(this.windGain).connect(this.master);

    const white = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const rs = ctx.createBufferSource(); rs.buffer = white; rs.loop = true; rs.start();
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 2500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rs.connect(this.rainFilter).connect(this.rainGain).connect(this.master);
  }

  async toggle() {
    if (!this.ctx) this._init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.on = !this.on;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.on ? 0.8 : 0, now, 0.8);
    return this.on;
  }

  update(m, wind) {
    if (!this.ctx || !this.on) return;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.015 + Math.min(wind, 2.5) * 0.06, now, 0.4);
    this.windFilter.frequency.setTargetAtTime(300 + wind * 380, now, 0.5);
    this.rainGain.gain.setTargetAtTime(m.sad * 0.07, now, 0.8);
    this.padFilter.Q.setTargetAtTime(0.6 + m.angry * 4, now, 0.6);
    this.padGain.gain.setTargetAtTime(0.11 + m.smile * 0.05 - m.sad * 0.03, now, 1);
    // smiles brighten the chord, sadness darkens it, anger detunes it
    for (const p of this.padOsc) {
      p.o.detune.setTargetAtTime((p.o.detune.value > 0 ? 5 : -6) + m.angry * 30 * (p.base % 2 ? 1 : -1) - m.sad * 40, now, 1.2);
    }
  }

  chime(intensity = 1) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const note = 74 + PENTA[Math.floor(Math.random() * PENTA.length)] + (Math.random() < 0.3 ? 12 : 0);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midi(note);
      const g = ctx.createGain();
      const t0 = now + i * 0.09 + Math.random() * 0.05;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05 * intensity, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.2);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.verb);
      o.start(t0);
      o.stop(t0 + 2.4);
    }
  }

  swell(strength = 1) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(midi(38), now);
    o.frequency.exponentialRampToValueAtTime(midi(45), now + 1.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18 * strength, now + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
    o.connect(g).connect(this.master);
    g.connect(this.verb);
    o.start(now);
    o.stop(now + 2.8);
  }

  thunder(strength = 1) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime + 0.25 + Math.random() * 0.6;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { b = 0.995 * b + 0.005 * (Math.random() * 2 - 1); d[i] = b * 20; }
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.5 * strength, now + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.8);
    s.connect(f).connect(g).connect(this.master);
    s.start(now);
  }

  pluck() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midi(67 + PENTA[Math.floor(Math.random() * 5)]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    o.connect(g).connect(this.master);
    g.connect(this.verb);
    o.start(now);
    o.stop(now + 1.5);
  }
}
