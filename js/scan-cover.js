// Live scan coverage: a figure built to your proportions that turns with you and
// fills in with your real colours as each angle is captured. Parts no shot has
// seen yet stay a grey hologram, so you can see what is still to scan.
import * as THREE from 'three';
import * as S3 from './scan3d.js?v=9';

// a generic standing body (unit height, image-right = +x) used until the first capture
const GENERIC = (() => {
  const P = (x, y) => ({ x, y, z: 0 });
  return {
    hipMid: P(0, 0.52), shMid: P(0, 0.8), eyeMid: P(0, 0.93),
    11: P(0.11, 0.8), 12: P(-0.11, 0.8), 13: P(0.2, 0.64), 14: P(-0.2, 0.64), 15: P(0.27, 0.48), 16: P(-0.27, 0.48),
    23: P(0.06, 0.52), 24: P(-0.06, 0.52), 25: P(0.07, 0.28), 26: P(-0.07, 0.28), 27: P(0.07, 0.05), 28: P(-0.07, 0.05),
  };
})();

const VERT = /* glsl */ `
  attribute vec3 color;
  attribute float covered;
  uniform vec3 camDir;
  varying vec3 vCol;
  varying float vCov;
  varying float vFace;
  varying vec3 vN;
  varying float vY;
  void main() {
    vCol = color;
    vCov = covered;
    vFace = dot(normal, camDir);
    vN = normalize(normalMatrix * normal);
    vY = position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform float time;
  varying vec3 vCol;
  varying float vCov;
  varying float vFace;
  varying vec3 vN;
  varying float vY;
  void main() {
    vec3 L = normalize(vec3(0.4, 0.7, 0.6));
    float d = max(dot(vN, L), 0.0);
    float band = d > 0.55 ? 1.0 : d > 0.15 ? 0.82 : 0.66;
    vec3 scanned = vCol * band;
    // still to scan: a dim hologram with moving scan lines
    float lines = 0.55 + 0.45 * step(0.5, fract(vY * 90.0 - time * 1.5));
    vec3 todo = vec3(0.42, 0.47, 0.6) * (0.55 + 0.45 * d) * lines;
    vec3 c = mix(todo, scanned, vCov);
    // the side facing the camera right now glows
    float now = smoothstep(0.55, 0.95, vFace) * (1.0 - vCov * 0.6);
    c = mix(c, vec3(0.37, 0.94, 1.0), now * (0.35 + 0.15 * sin(time * 8.0)));
    float rim = pow(1.0 - abs(vN.z), 2.0);
    c += vec3(0.37, 0.94, 1.0) * rim * 0.35 * (1.0 - vCov);
    gl_FragColor = vec4(c, 1.0);
  }
`;

