// The living garden: a small floating island rendered with Three.js.
// Everything here is driven by a "mood" state object built in main.js.

import * as THREE from 'three';

// ---------- helpers ----------
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + (b - a) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const damp = (cur, target, tau, dt) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));

const ISLAND_R = 14;
export function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  const hills = 0.32 * Math.sin(x * 0.28 + 0.6) * Math.cos(z * 0.24 - 0.3) + 0.16 * Math.sin(x * 0.63 + z * 0.51) + 0.08 * Math.cos(z * 0.9 - x * 0.4);
  const edge = THREE.MathUtils.smoothstep(r, ISLAND_R - 3.5, ISLAND_R);
  return hills * (1 - edge * 0.6) + 0.25 - edge * 0.55;
}

const PALETTE = {
  sage: '#9db39a',
  sageDeep: '#6f8c6c',
  deepGreen: '#3f5a45',
  forest: '#2f4636',
  pink: '#efc7cc',
  rose: '#e2a6b0',
  lavender: '#c3b8e3',
  lilac: '#a99bd1',
  yellow: '#f3e1a0',
  butter: '#f7ecc4',
  ivory: '#f8f2e4',
};

// Mood looks. Each is a full description of sky + light; the garden blends them.
const LOOKS = {
  rest: { top: '#c9d0e2', mid: '#e7e3e3', horizon: '#f4ead8', fog: '#ebe3d5', sun: '#fff0d8', sunI: 2.3, hemiSky: '#e9ecf2', hemiGround: '#7d8f73', hemiI: 1.15, cloud: '#fbf7ef' },
  happy: { top: '#efcbd6', mid: '#f7dfd5', horizon: '#fbe6b4', fog: '#f6e5cb', sun: '#ffd9a2', sunI: 3.0, hemiSky: '#fff1e2', hemiGround: '#a39a6d', hemiI: 1.35, cloud: '#fff6ea' },
  angry: { top: '#3a2232', mid: '#64323f', horizon: '#a65a62', fog: '#74434b', sun: '#ffb0a0', sunI: 1.5, hemiSky: '#a06a74', hemiGround: '#4a3a3c', hemiI: 0.8, cloud: '#5a3b46' },
  sad: { top: '#5d6b84', mid: '#8995a8', horizon: '#b3bfcc', fog: '#a8b3c0', sun: '#c8d6ff', sunI: 1.0, hemiSky: '#aab8cc', hemiGround: '#4d5a5e', hemiI: 0.95, cloud: '#9aa5b3' },
};
for (const k in LOOKS) for (const p in LOOKS[k]) if (typeof LOOKS[k][p] === 'string') LOOKS[k][p] = new THREE.Color(LOOKS[k][p]);

function blendLook(w, out) {
  // w: {rest, happy, angry, sad} summing to 1
  for (const p in LOOKS.rest) {
    if (LOOKS.rest[p].isColor) {
      out[p] = out[p] || new THREE.Color();
      out[p].setRGB(0, 0, 0);
      for (const k in w) out[p].r += LOOKS[k][p].r * w[k], out[p].g += LOOKS[k][p].g * w[k], out[p].b += LOOKS[k][p].b * w[k];
    } else {
      out[p] = 0;
      for (const k in w) out[p] += LOOKS[k][p] * w[k];
    }
  }
  return out;
}

function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 30, 64, 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// smooth petal: a subdivided plane bent into a cupped teardrop
function petalGeometry(len = 1, wid = 0.42, cup = 0.28, cross = 0.12) {
  const g = new THREE.PlaneGeometry(1, 1, 6, 10);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i); // -0.5..0.5
    const v = p.getY(i) + 0.5; // 0..1
    const hw = wid * Math.sin(Math.PI * Math.pow(v, 0.72)) * (1 - 0.15 * v);
    const x = u * 2 * hw;
    const y = v * len;
    const z = cup * v * v + cross * (u * 2) * (u * 2) * Math.sin(Math.PI * v);
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function leafGeometry() {
  const g = petalGeometry(0.9, 0.2, 0.25, 0.06);
  g.rotateX(-0.2);
  return g;
}