export class ScanCover {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(24, 0.62, 0.05, 20);
    this.camera.position.set(0, 0.62, 3.0);
    this.camera.lookAt(0, 0.5, 0);
    this.group = new THREE.Group();
    this.group.scale.x = -1; // mirrored, like the camera view
    this.scene.add(this.group);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { time: { value: 0 }, camDir: { value: new THREE.Vector3(0, 0, 1) } },
    });
    // floor ring: ticks for every captured angle
    this.ring = new THREE.Group();
    this.scene.add(this.ring);
    const base = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.33, 64), new THREE.MeshBasicMaterial({ color: 0x8890b0, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
    base.rotation.x = -Math.PI / 2;
    this.ring.add(base);
    this.ticks = [];
    this.angle = 0;
    this.reset();
  }

  // start again with the generic figure
  reset() {
    this.joints = null;
    this._build(GENERIC);
    for (const t of this.ticks) this.ring.remove(t);
    this.ticks = [];
  }

  _build(J) {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    const parts = [];
    const add = (a, b, r, sz = 1) => {
      const ax = new THREE.Vector3(a.x, a.y, 0), bx = new THREE.Vector3(b.x, b.y, 0);
      const len = Math.max(0.001, ax.distanceTo(bx));
      const g = new THREE.CapsuleGeometry(r, len, 6, 14);
      const m = new THREE.Matrix4().makeScale(1, 1, sz);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bx.clone().sub(ax).normalize());
      const mid = ax.clone().add(bx).multiplyScalar(0.5);
      g.applyMatrix4(m);
      g.applyMatrix4(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
      parts.push(g);
    };
    const sw = Math.max(0.12, Math.abs(J[11].x - J[12].x));
    const hipW = Math.max(0.1, Math.abs(J[23].x - J[24].x));
    // torso as a squashed capsule from the hips to the shoulders
    add({ x: J.hipMid.x, y: J.hipMid.y + 0.03 }, { x: J.shMid.x, y: J.shMid.y - 0.04 }, sw * 0.5, 0.55);
    add({ x: J[23].x * 0.6 + J.hipMid.x * 0.4, y: J.hipMid.y }, { x: J[24].x * 0.6 + J.hipMid.x * 0.4, y: J.hipMid.y }, hipW * 0.5, 0.8);
    const neckTop = { x: J.eyeMid.x, y: J.shMid.y + 0.06 };
    add(J.shMid, neckTop, 0.028);
    const headC = { x: J.eyeMid.x, y: (J.eyeMid.y + 1.0) / 2 - 0.02 };
    add({ x: headC.x, y: headC.y - 0.025 }, { x: headC.x, y: headC.y + 0.02 }, 0.058, 0.95);
    const limb = (a, b, r) => add(J[a], J[b], r);
    limb(11, 13, 0.034); limb(13, 15, 0.028); limb(12, 14, 0.034); limb(14, 16, 0.028);
    limb(23, 25, 0.05); limb(24, 26, 0.05);
    add(J[25], { x: J[27].x, y: 0.03 }, 0.038); add(J[26], { x: J[28].x, y: 0.03 }, 0.038);
    // merge
    let nv = 0, ni = 0;
    for (const g of parts) { nv += g.attributes.position.count; ni += g.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, ov * 3);
      nor.set(g.attributes.normal.array, ov * 3);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[oi + i] = gi[i] + ov;
      ov += g.attributes.position.count;
      oi += gi.length;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3).fill(0.5), 3));
    geo.setAttribute('covered', new THREE.BufferAttribute(new Float32Array(nv), 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.best = new Float32Array(nv);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.group.add(this.mesh);
  }

  // fold a new capture in: theta is how far you had turned
  addCapture(cap, theta) {
    const v = S3.measure([cap])[0];
    if (!v || v.px < 20) return;
    if (!this.joints && cap.lm) {
      // first look at you: rebuild the figure to your proportions
      try { this.joints = S3.restJoints(v); this._build(this.joints); } catch (e) { /* keep the generic one */ }
    }
    const geo = this.mesh.geometry;
    const P = geo.attributes.position.array, N = geo.attributes.normal.array;
    const C = geo.attributes.color.array, K = geo.attributes.covered.array;
    const cs = Math.cos(theta), sn = Math.sin(theta);
    const cx = -sn, cz = cs; // camera direction in body space
    const { w, h, rgba, mask } = cap;
    for (let i = 0; i < K.length; i++) {
      const nx = N[i * 3], nz = N[i * 3 + 2];
      const d = nx * cx + nz * cz;
      if (d < 0.3 || d <= this.best[i]) continue;
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const u = x * cs + z * sn;
      const px = Math.round(v.x0 + u * v.s), py = Math.round(v.yb - y * v.s);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      // nudge toward the body if this point just misses the silhouette
      let q = py * w + px;
      if (mask[q] < 0.5) {
        const step = Math.sign(v.x0 - px) || 1;
        let found = false;
        for (let k = 1; k <= 8 && !found; k++) { const qq = q + step * k * 2; if (qq >= 0 && qq < mask.length && mask[qq] >= 0.5) { q = qq; found = true; } }
        if (!found) continue;
      }
      this.best[i] = d;
      K[i] = 1;
      C[i * 3] = rgba[q * 4] / 255; C[i * 3 + 1] = rgba[q * 4 + 1] / 255; C[i * 3 + 2] = rgba[q * 4 + 2] / 255;
    }
    geo.attributes.color.needsUpdate = true;
    geo.attributes.covered.needsUpdate = true;
    // tick on the floor ring
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, 0.07), new THREE.MeshBasicMaterial({ color: 0x5ef0ff }));
    t.position.set(-sn * 0.315, 0.003, cs * 0.315);
    t.rotation.y = theta;
    this.ring.add(t);
    this.ticks.push(t);
  }

  // share of the figure seen so far
  coverage() {
    const K = this.mesh.geometry.attributes.covered.array;
    let n = 0;
    for (let i = 0; i < K.length; i++) n += K[i];
    return n / K.length;
  }

  render(angle, t) {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.renderer.setSize(W, H, false);
      this.camera.aspect = r.width / r.height;
      const tan = Math.tan((this.camera.fov * Math.PI) / 360);
      const dist = Math.max(1.2 / 2 / tan, 0.75 / 2 / tan / this.camera.aspect);
      this.camera.position.set(0, 0.62, dist);
      this.camera.lookAt(0, 0.52, 0);
      this.camera.updateProjectionMatrix();
    }
    // the figure turns as you should be turned; the ring turns with it
    this.angle += Math.atan2(Math.sin(angle - this.angle), Math.cos(angle - this.angle)) * 0.15;
    // (the view is mirrored, so a turn to your left spins the mirrored figure the other way)
    this.group.rotation.y = -this.angle;
    this.ring.rotation.y = -this.angle;
    this.ring.scale.x = -1;
    this.mat.uniforms.time.value = t;
    this.mat.uniforms.camDir.value.set(-Math.sin(this.angle), 0, Math.cos(this.angle));
    this.renderer.render(this.scene, this.camera);
  }
}