// ---------- Garden ----------
export class Garden {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xebe3d5, 30, 95);
    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera.position.set(0, 9, 24);

    this.root = new THREE.Group(); // tilts with the head
    this.scene.add(this.root);

    this.look = blendLook({ rest: 1, happy: 0, angry: 0, sad: 0 }, {});
    this.glowTex = glowTexture();

    this.t = 0;
    this.wind = 0.15;
    this.windDir = new THREE.Vector2(1, 0.3).normalize();
    this.windAngle = 0.3;
    this.gust = 0;
    this.growth = 0.35;
    this.bloomBase = 0.3;
    this.droop = 0;
    this.flash = 0;
    this.nextLightning = 3;
    this.pulses = [];
    this.camOrbit = { az: 0, el: 0.4, dist: 33 };
    this.handsWorld = [];

    this._buildSky();
    this._buildLights();
    this._buildIsland();
    this._buildGrass();
    this._buildTrees();
    this._buildFlowers();
    this._buildLanterns();
    this._buildClouds();
    this._buildIslets();
    this._buildParticles();
    this._buildPetals();
    this._buildRain();
    this._buildPulseRing();
    this._buildHandWisps();

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the island framed on tall phone screens
    this.camera.fov = w / h < 0.8 ? 58 : 42;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- build
  _buildSky() {
    const geo = new THREE.SphereGeometry(220, 48, 24);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uMid: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uFlash: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uMid, uHorizon;
        uniform float uFlash, uTime;
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        void main() {
          float y = vDir.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(-0.05, 0.22, y));
          col = mix(col, uTop, smoothstep(0.18, 0.75, y));
          col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.4, y));
          // soft painterly streaks
          float n = noise(vec2(atan(vDir.z, vDir.x) * 3.0 + uTime * 0.01, y * 6.0));
          col *= 0.97 + 0.05 * n;
          col += uFlash * vec3(1.0, 0.92, 0.95) * (0.6 + 0.4 * smoothstep(0.0, 0.6, y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xe9ecf2, 0x7d8f73, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.3);
    this.sun.position.set(-12, 20, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -17; sc.right = 17; sc.top = 17; sc.bottom = -17; sc.near = 1; sc.far = 60;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun);
    this.fill = new THREE.PointLight(0xffd9c2, 0, 30, 1.5); // warm glow that rises with smiles
    this.fill.position.set(0, 5, 2);
    this.root.add(this.fill);
  }

  _buildIsland() {
    // top surface: ring geometry for nice radial vertex distribution
    const top = new THREE.RingGeometry(0.001, ISLAND_R, 120, 36);
    top.rotateX(-Math.PI / 2);
    const p = top.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const cA = new THREE.Color(PALETTE.sage), cB = new THREE.Color(PALETTE.sageDeep), cC = new THREE.Color('#b9c49a');
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, groundHeight(x, z));
      const n = 0.5 + 0.5 * Math.sin(x * 0.5 + Math.cos(z * 0.4) * 2.0);
      c.copy(cA).lerp(cB, n * 0.55).lerp(cC, clamp01(Math.sin(z * 0.3 + x * 0.12)) * 0.25);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    top.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    top.computeVertexNormals();
    const topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    topMesh.receiveShadow = true;
    this.root.add(topMesh);

    // earthy underside: inverted, lumpy cone
    const under = new THREE.ConeGeometry(ISLAND_R + 0.05, 9, 96, 14, true);
    under.rotateX(Math.PI);
    under.translate(0, -4.5 - 0.25, 0);
    const up = under.attributes.position;
    const ucol = new Float32Array(up.count * 3);
    const e1 = new THREE.Color('#a39184'), e2 = new THREE.Color('#6d625f'), e3 = new THREE.Color('#8a9a78');
    for (let i = 0; i < up.count; i++) {
      const x = up.getX(i), y = up.getY(i), z = up.getZ(i);
      const a = Math.atan2(z, x);
      const t = clamp01(-y / 9);
      const lump = 1 + (0.07 * Math.sin(a * 7 + y * 1.3) + 0.04 * Math.sin(a * 13 - y * 2.1)) * Math.min(1, t * 3);
      const r = Math.hypot(x, z) * (t < 0.03 ? 1 : lump);
      up.setX(i, Math.cos(a) * r);
      up.setZ(i, Math.sin(a) * r);
      if (t < 0.03) up.setY(i, groundHeight(Math.cos(a) * r * 0.999, Math.sin(a) * r * 0.999) - 0.02);
      c.copy(e3).lerp(e1, clamp01(t * 6)).lerp(e2, clamp01(t * 1.3 - 0.25));
      ucol.set([c.r, c.g, c.b], i * 3);
    }
    under.setAttribute('color', new THREE.BufferAttribute(ucol, 3));
    under.computeVertexNormals();
    const underMesh = new THREE.Mesh(under, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false }));
    this.root.add(underMesh);

    // a few smooth stones
    const stoneMat = new THREE.MeshStandardMaterial({ color: '#d9d2c4', roughness: 0.8 });
    for (let i = 0; i < 9; i++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(rr(0.25, 0.6), 2), stoneMat);
      const a = rr(0, Math.PI * 2), r = rr(3, 12.5);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      s.position.set(x, groundHeight(x, z) + 0.05, z);
      s.scale.set(1, rr(0.45, 0.7), rr(0.8, 1.2));
      s.rotation.y = rr(0, 3);
      s.castShadow = true;
      s.receiveShadow = true;
      this.root.add(s);
    }
  }

  _sharedUniforms() {
    if (this.U) return this.U;
    this.U = {
      uTime: { value: 0 },
      uWind: { value: 0.15 },
      uWindDir: { value: this.windDir },
      uDroop: { value: 0 },
      uGrow: { value: 1 },
      uPulse: { value: new THREE.Vector4(0, 0, -100, 0) }, // x,z center, radius, amp
      uHand0: { value: new THREE.Vector4(0, -100, 0, 0) },
      uHand1: { value: new THREE.Vector4(0, -100, 0, 0) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) },
    };
    return this.U;
  }

  _buildGrass() {
    const COUNT = window.innerWidth < 700 ? 5000 : 9000;
    const blade = new THREE.PlaneGeometry(0.07, 1, 1, 4);
    blade.translate(0, 0.5, 0);
    // taper
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i);
      bp.setX(i, bp.getX(i) * (1 - y * 0.92));
    }
    const U = this._sharedUniforms();
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uBase: { value: new THREE.Color(PALETTE.deepGreen) },
        uTip: { value: new THREE.Color('#c9d3a8') },
      }]),
      vertexShader: /* glsl */ `
        uniform float uTime, uWind, uDroop, uGrow;
        uniform vec2 uWindDir;
        uniform vec4 uPulse, uHand0, uHand1;
        varying float vH;
        varying vec3 vTint;
        #include <fog_pars_vertex>
        vec2 handPush(vec4 h, vec2 base) {
          vec2 d = base - h.xz;
          float f = exp(-dot(d, d) / 5.0) * h.w;
          return normalize(d + 1e-4) * -f * 0.9; // + strength leans toward hand
        }
        void main() {
          float h = uv.y;
          vec3 p = position;
          p.y *= uGrow;
          vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 wp = instanceMatrix * vec4(p, 1.0);
          float bend = h * h;
          float ph = base.x * 0.35 + base.z * 0.27;
          float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.3 + ph * 2.1) * 0.25;
          float gustWave = sin(dot(base.xz, uWindDir) * 0.45 - uTime * (1.5 + uWind * 2.5)) * 0.5 + 0.5;
          vec2 disp = uWindDir * (0.05 + uWind * (0.35 + 0.45 * gustWave)) + vec2(sway, sway * 0.6) * (0.05 + uWind * 0.12);
          float d = length(base.xz - uPulse.xy);
          float ring = exp(-pow((d - uPulse.z) * 0.9, 2.0)) * uPulse.w;
          disp += normalize(base.xz - uPulse.xy + 1e-4) * ring * 0.7;
          disp += handPush(uHand0, base.xz) + handPush(uHand1, base.xz);
          wp.xz += disp * bend;
          wp.y -= (dot(disp, disp) * 0.35 + uDroop * 0.3) * bend;
          wp.y += ring * 0.15 * h;
          vH = h;
          vTint = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #endif
          vTint += ring * 0.25;
          vec4 mvPosition = modelViewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase, uTip, uLight, uAmb;
        varying float vH;
        varying vec3 vTint;
        #include <fog_pars_fragment>
        void main() {
          vec3 col = mix(uBase, uTip, smoothstep(0.0, 1.0, vH)) * vTint;
          col *= uAmb + uLight * (0.35 + 0.65 * vH);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    // share live uniforms with the rest of the garden
    Object.assign(mat.uniforms, U);
    this.grassMat = mat;

    const mesh = new THREE.InstancedMesh(blade, mat, COUNT);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
    const e = new THREE.Euler();
    const col = new THREE.Color();
    const tints = ['#ffffff', '#f2f0d0', '#e6efd9', '#f3e2e6', '#e9e4f5'];
    for (let i = 0; i < COUNT; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (ISLAND_R - 0.6);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // clumps: denser and taller in patches
      const clump = 0.5 + 0.5 * Math.sin(x * 0.7) * Math.cos(z * 0.6);
      pos.set(x, groundHeight(x, z) - 0.02, z);
      e.set(rr(-0.15, 0.15), rr(0, Math.PI), rr(-0.15, 0.15));
      q.setFromEuler(e);
      const hgt = rr(0.35, 0.8) * (0.7 + clump * 0.8) * (r > ISLAND_R - 2 ? 0.6 : 1);
      s.set(rr(0.8, 1.4), hgt, 1);
      m.compose(pos, q, s);
      mesh.setMatrixAt(i, m);
      col.set(rand() < 0.82 ? '#ffffff' : pick(tints));
      mesh.setColorAt(i, col);
    }
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.grass = mesh;
  }

  _buildTrees() {
    this.trees = [];
    const spots = [
      [-8.2, -4.5, 1.25], [7.6, -6.2, 1.1], [-3.5, -9.3, 0.95], [9.8, 2.6, 0.85], [-10.4, 3.4, 0.8], [2.8, -10.2, 0.75],
    ];
    const canopyColors = [
      [PALETTE.lavender, PALETTE.lilac, PALETTE.pink],
      [PALETTE.pink, PALETTE.rose, PALETTE.ivory],
      [PALETTE.sage, '#b6c8a6', PALETTE.butter],
      [PALETTE.butter, PALETTE.yellow, PALETTE.ivory],
    ];
    const barkMat = new THREE.MeshStandardMaterial({ color: '#8e7b74', roughness: 0.9 });
    spots.forEach(([x, z, sc], i) => {
      const tree = new THREE.Group();
      tree.position.set(x, groundHeight(x, z) - 0.1, z);
      tree.scale.setScalar(sc * 0.82);
      // curvy, tapered trunk
      const h = rr(4.2, 5.6);
      const bendA = rr(0, Math.PI * 2);
      const pts = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        pts.push(new THREE.Vector3(Math.cos(bendA) * Math.sin(t * 2.4) * 0.7, t * h, Math.sin(bendA) * Math.sin(t * 2.4) * 0.7));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tg = new THREE.TubeGeometry(curve, 24, 0.24, 10, false);
      const tp = tg.attributes.position;
      const center = new THREE.Vector3();
      for (let ring = 0; ring <= 24; ring++) {
        const t = ring / 24;
        curve.getPointAt(t, center);
        const taper = 1.15 - 0.75 * t;
        for (let j = 0; j <= 10; j++) {
          const idx = ring * 11 + j;
          tp.setXYZ(idx, center.x + (tp.getX(idx) - center.x) * taper, center.y + (tp.getY(idx) - center.y) * taper, center.z + (tp.getZ(idx) - center.z) * taper);
        }
      }
      tg.computeVertexNormals();
      const trunk = new THREE.Mesh(tg, barkMat);
      trunk.castShadow = true;
      tree.add(trunk);

      // a couple of thin branches
      const top = curve.getPointAt(1);
      const canopy = new THREE.Group();
      canopy.position.copy(top);
      tree.add(canopy);
      const cols = canopyColors[i % canopyColors.length];
      const blobs = [];
      const nBlobs = 6 + Math.floor(rand() * 4);
      for (let b = 0; b < nBlobs; b++) {
        const r = rr(0.9, 1.7) * (b === 0 ? 1.4 : 1);
        const mat = new THREE.MeshStandardMaterial({ color: pick(cols), roughness: 0.85, emissive: new THREE.Color(cols[0]), emissiveIntensity: 0.06 });
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 3), mat);
        const a = rr(0, Math.PI * 2), d = b === 0 ? 0 : rr(0.9, 2.1);
        blob.position.set(Math.cos(a) * d, rr(-0.4, 1.4) + (b === 0 ? 0.4 : 0), Math.sin(a) * d);
        blob.scale.set(1, rr(0.75, 0.95), 1);
        blob.castShadow = true;
        blob.receiveShadow = true;
        blob.userData = { base: blob.position.clone(), phase: rr(0, 6), r };
        canopy.add(blob);
        blobs.push(blob);
      }
      // surreal touch: a few detached floating blobs above the canopy
      for (let b = 0; b < 2; b++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(rr(0.25, 0.45), 2), new THREE.MeshStandardMaterial({ color: pick(cols), roughness: 0.7, emissive: new THREE.Color(cols[0]), emissiveIntensity: 0.12 }));
        blob.position.set(rr(-1.5, 1.5), rr(2.6, 3.6), rr(-1.5, 1.5));
        blob.userData = { base: blob.position.clone(), phase: rr(0, 6), float: true };
        blob.castShadow = true;
        canopy.add(blob);
        blobs.push(blob);
      }
      this.root.add(tree);
      this.trees.push({ group: tree, canopy, blobs, trunk, phase: rr(0, 6), h, pos: new THREE.Vector2(x, z) });
    });
  }

  _makeFlower(type, x, z, scale, planted = false) {
    const g = new THREE.Group();
    g.position.set(x, groundHeight(x, z) - 0.05, z);
    const stemH = rr(1.0, 1.9) * (type.tall ? 1.4 : 1);
    const stemMat = this._stemMat ||= new THREE.MeshStandardMaterial({ color: '#6e8f63', roughness: 0.8 });
    const stem = new THREE.Mesh(this._stemGeo ||= (() => { const s = new THREE.CylinderGeometry(0.025, 0.04, 1, 6, 1); s.translate(0, 0.5, 0); return s; })(), stemMat);
    stem.scale.y = stemH;
    stem.castShadow = true;
    g.add(stem);

    const leafMat = this._leafMat ||= new THREE.MeshStandardMaterial({ color: '#86a679', roughness: 0.7, side: THREE.DoubleSide });
    this._leafGeo ||= leafGeometry();
    for (let i = 0; i < 2; i++) {
      const lp = new THREE.Group();
      lp.position.y = stemH * rr(0.18, 0.45);
      lp.rotation.y = i * Math.PI + rr(-0.4, 0.4);
      const leaf = new THREE.Mesh(this._leafGeo, leafMat);
      leaf.rotation.x = 0.9;
      leaf.scale.setScalar(rr(0.45, 0.7));
      lp.add(leaf);
      g.add(lp);
    }

    const head = new THREE.Group();
    head.position.y = stemH;
    g.add(head);
    const center = new THREE.Mesh(this._centerGeo ||= new THREE.SphereGeometry(0.12, 14, 10), type.centerMat);
    center.scale.set(1, 0.7, 1);
    center.castShadow = true;
    head.add(center);

    const pivots = [];
    const layers = [
      { n: type.petals, len: type.len, tiltOpen: type.openTilt, tiltClosed: 0.12, mat: type.mat },
      { n: Math.max(4, type.petals - 3), len: type.len * 0.68, tiltOpen: type.openTilt * 0.62, tiltClosed: 0.05, mat: type.innerMat },
    ];
    layers.forEach((L, li) => {
      const geo = type.geo[li];
      for (let i = 0; i < L.n; i++) {
        const yaw = new THREE.Group();
        yaw.rotation.y = (i / L.n) * Math.PI * 2 + li * 0.4;
        const pivot = new THREE.Group();
        pivot.position.y = 0.03;
        const petal = new THREE.Mesh(geo, L.mat);
        petal.scale.setScalar(L.len);
        pivot.add(petal);
        yaw.add(pivot);
        head.add(yaw);
        pivots.push({ pivot, open: L.tiltOpen + rr(-0.08, 0.08), closed: L.tiltClosed + rr(0, 0.05), jitter: rr(0, 6) });
      }
    });

    g.scale.setScalar(planted ? 0.001 : scale);
    this.root.add(g);
    return {
      group: g, head, pivots, stemH, type, scale,
      phase: rr(0, Math.PI * 2),
      bloom: 0.25,
      tau: rr(0.5, 1.6) + Math.hypot(x, z) * 0.06,
      pos: new THREE.Vector2(x, z),
      bump: 0,
      lean: new THREE.Vector2(),
      born: planted ? this.t : -100,
      planted,
    };
  }

  _buildFlowers() {
    const mk = (petalCol, innerCol, centerCol, petals, len, openTilt, shape, extra = {}) => ({
      petals, len, openTilt,
      mat: new THREE.MeshStandardMaterial({ color: petalCol, roughness: 0.55, side: THREE.DoubleSide, emissive: new THREE.Color(petalCol), emissiveIntensity: 0.12 }),
      innerMat: new THREE.MeshStandardMaterial({ color: innerCol, roughness: 0.55, side: THREE.DoubleSide, emissive: new THREE.Color(innerCol), emissiveIntensity: 0.14 }),
      centerMat: new THREE.MeshStandardMaterial({ color: centerCol, roughness: 0.6, emissive: new THREE.Color(centerCol), emissiveIntensity: 0.2 }),
      geo: [petalGeometry(1, shape[0], shape[1], shape[2]), petalGeometry(1, shape[0] * 0.9, shape[1] * 1.3, shape[2])],
      ...extra,
    });
    this.flowerTypes = [
      mk(PALETTE.pink, '#f7dde0', '#e9c46a', 8, 0.55, 1.35, [0.38, 0.25, 0.12]), // cosmos
      mk(PALETTE.lavender, '#ddd5f2', PALETTE.yellow, 6, 0.6, 1.2, [0.42, 0.35, 0.16], { tall: true }), // tulip-ish
      mk(PALETTE.yellow, PALETTE.butter, '#c98f5a', 5, 0.5, 1.45, [0.5, 0.22, 0.1]), // buttercup
      mk(PALETTE.ivory, '#fbf6ea', '#e6c46e', 11, 0.5, 1.5, [0.2, 0.15, 0.05]), // daisy
      mk(PALETTE.rose, PALETTE.pink, '#f1d38b', 7, 0.48, 1.25, [0.45, 0.4, 0.18]), // rose cup
    ];
    this.flowers = [];
    const avoid = this.trees.map((t) => t.pos);
    let tries = 0;
    while (this.flowers.length < 34 && tries++ < 2000) {
      const a = rand() * Math.PI * 2;
      const r = 1.2 + Math.sqrt(rand()) * 10.8;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (avoid.some((p) => Math.hypot(p.x - x, p.y - z) < 1.8)) continue;
      if (this.flowers.some((f) => f.pos.distanceTo(new THREE.Vector2(x, z)) < 1.1)) continue;
      // flowers cluster by type in drifts
      const typeIdx = Math.abs(Math.floor((Math.sin(x * 0.25) + Math.cos(z * 0.3) + 2) * 1.25 + rand() * 1.2)) % this.flowerTypes.length;
      this.flowers.push(this._makeFlower(this.flowerTypes[typeIdx], x, z, rr(0.85, 1.25)));
    }
    this.planted = [];
  }

  _buildLanterns() {
    // surreal glowing seed pods on tall stems
    this.lanterns = [];
    const stemMat = new THREE.MeshStandardMaterial({ color: '#7d9a73', roughness: 0.8 });
    for (let i = 0; i < 11; i++) {
      const a = rr(0, Math.PI * 2), r = rr(3, 12);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this.trees.some((t) => Math.hypot(t.pos.x - x, t.pos.y - z) < 2)) continue;
      const g = new THREE.Group();
      g.position.set(x, groundHeight(x, z) - 0.05, z);
      const h = rr(2.4, 3.8);
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(rr(-0.4, 0.4), h * 0.55, rr(-0.4, 0.4)), new THREE.Vector3(rr(-0.2, 0.2), h, rr(-0.2, 0.2)));
      const stem = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.03, 5, false), stemMat);
      stem.castShadow = true;
      g.add(stem);
      const col = pick([PALETTE.butter, PALETTE.pink, PALETTE.lavender]);
      const pod = new THREE.Mesh(new THREE.SphereGeometry(rr(0.16, 0.24), 16, 12), new THREE.MeshStandardMaterial({ color: col, emissive: new THREE.Color(col), emissiveIntensity: 0.6, roughness: 0.4 }));
      pod.position.copy(curve.getPoint(1));
      pod.scale.set(1, 1.25, 1);
      g.add(pod);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: col, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(1.3);
      halo.position.copy(pod.position);
      g.add(halo);
      this.root.add(g);
      this.lanterns.push({ group: g, pod, halo, phase: rr(0, 6), pos: new THREE.Vector2(x, z) });
    }
  }

  _buildClouds() {
    this.clouds = new THREE.Group();
    this.cloudMat = new THREE.MeshStandardMaterial({ color: '#fbf7ef', roughness: 1, transparent: true, opacity: 0.93, emissive: new THREE.Color('#fff'), emissiveIntensity: 0.18 });
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    this.cloudList = [];
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Group();
      const n = 5 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const s = new THREE.Mesh(sphere, this.cloudMat);
        const r = rr(0.9, 1.8) * (k === 0 ? 1.3 : 1);
        s.scale.set(r * 1.25, r * 0.8, r);
        s.position.set(rr(-2.4, 2.4), rr(-0.2, 0.6), rr(-1, 1));
        s.castShadow = true;
        c.add(s);
      }
      const a = (i / 9) * Math.PI * 2 + rr(-0.3, 0.3);
      const r = i < 3 ? rr(7, 12) : rr(38, 55);
      c.userData = { a, r, y: i < 3 ? rr(12.5, 14.5) : rr(4, 16), speed: rr(0.6, 1.2), phase: rr(0, 6) };
      c.scale.setScalar(i < 3 ? rr(0.6, 0.85) : rr(1.6, 2.6));
      this.clouds.add(c);
      this.cloudList.push(c);
    }
    this.scene.add(this.clouds);
  }

  _buildIslets() {
    this.islets = [];
    const rock = new THREE.MeshStandardMaterial({ color: '#8a7f78', roughness: 1 });
    const turf = new THREE.MeshStandardMaterial({ color: PALETTE.sage, roughness: 0.95 });
    const spots = [[-34, 2, -30, 2.2], [36, 6, -38, 3], [-46, -3, 8, 2.6], [30, -6, 22, 1.6], [8, 9, -52, 2.4]];
    for (const [x, y, z, s] of spots) {
      const g = new THREE.Group();
      const c = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3, 9), rock);
      c.rotation.x = Math.PI;
      c.position.y = -1.5;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.6, 0.35, 18), turf);
      g.add(c, top);
      const tb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 2), new THREE.MeshStandardMaterial({ color: pick([PALETTE.pink, PALETTE.lavender, PALETTE.butter]), roughness: 0.9 }));
      tb.position.set(0.2, 1.6, 0);
      const tt = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.4, 6), rock);
      tt.position.set(0.2, 0.8, 0);
      g.add(tb, tt);
      g.position.set(x, y, z);
      g.scale.setScalar(s);
      g.userData = { y, phase: rr(0, 6) };
      this.scene.add(g);
      this.islets.push(g);
    }
  }

  _buildParticles() {
    const N = window.innerWidth < 700 ? 450 : 750;
    this.pN = N;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), seedA = new Float32Array(N);
    this.pVel = new Float32Array(N * 3);
    const cols = [PALETTE.butter, PALETTE.yellow, PALETTE.ivory, PALETTE.pink, PALETTE.lavender].map((c) => new THREE.Color(c));
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 15;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rr(0.4, 9);
      pos[i * 3 + 2] = Math.sin(a) * r;
      const c = pick(cols);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = rr(0.6, 1.6) * (rand() < 0.08 ? 2.2 : 1);
      seedA[i] = rand() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    this.pMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: window.innerHeight * 0.5 },
        uBright: { value: 0.7 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uPulse: this._sharedUniforms().uPulse,
      },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aSeed; attribute vec3 color;
        uniform float uTime, uScale, uBright; uniform vec4 uPulse;
        varying vec3 vCol; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float tw = 0.65 + 0.35 * sin(uTime * (1.2 + fract(aSeed) * 2.0) + aSeed);
          float d = length(position.xz - uPulse.xy);
          float ring = exp(-pow((d - uPulse.z) * 0.7, 2.0)) * uPulse.w;
          gl_PointSize = aSize * (0.11 + ring * 0.12) * uScale / -mv.z;
          vCol = color;
          vA = (tw * uBright + ring * 0.8);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        varying vec3 vCol; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          a = a * a;
          gl_FragColor = vec4(vCol * uTint * (0.6 + a), a * vA);
          #include <colorspace_fragment>
        }`,
    });
    this.particles = new THREE.Points(geo, this.pMat);
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
  }

  _buildPetals() {
    const N = 420;
    this.petalN = N;
    const geo = petalGeometry(0.22, 0.1, 0.05, 0.03);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.1 });
    this.petalMesh = new THREE.InstancedMesh(geo, mat, N);
    this.petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.petalMesh.frustumCulled = false;
    this.petalMesh.castShadow = false;
    const cols = [PALETTE.pink, PALETTE.rose, PALETTE.lavender, PALETTE.ivory, PALETTE.butter].map((c) => new THREE.Color(c));
    this.petals = [];
    for (let i = 0; i < N; i++) {
      this.petalMesh.setColorAt(i, pick(cols));
      this.petals.push({ active: false, p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), life: 0, landed: 0, scale: 1, ambient: i < 36 });
    }
    this.petalMesh.instanceColor.needsUpdate = true;
    this.root.add(this.petalMesh);
    this._pm = new THREE.Matrix4();
    this._pq = new THREE.Quaternion();
    this._ps = new THREE.Vector3();
    // ambient drifting petals
    for (let i = 0; i < 36; i++) this._spawnPetal(this.petals[i], true);
  }

  _spawnPetal(pt, ambient = false, origin = null) {
    pt.active = true;
    if (origin) {
      pt.p.copy(origin).add(new THREE.Vector3(rr(-1.6, 1.6), rr(-0.5, 0.8), rr(-1.6, 1.6)));
    } else {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 12;
      pt.p.set(Math.cos(a) * r, ambient ? rr(1, 10) : rr(6, 10), Math.sin(a) * r);
    }
    pt.v.set(rr(-0.3, 0.3), rr(-0.7, -0.35), rr(-0.3, 0.3));
    pt.rot.set(rr(0, 6), rr(0, 6), rr(0, 6));
    pt.spin.set(rr(-2, 2), rr(-2, 2), rr(-2, 2));
    pt.life = 0;
    pt.landed = 0;
    pt.scale = rr(0.7, 1.3);
    pt.flutter = rr(0, 6);
  }

  _buildRain() {
    const N = 1600;
    this.rainN = N;
    const pos = new Float32Array(N * 6);
    this.rainDrops = new Float32Array(N * 4); // x, y, z, speed
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 22;
      this.rainDrops.set([Math.cos(a) * r, rr(0, 20), Math.sin(a) * r, rr(13, 18)], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: '#f2f6ff', transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  _buildPulseRing() {
    this.pulseMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uAmp: { value: 0 }, uColor: { value: new THREE.Color('#fff2d6') } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAmp; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float d = length(vUv - 0.5) * 2.0;
          float ring = exp(-pow((d - 0.94) * 22.0, 2.0)) + 0.35 * exp(-pow((d - 0.86) * 14.0, 2.0));
          float inner = smoothstep(1.0, 0.0, d) * 0.08;
          gl_FragColor = vec4(uColor, (ring + inner) * uAmp);
          #include <colorspace_fragment>
        }`,
    });
    this.pulseRing = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pulseMat);
    this.pulseRing.rotation.x = -Math.PI / 2;
    this.pulseRing.position.y = 0.7;
    this.pulseRing.visible = false;
    this.root.add(this.pulseRing);
  }

  _buildHandWisps() {
    this.wisps = [0, 1].map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: '#f7d98a', transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      s.scale.setScalar(2);
      s.renderOrder = 10;
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: '#fffaf0', transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      core.renderOrder = 11;
      core.scale.setScalar(0.6);
      this._ringTex ||= ringTexture();
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._ringTex, color: '#f2d27a', transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      ring.renderOrder = 12;
      this.root.add(s, core, ring);
      return { s, core, ring, pos: new THREE.Vector3(0, 3, 0), strength: 0, seen: false };
    });
  }

  // ---------------------------------------------------------------- events
  blink() {
    // a subtle drift of petals from the canopies and the sky
    let n = 0;
    const want = 42;
    for (const pt of this.petals) {
      if (n >= want) break;
      if (pt.ambient || pt.active) continue;
      const tree = rand() < 0.55 ? pick(this.trees) : null;
      let origin = null;
      if (tree) {
        origin = new THREE.Vector3();
        tree.canopy.getWorldPosition(origin);
        this.root.worldToLocal(origin);
      }
      this._spawnPetal(pt, false, origin);
      n++;
    }
  }

  pulse(strength = 1, cx = 0, cz = 0) {
    this.pulses.push({ t: 0, strength, cx, cz });
    if (this.pulses.length > 3) this.pulses.shift();
  }

  plantAtScreen(nx, ny) {
    // nx, ny: normalised screen coords (0..1, y down)
    const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) {
      // pointing at the sky: plant along the ray direction on the ground
      hit.set(ray.ray.direction.x, 0, ray.ray.direction.z).normalize().multiplyScalar(8);
    }
    this.root.worldToLocal(hit);
    const r = Math.hypot(hit.x, hit.z);
    if (r > 12) hit.multiplyScalar(12 / r);
    return this.plantAt(hit.x, hit.z);
  }

  plantAt(x, z) {
    if (this.planted.length >= 18) {
      const old = this.planted.shift();
      old.dying = true;
    }
    const f = this._makeFlower(pick(this.flowerTypes), x, z, rr(0.95, 1.25), true);
    f.bloom = 0;
    this.planted.push(f);
    this.flowers.push(f);
    // a little puff of petals + light where it lands
    this.pulse(0.35, x, z);
    return f;
  }

  reset() {
    for (const f of this.flowers) if (f.planted) f.dying = true;
    this.planted = [];
    for (const pt of this.petals) if (!pt.ambient) pt.active = false;
    this.growth = 0.35;
    for (const f of this.flowers) f.bloom = 0.2;
    this.pulses = [];
    this.gust = 0;
    this.flash = 0;
  }

  // ---------------------------------------------------------------- update
  update(dt, m) {
    // m: mood object { smile, brow, mouth, angry, sad, roll, yaw, pitch, fx, fy, hands:[], handGust }
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const t = this.t;
    const U = this.U;
    const breath = Math.sin(t * 0.55) * 0.5 + 0.5;

    // ---- weather + mood mixing ----
    const happy = m.smile, angry = m.angry, sad = m.sad;
    let sum = happy + angry + sad;
    const k = sum > 1 ? 1 / sum : 1;
    const w = { happy: happy * k, angry: angry * k, sad: sad * k };
    w.rest = Math.max(0, 1 - w.happy - w.angry - w.sad);
    blendLook(w, this.look);
    const L = this.look;

    // lightning when angry
    if (angry > 0.45) {
      this.nextLightning -= dt * (0.6 + angry);
      if (this.nextLightning <= 0) {
        this.flash = 0.6 + angry * 0.5;
        this.nextLightning = rr(2.2, 5.5);
        this.onLightning?.(this.flash);
      }
    } else this.nextLightning = Math.max(this.nextLightning, 1.5);
    this.flash = Math.max(0, this.flash - dt * 2.6);
    const flash = this.flash > 0.55 ? this.flash : this.flash * (0.5 + 0.5 * Math.sin(t * 60)); // flicker
    this.flashLevel = Math.max(0, flash);

    this.skyMat.uniforms.uTop.value.copy(L.top);
    this.skyMat.uniforms.uMid.value.copy(L.mid);
    this.skyMat.uniforms.uHorizon.value.copy(L.horizon);
    this.skyMat.uniforms.uFlash.value = this.flashLevel * 0.6;
    this.skyMat.uniforms.uTime.value = t;
    this.scene.fog.color.copy(L.fog);
    this.scene.fog.near = lerp(30, 18, sad * 0.8 + angry * 0.4);
    this.scene.fog.far = lerp(95, 60, sad * 0.7 + angry * 0.3);
    this.sun.color.copy(L.sun);
    this.sun.intensity = L.sunI * (0.97 + 0.03 * breath) + this.flashLevel * 3;
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    this.hemi.intensity = L.hemiI + this.flashLevel * 2;
    this.fill.intensity = happy * 18 + 1.5 * breath;
    this.cloudMat.color.copy(L.cloud);
    this.cloudMat.emissive.copy(L.cloud).multiplyScalar(0.25 + this.flashLevel);
    // sun drifts warmer + lower when happy
    this.sun.position.set(-12 + happy * 3, 20 - happy * 3 + sad * 2, 10);

    // grass lighting uniforms approximate the scene lights
    U.uLight.value.copy(L.sun).multiplyScalar(L.sunI * 0.32 + this.flashLevel * 0.6);
    U.uAmb.value.copy(L.hemiSky).multiplyScalar(L.hemiI * 0.38).lerp(L.hemiGround, 0.25);

    // ---- wind ----
    const gustNoise = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3);
    const storm = angry * (0.7 + 0.9 * gustNoise);
    this.gust = Math.max(0, this.gust - dt * 0.6);
    this.gust = Math.max(this.gust, m.handGust || 0);
    const windTarget = 0.12 + 0.05 * breath + m.brow * 1.25 + storm * 1.1 + this.gust + sad * 0.1;
    this.wind = damp(this.wind, windTarget, windTarget > this.wind ? 0.6 : 1.4, dt);
    this.windAngle += dt * (0.03 + angry * 0.5 * Math.sin(t * 0.4));
    this.windDir.set(Math.cos(this.windAngle), Math.sin(this.windAngle) * 0.6).normalize();
    U.uWind.value = this.wind;
    U.uTime.value = t;

    // ---- growth / droop ----
    const growTarget = 0.35 + happy * 0.65 - sad * 0.15;
    this.growth = damp(this.growth, growTarget, growTarget > this.growth ? 3.5 : 7, dt);
    U.uGrow.value = 0.8 + this.growth * 0.45 - sad * 0.1;
    this.droop = damp(this.droop, sad, 1.5, dt);
    U.uDroop.value = this.droop;

    // ---- pulses ----
    let pr = -100, pa = 0, pcx = 0, pcz = 0;
    for (const p of this.pulses) p.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < 3.2);
    const P = this.pulses[this.pulses.length - 1];
    if (P) {
      pr = P.t * (P.strength > 0.5 ? 9 : 5);
      pa = P.strength * Math.pow(1 - P.t / 3.2, 1.5);
      pcx = P.cx; pcz = P.cz;
      this.pulseRing.visible = true;
      this.pulseRing.position.set(pcx, 0.7, pcz);
      this.pulseRing.scale.setScalar(Math.max(0.01, pr));
      this.pulseMat.uniforms.uAmp.value = pa * 0.9;
    } else this.pulseRing.visible = false;
    U.uPulse.value.set(pcx, pcz, pr, pa);

    // ---- hands in garden space ----
    this.handsWorld = [];
    const handVecs = [U.uHand0.value, U.uHand1.value];
    for (let i = 0; i < 2; i++) {
      const h = m.hands[i];
      const W = this.wisps[i];
      if (h) {
        const wp = this._screenToGarden(h.x, h.y, W.pos);
        const strength = h.gesture === 'open' ? 1 : h.gesture === 'fist' ? -1 : h.gesture === 'pinch' ? 0.5 : 0.35;
        W.strength = damp(W.strength, strength, 0.25, dt);
        W.seen = true;
        handVecs[i].set(wp.x, wp.y, wp.z, W.strength);
        this.handsWorld.push({ p: wp, s: W.strength });
        const col = h.gesture === 'fist' ? '#de8f9f' : h.gesture === 'pinch' ? '#a996e6' : '#f2d27a';
        W.s.material.color.lerp(new THREE.Color(col), 1 - Math.exp(-dt / 0.2));
        W.s.material.opacity = damp(W.s.material.opacity, 1, 0.3, dt);
        W.core.material.opacity = damp(W.core.material.opacity, 0.9, 0.3, dt);
        const sc = 2.6 + h.open * 2.6 + Math.sin(t * 3) * 0.2;
        W.core.scale.setScalar(0.9 + h.open * 0.4);
        W.s.scale.setScalar(sc);
        W.s.position.copy(wp);
        W.core.position.copy(wp);
        W.ring.position.copy(wp);
        W.ring.material.color.copy(W.s.material.color);
        W.ring.material.opacity = damp(W.ring.material.opacity, 0.85, 0.3, dt);
        // the ring breathes slowly for an open palm, quickly for a fist
        W.ring.scale.setScalar(sc * (0.55 + 0.1 * Math.sin(t * (h.gesture === 'fist' ? 8 : 2.5))));
      } else {
        W.seen = false;
        W.strength = damp(W.strength, 0, 0.3, dt);
        handVecs[i].w = W.strength;
        W.s.material.opacity = damp(W.s.material.opacity, 0, 0.4, dt);
        W.core.material.opacity = damp(W.core.material.opacity, 0, 0.4, dt);
        W.ring.material.opacity = damp(W.ring.material.opacity, 0, 0.4, dt);
      }
    }

    // ---- flowers ----
    const bloomGlobal = clamp01(0.26 + happy * 0.74 - angry * 0.28 - sad * 0.18 + breath * 0.03);
    const tmp2 = new THREE.Vector2();
    for (let i = this.flowers.length - 1; i >= 0; i--) {
      const f = this.flowers[i];
      // pulse bump
      const d = f.pos.distanceTo(tmp2.set(pcx, pcz));
      const ring = Math.exp(-Math.pow((d - pr) * 0.9, 2)) * pa;
      f.bump = Math.max(f.bump * Math.exp(-dt * 3), ring);
      // hand influence
      let handBloom = 0;
      f.lean.multiplyScalar(Math.exp(-dt * 3));
      for (const H of this.handsWorld) {
        const dx = H.p.x - f.pos.x, dz = H.p.z - f.pos.y;
        const dd = Math.hypot(dx, dz);
        const fall = Math.exp(-(dd * dd) / 8);
        handBloom += Math.max(0, H.s) * fall * 0.5;
        f.lean.x += (dx / (dd + 0.1)) * H.s * fall * 0.2 * dt * 10;
        f.lean.y += (dz / (dd + 0.1)) * H.s * fall * 0.2 * dt * 10;
      }
      f.lean.clampLength(0, 0.45);
      const target = clamp01(bloomGlobal + f.bump * 0.6 + handBloom);
      f.bloom = damp(f.bloom, target, f.tau, dt);

      // growth (planted flowers grow in from nothing)
      let sc = f.scale * (0.82 + this.growth * 0.32);
      if (f.planted) {
        const age = t - f.born;
        sc *= THREE.MathUtils.smootherstep(age, 0, 2.2);
      }
      if (f.dying) {
        f.dieT = (f.dieT ?? 1) - dt * 0.8;
        sc *= Math.max(0, f.dieT);
        if (f.dieT <= 0) {
          this.root.remove(f.group);
          this.flowers.splice(i, 1);
          continue;
        }
      }
      f.group.scale.setScalar(Math.max(0.001, sc * (1 + f.bump * 0.12)));

      // sway: wind + breathing, organic layered sines
      const ph = f.phase + f.pos.x * 0.3 + f.pos.y * 0.2;
      const sway = Math.sin(t * 1.25 + ph) * 0.6 + Math.sin(t * 2.1 + ph * 1.7) * 0.3;
      const windLean = this.wind * (0.18 + 0.12 * Math.sin(t * 2.4 + ph));
      const lx = this.windDir.x * windLean + sway * (0.025 + this.wind * 0.06) + f.lean.x;
      const lz = this.windDir.y * windLean + sway * 0.6 * (0.025 + this.wind * 0.06) + f.lean.y;
      f.group.rotation.set(lz, 0, -lx);
      // head nods: droops with sadness, perks with pulses
      f.head.rotation.x = this.droop * 1.1 + Math.sin(t * 0.9 + ph) * 0.04 - f.bump * 0.2;
      f.head.rotation.z = -lx * 0.6;
      // petals
      const b = f.bloom;
      const ease = b * b * (3 - 2 * b);
      for (const pv of f.pivots) {
        const flutter = Math.sin(t * 3 + pv.jitter) * 0.04 * (0.4 + this.wind);
        pv.pivot.rotation.x = lerp(pv.closed, pv.open, ease) + flutter + breath * 0.03;
      }
    }

    // ---- trees ----
    for (const tr of this.trees) {
      const ph = tr.phase;
      const sw = this.wind * 0.05 + 0.012;
      tr.group.rotation.z = -this.windDir.x * this.wind * 0.04 + Math.sin(t * 0.8 + ph) * sw;
      tr.group.rotation.x = this.windDir.y * this.wind * 0.04 + Math.sin(t * 0.7 + ph * 1.3) * sw * 0.7;
      tr.canopy.rotation.y = Math.sin(t * 0.3 + ph) * 0.05;
      const d = tr.pos.distanceTo(tmp2.set(pcx, pcz));
      const ring = Math.exp(-Math.pow((d - pr) * 0.7, 2)) * pa;
      for (const bl of tr.blobs) {
        const u = bl.userData;
        const s = 1 + Math.sin(t * 0.55 + u.phase) * 0.025 + ring * 0.12 + this.growth * 0.05 - this.droop * 0.04;
        bl.scale.set(s, s * 0.88, s);
        bl.position.copy(u.base);
        bl.position.x += Math.sin(t * 1.4 + u.phase) * this.wind * 0.12;
        bl.position.y += (u.float ? Math.sin(t * 0.7 + u.phase) * 0.25 : 0) - this.droop * 0.2;
      }
    }

    // ---- lanterns ----
    for (const ln of this.lanterns) {
      const ph = ln.phase;
      const sw = Math.sin(t * 1.1 + ph) * (0.03 + this.wind * 0.08);
      ln.group.rotation.set(this.windDir.y * this.wind * 0.12 + sw * 0.6, 0, -this.windDir.x * this.wind * 0.12 - sw);
      const d = ln.pos.distanceTo(tmp2.set(pcx, pcz));
      const ring = Math.exp(-Math.pow((d - pr) * 0.8, 2)) * pa;
      const glow = 0.35 + happy * 0.9 + ring * 1.5 + Math.sin(t * 1.3 + ph) * 0.1 - sad * 0.2 - angry * 0.1;
      ln.pod.material.emissiveIntensity = Math.max(0.1, glow);
      ln.halo.material.opacity = Math.max(0.05, 0.2 + glow * 0.3);
      ln.halo.scale.setScalar(1.1 + glow * 0.7);
    }

    // ---- clouds ----
    for (const c of this.cloudList) {
      const u = c.userData;
      u.a += dt * (0.008 + this.wind * 0.05) * u.speed;
      c.position.set(Math.cos(u.a) * u.r, u.y + Math.sin(t * 0.25 + u.phase) * 0.4 - sad * 1.2 - angry * 1.5, Math.sin(u.a) * u.r);
      c.rotation.y = -u.a;
    }
    for (const g of this.islets) {
      g.position.y = g.userData.y + Math.sin(t * 0.3 + g.userData.phase) * 0.6;
      g.rotation.y += dt * 0.02;
    }

    this._updateParticles(dt, m, pr, pa, pcx, pcz);
    this._updatePetals(dt, m);
    this._updateRain(dt, sad);

    // particle look
    this.pMat.uniforms.uTime.value = t;
    this.pMat.uniforms.uBright.value = 0.45 + happy * 0.75 - sad * 0.2 + angry * 0.1;
    this.pMat.uniforms.uTint.value.setRGB(1, 1, 1).lerp(new THREE.Color(1.0, 0.55, 0.55), angry * 0.6).lerp(new THREE.Color(0.7, 0.8, 1.0), sad * 0.6);

    // ---- tilt + camera parallax ----
    const tiltZ = -m.roll * 0.45;
    this.root.rotation.z = damp(this.root.rotation.z, tiltZ, 0.35, dt);
    this.root.rotation.x = damp(this.root.rotation.x, m.pitch * 0.06, 0.5, dt);
    this.root.position.y = Math.sin(t * 0.4) * 0.12; // the island floats

    const az = Math.sin(t * 0.045) * 0.22 + m.yaw * 0.45 + m.fx * 0.3;
    const el = 0.4 + Math.sin(t * 0.06) * 0.03 + m.fy * 0.1 - m.pitch * 0.08;
    const dist = 33 - happy * 2 + angry * 1.5;
    this.camOrbit.az = damp(this.camOrbit.az, az, 0.6, dt);
    this.camOrbit.el = damp(this.camOrbit.el, el, 0.6, dt);
    this.camOrbit.dist = damp(this.camOrbit.dist, dist, 2.0, dt);
    const { az: A, el: E, dist: D } = this.camOrbit;
    const shake = this.flashLevel * 0.05;
    this.camera.position.set(Math.sin(A) * Math.cos(E) * D + rr(-shake, shake), Math.sin(E) * D + 1.5, Math.cos(A) * Math.cos(E) * D);
    this.camera.lookAt(0, 1.6, 0);
    this.camera.rotation.z += m.roll * 0.12; // a slight extra perspective roll

    this.renderer.render(this.scene, this.camera);
  }

  _screenToGarden(nx, ny, out) {
    const ndc = this._ndc ||= new THREE.Vector2();
    ndc.set(nx * 2 - 1, -(ny * 2 - 1));
    const ray = this._ray ||= new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const target = this._tgt ||= new THREE.Vector3();
    target.set(0, 3, 0);
    const normal = this._nrm ||= new THREE.Vector3();
    this.camera.getWorldDirection(normal).negate();
    const plane = this._pl ||= new THREE.Plane();
    plane.setFromNormalAndCoplanarPoint(normal, target);
    const hit = this._hit ||= new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) hit.set(0, 3, 0);
    this.root.worldToLocal(hit);
    hit.y = Math.max(hit.y, 0.6);
    // keep the wisp inside the garden bounds
    const r = Math.hypot(hit.x, hit.z);
    if (r > 15) { hit.x *= 15 / r; hit.z *= 15 / r; }
    out.lerp(hit, 0.5);
    return out;
  }

  _updateParticles(dt, m, pr, pa, pcx, pcz) {
    const pos = this.particles.geometry.attributes.position.array;
    const vel = this.pVel;
    const t = this.t;
    const activity = 0.25 + m.smile * 1.1 + m.angry * 0.9 + this.wind * 0.3;
    const wx = this.windDir.x * this.wind * 1.6, wz = this.windDir.y * this.wind * 1.6;
    const sink = m.sad * 0.35;
    const hands = this.handsWorld;
    const damping = Math.exp(-dt * 1.2);
    for (let i = 0; i < this.pN; i++) {
      const j = i * 3;
      let x = pos[j], y = pos[j + 1], z = pos[j + 2];
      // gentle flow field (layered sines behave like soft curl noise)
      let fx = Math.sin(y * 0.6 + t * 0.35 + z * 0.3) + 0.5 * Math.sin(z * 1.1 - t * 0.5);
      let fy = 0.4 * Math.sin(x * 0.5 + t * 0.3 + i) + 0.25 * Math.cos(z * 0.7 + t * 0.2);
      let fz = Math.cos(x * 0.55 - t * 0.3 + y * 0.25) + 0.5 * Math.cos(x * 0.9 + t * 0.45);
      fx *= activity; fy *= activity * 0.6; fz *= activity;
      fx += wx; fz += wz;
      fy -= sink;
      if (m.angry > 0.2) { fx += (Math.random() - 0.5) * m.angry * 6; fy += (Math.random() - 0.5) * m.angry * 3; fz += (Math.random() - 0.5) * m.angry * 6; }
      // pulse pushes outward as it passes
      if (pa > 0.01) {
        const dx = x - pcx, dz = z - pcz;
        const d = Math.hypot(dx, dz) + 1e-3;
        const ring = Math.exp(-Math.pow((d - pr) * 0.6, 2)) * pa * 14;
        fx += (dx / d) * ring; fz += (dz / d) * ring; fy += ring * 0.4;
      }
      // hands: open palm attracts with a swirl, fist repels
      for (const H of hands) {
        const dx = H.p.x - x, dy = H.p.y - y, dz = H.p.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2) + 1e-3;
        const fall = 1 / (1 + d2 * 0.12);
        let s = H.s * 9 * fall;
        if (H.s > 0 && d < 0.9) s *= d / 0.9; // don't collapse into a point
        fx += (dx / d) * s - (dz / d) * H.s * 3 * fall;
        fy += (dy / d) * s;
        fz += (dz / d) * s + (dx / d) * H.s * 3 * fall;
      }
      // soft bounds
      const r = Math.hypot(x, z);
      if (r > 16) { fx -= (x / r) * (r - 16) * 2; fz -= (z / r) * (r - 16) * 2; }
      if (y < 0.4) fy += (0.4 - y) * 4;
      if (y > 10) fy -= (y - 10) * 2;
      vel[j] = vel[j] * damping + fx * dt;
      vel[j + 1] = vel[j + 1] * damping + fy * dt;
      vel[j + 2] = vel[j + 2] * damping + fz * dt;
      pos[j] = x + vel[j] * dt;
      pos[j + 1] = y + vel[j + 1] * dt;
      pos[j + 2] = z + vel[j + 2] * dt;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
  }

  _updatePetals(dt, m) {
    const t = this.t;
    const wx = this.windDir.x * this.wind * 2.2, wz = this.windDir.y * this.wind * 2.2;
    const hands = this.handsWorld;
    for (let i = 0; i < this.petalN; i++) {
      const pt = this.petals[i];
      if (!pt.active) {
        this._ps.set(0, 0, 0);
        this._pm.compose(pt.p, this._pq.identity(), this._ps);
        this.petalMesh.setMatrixAt(i, this._pm);
        continue;
      }
      pt.life += dt;
      let scale = pt.scale;
      const ground = groundHeight(pt.p.x, pt.p.z) + 0.03;
      if (pt.landed > 0) {
        pt.landed += dt;
        const fade = 1 - THREE.MathUtils.smoothstep(pt.landed, 2.5, 4.5);
        scale *= fade;
        if (pt.landed > 4.5) {
          if (pt.ambient) this._spawnPetal(pt, true), (pt.p.y = rr(8, 11));
          else pt.active = false;
        }
        // lifted again by strong wind
        if (this.wind > 0.9 && Math.random() < dt * this.wind * 0.6) { pt.landed = 0; pt.v.y = 1.5; }
      } else {
        const fl = pt.flutter;
        const ax = Math.sin(t * 2.2 + fl) * 0.9 + wx;
        const az = Math.cos(t * 1.9 + fl * 1.3) * 0.9 + wz;
        let ay = -0.5 - m.sad * 0.4 + Math.sin(t * 3 + fl) * 0.2;
        let hx = 0, hy = 0, hz = 0;
        for (const H of hands) {
          const dx = H.p.x - pt.p.x, dy = H.p.y - pt.p.y, dz = H.p.z - pt.p.z;
          const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) + 1e-3;
          let s = (H.s * 6) / (1 + d2 * 0.15);
          if (H.s > 0 && d < 1) s *= d;
          hx += (dx / d) * s - (dz / d) * H.s * 2; hy += (dy / d) * s + Math.abs(H.s) * 0.4 / (1 + d2 * 0.2); hz += (dz / d) * s + (dx / d) * H.s * 2;
        }
        pt.v.x += (ax + hx - pt.v.x * 1.2) * dt;
        pt.v.z += (az + hz - pt.v.z * 1.2) * dt;
        pt.v.y += (ay + hy - pt.v.y * 1.5) * dt;
        pt.p.addScaledVector(pt.v, dt);
        pt.rot.x += pt.spin.x * dt * (1 + this.wind);
        pt.rot.y += pt.spin.y * dt;
        pt.rot.z += pt.spin.z * dt * (1 + this.wind);
        const r = Math.hypot(pt.p.x, pt.p.z);
        if (pt.p.y <= ground && r < ISLAND_R - 0.3) {
          pt.p.y = ground;
          pt.landed = 0.001;
          pt.rot.set(-Math.PI / 2 + rr(-0.2, 0.2), pt.rot.y, 0);
        } else if (r > 22 || pt.p.y < -6) {
          if (pt.ambient) this._spawnPetal(pt, true); else pt.active = false;
        }
        // grow in when spawned
        scale *= THREE.MathUtils.smoothstep(pt.life, 0, 0.6);
      }
      this._pq.setFromEuler(pt.rot);
      this._ps.setScalar(scale);
      this._pm.compose(pt.p, this._pq, this._ps);
      this.petalMesh.setMatrixAt(i, this._pm);
    }
    this.petalMesh.instanceMatrix.needsUpdate = true;
  }

  _updateRain(dt, sad) {
    const target = THREE.MathUtils.smoothstep(sad, 0.12, 0.65) * 0.8;
    this.rainMat.opacity = damp(this.rainMat.opacity, target, 1.2, dt);
    this.rain.visible = this.rainMat.opacity > 0.01;
    if (!this.rain.visible) return;
    const pos = this.rain.geometry.attributes.position.array;
    const D = this.rainDrops;
    const sx = this.windDir.x * this.wind * 0.12, sz = this.windDir.y * this.wind * 0.12;
    for (let i = 0; i < this.rainN; i++) {
      const j = i * 4;
      D[j + 1] -= D[j + 3] * dt;
      D[j] += sx * D[j + 3] * dt;
      D[j + 2] += sz * D[j + 3] * dt;
      if (D[j + 1] < -1) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 22;
        D[j] = Math.cos(a) * r; D[j + 2] = Math.sin(a) * r; D[j + 1] = 18 + Math.random() * 3;
      }
      const len = 0.7;
      const k = i * 6;
      pos[k] = D[j]; pos[k + 1] = D[j + 1]; pos[k + 2] = D[j + 2];
      pos[k + 3] = D[j] - sx * len * 6; pos[k + 4] = D[j + 1] + len; pos[k + 5] = D[j + 2] - sz * len * 6;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }
}
