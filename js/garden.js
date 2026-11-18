// The living garden: an open, endless meadow rendered with Three.js.
// Everything here is driven by a "mood" state object built in main.js.
//
// Motion philosophy: nothing is set directly. Plants, trees and the camera are
// driven by damped springs (so they overshoot a little and settle), grass and
// canopies bend in shaders with travelling wind waves, and all mood changes
// are blended over seconds.

import * as THREE from 'three';

// ---------- helpers ----------
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + (b - a) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const damp = (cur, target, tau, dt) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));

// damped spring step (semi-implicit Euler, sub-stepped for stability)
function spring(s, target, k, c, dt) {
  const n = dt > 1 / 50 ? 2 : 1;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

export function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  const near = 0.3 * Math.sin(x * 0.21 + 0.6) * Math.cos(z * 0.19 - 0.3) + 0.14 * Math.sin(x * 0.53 + z * 0.41) + 0.06 * Math.cos(z * 0.8 - x * 0.35);
  // far rolling hills rise toward the horizon for depth
  const far = THREE.MathUtils.smoothstep(r, 22, 110) * (3.2 + 2.6 * Math.sin(x * 0.045 + 1.1) * Math.cos(z * 0.05 - 0.4) + 1.8 * Math.sin(z * 0.031 + x * 0.02));
  return near + far;
}

const PALETTE = {
  sage: '#9db39a',
  sageDeep: '#6f8c6c',
  deepGreen: '#3f5a45',
  pink: '#efc7cc',
  rose: '#e2a6b0',
  lavender: '#c3b8e3',
  lilac: '#a99bd1',
  yellow: '#f3e1a0',
  butter: '#f7ecc4',
  ivory: '#f8f2e4',
};

const LOOKS = {
  rest: { top: '#c3cde2', mid: '#e5e2e6', horizon: '#f4ead8', fog: '#e9e2d6', sun: '#fff0d8', sunI: 2.4, hemiSky: '#e9ecf2', hemiGround: '#7d8f73', hemiI: 1.15, cloud: '#fbf7ef' },
  happy: { top: '#eec6d4', mid: '#f7ddd4', horizon: '#fbe4b0', fog: '#f5e2c8', sun: '#ffd8a0', sunI: 3.1, hemiSky: '#fff1e2', hemiGround: '#a39a6d', hemiI: 1.35, cloud: '#fff4e8' },
  angry: { top: '#3a2232', mid: '#64323f', horizon: '#a65a62', fog: '#7a4850', sun: '#ffb0a0', sunI: 1.5, hemiSky: '#a06a74', hemiGround: '#4a3a3c', hemiI: 0.8, cloud: '#5e404b' },
  sad: { top: '#5d6b84', mid: '#8995a8', horizon: '#b3bfcc', fog: '#a8b3c0', sun: '#c8d6ff', sunI: 1.0, hemiSky: '#aab8cc', hemiGround: '#4d5a5e', hemiI: 0.95, cloud: '#9aa5b3' },
};
for (const k in LOOKS) for (const p in LOOKS[k]) if (typeof LOOKS[k][p] === 'string') LOOKS[k][p] = new THREE.Color(LOOKS[k][p]);

function blendLook(w, out) {
  for (const p in LOOKS.rest) {
    if (LOOKS.rest[p].isColor) {
      out[p] = out[p] || new THREE.Color();
      out[p].setRGB(0, 0, 0);
      for (const k in w) { out[p].r += LOOKS[k][p].r * w[k]; out[p].g += LOOKS[k][p].g * w[k]; out[p].b += LOOKS[k][p].b * w[k]; }
    } else {
      out[p] = 0;
      for (const k in w) out[p] += LOOKS[k][p] * w[k];
    }
  }
  return out;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, a] of stops) grd.addColorStop(o, `rgba(255,255,255,${a})`);
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
    const u = p.getX(i);
    const v = p.getY(i) + 0.5;
    const hw = wid * Math.sin(Math.PI * Math.pow(v, 0.72)) * (1 - 0.15 * v);
    p.setXYZ(i, u * 2 * hw, v * len, cup * v * v + cross * (u * 2) * (u * 2) * Math.sin(Math.PI * v));
  }
  g.computeVertexNormals();
  return g;
}

// concatenate non-indexed geometries that each carry position/normal/color
function mergeSimple(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return m;
}
function colored(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// ---------- Garden ----------
export class Garden {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xe9e2d6, 25, 120);
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.position.set(0, 4.5, 18);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.look = blendLook({ rest: 1, happy: 0, angry: 0, sad: 0 }, {});
    this.glowTex = radialTexture([[0, 1], [0.25, 0.55], [0.6, 0.12], [1, 0]]);
    this.ringTex = radialTexture([[0, 0], [0.5, 0], [0.72, 0.9], [0.84, 0.25], [1, 0]]);

    this.t = 0;
    this.wind = 0.15;
    this.windDir = new THREE.Vector2(1, 0.3).normalize();
    this.windAngle = 0.3;
    this.gust = 0;
    this.growth = 0.35;
    this.droop = 0;
    this.flash = 0;
    this.flashLevel = 0;
    this.nextLightning = 3;
    this.pulses = [];
    this.handsWorld = [];
    this.cam = { x: { x: 0, v: 0 }, y: { x: 4.5, v: 0 }, z: { x: 18, v: 0 }, roll: { x: 0, v: 0 }, lx: { x: 0, v: 0 }, ly: { x: 2.4, v: 0 } };

    this.U = {
      uTime: { value: 0 },
      uWind: { value: 0.15 },
      uWindDir: { value: this.windDir },
      uDroop: { value: 0 },
      uGrow: { value: 1 },
      uPulse: { value: new THREE.Vector4(0, 0, -100, 0) }, // x,z centre, radius, amplitude
      uHand0: { value: new THREE.Vector4(0, -100, 0, 0) },
      uHand1: { value: new THREE.Vector4(0, -100, 0, 0) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uGlow: { value: new THREE.Color('#fff0cf') },
    };

    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildGrass();
    this._buildTrees();
    this._buildFlowers();
    this._buildLanterns();
    this._buildClouds();
    this._buildParticles();
    this._buildPetals();
    this._buildRain();
    this._buildHandWisps();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Lower the cost on slower GPUs. Grass is placed in random order, so drawing
  // only the first N instances thins it evenly.
  setQuality(level) {
    if (level === this.quality) return;
    this.quality = level;
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(level >= 2 ? dpr : level === 1 ? Math.min(dpr, 1) : 0.75);
    this.grass.count = Math.floor(this.grassCount * (level >= 2 ? 1 : level === 1 ? 0.6 : 0.35));
    this.renderer.shadowMap.type = level >= 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.shadow.mapSize.set(level >= 1 ? 2048 : 1024, level >= 1 ? 2048 : 1024);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 66 : 50;
    this.camera.updateProjectionMatrix();
    if (this.pMat) this.pMat.uniforms.uScale.value = h * 0.5;
  }

  // shared GLSL: pulse ring + hand glow light up surfaces; optional soft wobble
  _injectGlow(mat, { wobble = false } = {}) {
    const U = this.U;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uTime: U.uTime, uWind: U.uWind, uWindDir: U.uWindDir, uPulse: U.uPulse, uHand0: U.uHand0, uHand1: U.uHand1, uGlow: U.uGlow });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime, uWind; uniform vec2 uWindDir; uniform vec4 uPulse;
          varying vec3 vWPos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          ${wobble ? `
          {
            vec4 wpos0 = modelMatrix * vec4(transformed, 1.0);
            float w = sin(uTime * 1.1 + wpos0.x * 0.9 + wpos0.y * 0.7) * 0.5 + sin(uTime * 1.9 + wpos0.z * 1.3) * 0.3;
            transformed += normal * w * (0.035 + uWind * 0.05);
            transformed.xz += uWindDir * (0.5 + 0.5 * sin(uTime * 1.6 + wpos0.x * 0.4)) * uWind * 0.08 * max(position.y + 1.5, 0.0);
          }` : ''}
          {
            vec4 wp4 = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              wp4 = instanceMatrix * wp4;
            #endif
            vWPos = (modelMatrix * wp4).xyz;
          }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec4 uPulse, uHand0, uHand1; uniform vec3 uGlow;
          varying vec3 vWPos;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float d = length(vWPos.xz - uPulse.xy);
            float ring = exp(-pow((d - uPulse.z) * 1.1, 2.0)) * uPulse.w;
            ring += 0.25 * exp(-pow((d - uPulse.z * 0.9) * 0.6, 2.0)) * uPulse.w;
            vec3 h0 = vWPos - uHand0.xyz; vec3 h1 = vWPos - uHand1.xyz;
            float hg = abs(uHand0.w) * exp(-dot(h0, h0) / 7.0) + abs(uHand1.w) * exp(-dot(h1, h1) / 7.0);
            totalEmissiveRadiance += uGlow * (ring * 0.9 + hg * 0.22);
          }`);
    };
  }

  // ---------------------------------------------------------------- build
  _buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uMid: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSun: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(-0.5, 0.35, -0.8).normalize() },
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
        uniform vec3 uTop, uMid, uHorizon, uSun, uSunDir;
        uniform float uFlash, uTime;
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.2, y));
          col = mix(col, uTop, smoothstep(0.15, 0.8, y));
          float a = atan(d.z, d.x);
          float n = noise(vec2(a * 4.0 + uTime * 0.008, y * 7.0)) * 0.6 + noise(vec2(a * 9.0 - uTime * 0.01, y * 16.0)) * 0.4;
          col *= 0.975 + 0.05 * n;
          float s = max(dot(d, uSunDir), 0.0);
          col += uSun * (pow(s, 64.0) * 0.5 + pow(s, 6.0) * 0.12);
          col += uFlash * vec3(1.0, 0.92, 0.95) * (0.6 + 0.4 * smoothstep(0.0, 0.6, y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), this.skyMat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xe9ecf2, 0x7d8f73, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 120;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 5;
    this.sun.target.position.set(0, 0, -4);
    this.scene.add(this.sun, this.sun.target);
    this.fill = new THREE.PointLight(0xffd9c2, 0, 40, 1.5);
    this.fill.position.set(0, 5, 4);
    this.scene.add(this.fill);
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry(520, 520, 160, 160);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const cA = new THREE.Color(PALETTE.sage), cB = new THREE.Color(PALETTE.sageDeep), cC = new THREE.Color('#bcc79b'), cD = new THREE.Color('#b9b3cf');
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, groundHeight(x, z));
      const n = 0.5 + 0.5 * Math.sin(x * 0.11 + Math.cos(z * 0.09) * 2.0);
      const r = Math.hypot(x, z);
      c.copy(cA).lerp(cB, n * 0.5).lerp(cC, clamp01(Math.sin(z * 0.07 + x * 0.05)) * 0.3);
      c.lerp(cD, THREE.MathUtils.smoothstep(r, 60, 180) * 0.35); // aerial perspective
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    this._injectGlow(mat);
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.root.add(ground);

    const stoneMat = new THREE.MeshStandardMaterial({ color: '#d9d2c4', roughness: 0.8 });
    const stones = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), stoneMat, 22);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < 22; i++) {
      const a = rr(0, Math.PI * 2), r = rr(3, 34);
      const x = Math.cos(a) * r, z = Math.sin(a) * r - 4;
      const s = rr(0.2, 0.6);
      q.setFromEuler(new THREE.Euler(0, rr(0, 3), 0));
      m.compose(new THREE.Vector3(x, groundHeight(x, z) + 0.03, z), q, new THREE.Vector3(s, s * rr(0.45, 0.7), s * rr(0.8, 1.2)));
      stones.setMatrixAt(i, m);
    }
    stones.castShadow = stones.receiveShadow = true;
    this.root.add(stones);
  }

  _buildGrass() {
    const COUNT = window.innerWidth < 700 ? 9000 : 18000;
    const blade = new THREE.PlaneGeometry(0.075, 1, 1, 5);
    blade.translate(0, 0.5, 0);
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setX(i, bp.getX(i) * (1 - bp.getY(i) * 0.92));
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uBase: { value: new THREE.Color(PALETTE.deepGreen) },
        uTip: { value: new THREE.Color('#cbd5aa') },
      }]),
      vertexShader: /* glsl */ `
        uniform float uTime, uWind, uDroop, uGrow;
        uniform vec2 uWindDir;
        uniform vec4 uPulse, uHand0, uHand1;
        varying float vH;
        varying vec3 vTint;
        varying float vSheen;
        #include <fog_pars_vertex>
        vec2 handPush(vec4 h, vec2 base) {
          vec2 d = base - h.xz;
          float f = exp(-dot(d, d) / 6.0) * h.w;
          return normalize(d + 1e-4) * -f * 0.9;
        }
        void main() {
          float h = uv.y;
          vec3 p = position;
          p.y *= uGrow;
          vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 wp = instanceMatrix * vec4(p, 1.0);
          float bend = pow(h, 1.6);
          float ph = base.x * 0.35 + base.z * 0.27;
          // two travelling wind waves sweep across the meadow
          float along = dot(base.xz, uWindDir);
          float across = dot(base.xz, vec2(-uWindDir.y, uWindDir.x));
          float speed = 1.2 + uWind * 2.2;
          float wave = sin(along * 0.32 - uTime * speed + sin(across * 0.15) * 1.5) * 0.5 + 0.5;
          float wave2 = sin(along * 0.11 + across * 0.07 - uTime * speed * 0.55) * 0.5 + 0.5;
          float gust = wave * 0.65 + wave2 * 0.35;
          float flutter = sin(uTime * 2.6 + ph * 3.0) * 0.5 + sin(uTime * 4.1 + ph * 5.0) * 0.2;
          vec2 disp = uWindDir * (0.07 + uWind * (0.25 + 0.75 * gust)) + vec2(flutter, flutter * 0.7) * (0.03 + uWind * 0.06);
          disp += vec2(sin(uTime * 0.7 + ph), cos(uTime * 0.6 + ph * 1.3)) * 0.04;
          float d = length(base.xz - uPulse.xy);
          float ring = exp(-pow((d - uPulse.z) * 0.9, 2.0)) * uPulse.w;
          disp += normalize(base.xz - uPulse.xy + 1e-4) * ring * 0.8;
          disp += handPush(uHand0, base.xz) + handPush(uHand1, base.xz);
          wp.xz += disp * bend;
          wp.y -= (dot(disp, disp) * 0.35 + uDroop * 0.3) * bend;
          wp.y += ring * 0.15 * h;
          vH = h;
          vTint = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #endif
          vTint += ring * 0.35;
          vSheen = gust * (0.2 + uWind * 0.5) * h;
          vec4 mvPosition = modelViewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase, uTip, uLight, uAmb;
        varying float vH;
        varying vec3 vTint;
        varying float vSheen;
        #include <fog_pars_fragment>
        void main() {
          vec3 col = mix(uBase, uTip, smoothstep(0.0, 1.0, vH)) * vTint;
          col *= uAmb + uLight * (0.35 + 0.65 * vH);
          col += vSheen * uLight * 0.25; // silvery sheen where the wind wave passes
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(mat.uniforms, this.U);

    const mesh = new THREE.InstancedMesh(blade, mat, COUNT);
    this.grass = mesh;
    this.grassCount = COUNT;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), e = new THREE.Euler();
    const col = new THREE.Color();
    const tints = ['#f2f0d0', '#e6efd9', '#f3e2e6', '#e9e4f5'];
    for (let i = 0; i < COUNT; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.8) * 46; // denser near the viewer
      const x = Math.cos(a) * r, z = Math.sin(a) * r - 4;
      const clump = 0.5 + 0.5 * Math.sin(x * 0.6) * Math.cos(z * 0.5);
      pos.set(x, groundHeight(x, z) - 0.02, z);
      e.set(rr(-0.15, 0.15), rr(0, Math.PI), rr(-0.15, 0.15));
      q.setFromEuler(e);
      const far = 1 + Math.max(0, r - 15) * 0.03;
      s.set(rr(0.8, 1.4) * far, rr(0.35, 0.85) * (0.7 + clump * 0.8) * far, 1);
      m.compose(pos, q, s);
      mesh.setMatrixAt(i, m);
      col.set(rand() < 0.82 ? '#ffffff' : pick(tints));
      mesh.setColorAt(i, col);
    }
    mesh.frustumCulled = false;
    this.root.add(mesh);
  }

  _buildTrees() {
    this.trees = [];
    const spots = [];
    const near = [[-10, -7], [9.5, -11], [-2.5, -18], [13, 0], [-14, 2.5], [18, -19]];
    for (const [x, z] of near) spots.push([x + rr(-1, 1), z + rr(-1, 1), rr(0.8, 1.1)]);
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * (0.1 + 0.8 * (i + rand() * 0.6) / 7), r = rr(38, 85);
      spots.push([Math.cos(a) * r, Math.sin(a) * r, rr(1.2, 1.9)]);
    }
    const canopyColors = [
      [PALETTE.lavender, PALETTE.lilac, PALETTE.pink],
      [PALETTE.pink, PALETTE.rose, PALETTE.ivory],
      [PALETTE.sage, '#b6c8a6', PALETTE.butter],
      [PALETTE.butter, PALETTE.yellow, PALETTE.ivory],
    ];
    const barkMat = new THREE.MeshStandardMaterial({ color: '#8e7b74', roughness: 0.9 });
    this.canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.04 });
    this._injectGlow(this.canopyMat, { wobble: true });
    const floatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.08 });

    spots.forEach(([x, z, sc], i) => {
      const tree = new THREE.Group();
      tree.position.set(x, groundHeight(x, z) - 0.1, z);
      tree.scale.setScalar(sc);
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
        curve.getPointAt(ring / 24, center);
        const taper = 1.15 - 0.75 * (ring / 24);
        for (let j = 0; j <= 10; j++) {
          const idx = ring * 11 + j;
          tp.setXYZ(idx, center.x + (tp.getX(idx) - center.x) * taper, center.y + (tp.getY(idx) - center.y) * taper, center.z + (tp.getZ(idx) - center.z) * taper);
        }
      }
      tg.computeVertexNormals();
      const trunk = new THREE.Mesh(tg, barkMat);
      trunk.castShadow = true;
      tree.add(trunk);

      const canopy = new THREE.Group();
      canopy.position.copy(curve.getPointAt(1));
      tree.add(canopy);
      const cols = canopyColors[i % canopyColors.length];
      const geos = [];
      const nBlobs = 6 + Math.floor(rand() * 4);
      for (let b = 0; b < nBlobs; b++) {
        const r = rr(0.9, 1.7) * (b === 0 ? 1.4 : 1);
        const g = colored(new THREE.IcosahedronGeometry(r, i < 6 ? 3 : 2), pick(cols));
        const a = rr(0, Math.PI * 2), d = b === 0 ? 0 : rr(0.9, 2.1);
        g.scale(1, rr(0.75, 0.95), 1);
        g.translate(Math.cos(a) * d, rr(-0.4, 1.4) + (b === 0 ? 0.4 : 0), Math.sin(a) * d);
        geos.push(g);
      }
      const crown = new THREE.Mesh(mergeSimple(geos), this.canopyMat);
      crown.castShadow = true;
      crown.receiveShadow = true;
      canopy.add(crown);
      const floats = [];
      for (let b = 0; b < 2; b++) {
        const blob = new THREE.Mesh(colored(new THREE.IcosahedronGeometry(rr(0.25, 0.45), 2), pick(cols)), floatMat);
        blob.userData = { base: new THREE.Vector3(rr(-1.5, 1.5), rr(2.6, 3.6), rr(-1.5, 1.5)), phase: rr(0, 6) };
        blob.position.copy(blob.userData.base);
        canopy.add(blob);
        floats.push(blob);
      }
      this.root.add(tree);
      this.trees.push({ group: tree, canopy, crown, floats, phase: rr(0, 6), pos: new THREE.Vector2(x, z), sx: { x: 0, v: 0 }, sz: { x: 0, v: 0 }, k: rr(5, 8), bump: 0 });
    });
  }

  // ---------- flowers (fully instanced, spring-driven) ----------
  _buildFlowers() {
    const mkType = (petalCol, innerCol, centerCol, petals, len, openTilt, shape, extra = {}) => ({
      petals, inner: Math.max(4, petals - 3), len, openTilt, ...extra,
      colors: [petalCol, innerCol, centerCol],
      geo: [petalGeometry(1, shape[0], shape[1], shape[2]), petalGeometry(1, shape[0] * 0.9, shape[1] * 1.3, shape[2])],
    });
    this.flowerTypes = [
      mkType(PALETTE.pink, '#f7dde0', '#e9c46a', 8, 0.55, 1.35, [0.38, 0.25, 0.12]),
      mkType(PALETTE.lavender, '#ddd5f2', PALETTE.yellow, 6, 0.6, 1.2, [0.42, 0.35, 0.16], { tall: true }),
      mkType(PALETTE.yellow, PALETTE.butter, '#c98f5a', 5, 0.5, 1.45, [0.5, 0.22, 0.1]),
      mkType(PALETTE.ivory, '#fbf6ea', '#e6c46e', 11, 0.5, 1.5, [0.2, 0.15, 0.05]),
      mkType(PALETTE.rose, PALETTE.pink, '#f1d38b', 7, 0.48, 1.25, [0.45, 0.4, 0.18]),
    ];
    this.FLOWER_MAX = 120;
    const MAX = this.FLOWER_MAX;
    const mat = (c, e = 0.12) => {
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, side: THREE.DoubleSide, emissive: new THREE.Color(c), emissiveIntensity: e });
      this._injectGlow(m);
      return m;
    };
    const centerGeo = new THREE.SphereGeometry(0.12, 14, 10);
    centerGeo.scale(1, 0.7, 1);
    for (const T of this.flowerTypes) {
      T.outerMesh = new THREE.InstancedMesh(T.geo[0], mat(T.colors[0]), MAX * T.petals);
      T.innerMesh = new THREE.InstancedMesh(T.geo[1], mat(T.colors[1], 0.14), MAX * T.inner);
      T.centerMesh = new THREE.InstancedMesh(centerGeo, mat(T.colors[2], 0.2), MAX);
      for (const im of [T.outerMesh, T.innerMesh, T.centerMesh]) {
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;
        im.count = 0;
        this.root.add(im);
      }
      T.outerMesh.castShadow = true;
      T.centerMesh.castShadow = true;
      T.yawOuter = [...Array(T.petals)].map((_, i) => new THREE.Matrix4().makeRotationY((i / T.petals) * Math.PI * 2).multiply(new THREE.Matrix4().makeTranslation(0, 0.03, 0)));
      T.yawInner = [...Array(T.inner)].map((_, i) => new THREE.Matrix4().makeRotationY((i / T.inner) * Math.PI * 2 + 0.4).multiply(new THREE.Matrix4().makeTranslation(0, 0.02, 0)));
    }

    // stems bend in the vertex shader along a quadratic curve, per instance
    const stemGeo = new THREE.CylinderGeometry(0.022, 0.042, 1, 6, 10);
    stemGeo.translate(0, 0.5, 0);
    this.stemBend = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2);
    this.stemBend.setUsage(THREE.DynamicDrawUsage);
    stemGeo.setAttribute('aBend', this.stemBend);
    const stemMat = new THREE.MeshStandardMaterial({ color: '#6e8f63', roughness: 0.8 });
    stemMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aBend;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal = normalize(objectNormal - vec3(aBend.x, 0.0, aBend.y) * 2.0 * position.y * objectNormal.y);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float yy = position.y * position.y;
          transformed.x += aBend.x * yy;
          transformed.z += aBend.y * yy;`);
    };
    this.stemMesh = new THREE.InstancedMesh(stemGeo, stemMat, MAX);
    this.stemMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.stemMesh.frustumCulled = false;
    this.stemMesh.count = 0;
    this.root.add(this.stemMesh);

    const leafMat = new THREE.MeshStandardMaterial({ color: '#86a679', roughness: 0.7, side: THREE.DoubleSide });
    this.leafMesh = new THREE.InstancedMesh(petalGeometry(0.9, 0.2, 0.25, 0.06), leafMat, MAX * 2);
    this.leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.leafMesh.frustumCulled = false;
    this.leafMesh.count = 0;
    this.root.add(this.leafMesh);

    this.flowers = [];
    this.planted = [];
    const avoid = this.trees.map((t) => t.pos);
    let tries = 0;
    while (this.flowers.length < 80 && tries++ < 4000) {
      const a = rand() * Math.PI * 2;
      const r = 1 + Math.pow(rand(), 0.75) * 27;
      const x = Math.cos(a) * r, z = Math.sin(a) * r - 4;
      if (z > 12) continue; // keep the foreground clear of the lens
      if (avoid.some((p) => Math.hypot(p.x - x, p.y - z) < 1.8)) continue;
      if (this.flowers.some((f) => Math.hypot(f.pos.x - x, f.pos.y - z) < 1.0)) continue;
      const ti = Math.abs(Math.floor((Math.sin(x * 0.2) + Math.cos(z * 0.25) + 2) * 1.25 + rand() * 1.2)) % this.flowerTypes.length;
      this.flowers.push(this._newFlower(this.flowerTypes[ti], x, z, rr(0.85, 1.3) * (1 + r * 0.012)));
    }
  }

  _newFlower(type, x, z, scale, planted = false) {
    return {
      type, scale,
      stemH: rr(1.0, 1.9) * (type.tall ? 1.4 : 1),
      base: new THREE.Vector3(x, groundHeight(x, z) - 0.05, z),
      pos: new THREE.Vector2(x, z),
      phase: rr(0, Math.PI * 2),
      k: rr(9, 16), // each flower has its own rhythm
      bx: { x: 0, v: 0 }, bz: { x: 0, v: 0 }, nod: { x: 0, v: 0 },
      bloom: planted ? 0 : 0.25,
      tau: rr(0.5, 1.6) + Math.hypot(x, z + 4) * 0.05,
      jitter: [...Array(type.petals + type.inner)].map(() => [rr(0, 6), rr(-0.08, 0.08), rr(0, 0.05)]),
      leafYaw: [rr(-0.4, 0.4), Math.PI + rr(-0.4, 0.4)],
      leafAt: [rr(0.18, 0.45), rr(0.18, 0.45)],
      leafS: [rr(0.45, 0.7), rr(0.45, 0.7)],
      bump: 0,
      born: planted ? this.t : -100,
      planted,
    };
  }

  _buildLanterns() {
    this.lanterns = [];
    const stemMat = new THREE.MeshStandardMaterial({ color: '#7d9a73', roughness: 0.8 });
    for (let i = 0; i < 18; i++) {
      const a = rr(0, Math.PI * 2), r = rr(3, 26);
      const x = Math.cos(a) * r, z = Math.sin(a) * r - 4;
      if (z > 11 || this.trees.some((t) => Math.hypot(t.pos.x - x, t.pos.y - z) < 2)) continue;
      const g = new THREE.Group();
      g.position.set(x, groundHeight(x, z) - 0.05, z);
      const h = rr(2.4, 3.8);
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(rr(-0.4, 0.4), h * 0.55, rr(-0.4, 0.4)), new THREE.Vector3(rr(-0.2, 0.2), h, rr(-0.2, 0.2)));
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.03, 5, false), stemMat));
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
      this.lanterns.push({ group: g, pod, halo, phase: rr(0, 6), pos: new THREE.Vector2(x, z), sx: { x: 0, v: 0 }, sz: { x: 0, v: 0 }, k: rr(3, 6) });
    }
  }

  _buildClouds() {
    this.cloudMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, transparent: true, opacity: 0.9, emissive: new THREE.Color('#fff'), emissiveIntensity: 0.25, depthWrite: false });
    this._injectGlow(this.cloudMat, { wobble: true });
    this.cloudList = [];
    for (let i = 0; i < 14; i++) {
      const geos = [];
      const n = 6 + Math.floor(rand() * 5);
      for (let k = 0; k < n; k++) {
        const r = rr(1.2, 2.4) * (k === 0 ? 1.3 : 1);
        const g = colored(new THREE.SphereGeometry(1, 14, 10), '#ffffff');
        g.scale(r * 1.3, r * 0.75, r);
        g.translate(rr(-3.5, 3.5), rr(-0.3, 0.8), rr(-1.4, 1.4));
        geos.push(g);
      }
      const c = new THREE.Mesh(mergeSimple(geos), this.cloudMat);
      c.castShadow = true;
      c.userData = { x: rr(-110, 110), y: rr(16, 34), z: rr(-130, -8), speed: rr(0.6, 1.3), phase: rr(0, 6) };
      c.scale.setScalar(rr(1.1, 2.2));
      this.scene.add(c);
      this.cloudList.push(c);
    }
  }

  _buildParticles() {
    const N = window.innerWidth < 700 ? 600 : 1100;
    this.pN = N;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), seedA = new Float32Array(N);
    this.pVel = new Float32Array(N * 3);
    const cols = [PALETTE.butter, PALETTE.yellow, PALETTE.ivory, PALETTE.pink, PALETTE.lavender].map((c) => new THREE.Color(c));
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 28;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rr(0.4, 11);
      pos[i * 3 + 2] = Math.sin(a) * r - 4;
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
        uPulse: this.U.uPulse,
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
          vA = tw * uBright + ring * 0.8;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        varying vec3 vCol; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          a *= a;
          gl_FragColor = vec4(vCol * uTint * (0.6 + a), a * vA);
          #include <colorspace_fragment>
        }`,
    });
    this.particles = new THREE.Points(geo, this.pMat);
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
  }

  _buildPetals() {
    const N = 480;
    this.petalN = N;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.1 });
    this.petalMesh = new THREE.InstancedMesh(petalGeometry(0.22, 0.1, 0.05, 0.03), mat, N);
    this.petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.petalMesh.frustumCulled = false;
    const cols = [PALETTE.pink, PALETTE.rose, PALETTE.lavender, PALETTE.ivory, PALETTE.butter].map((c) => new THREE.Color(c));
    this.petals = [];
    for (let i = 0; i < N; i++) {
      this.petalMesh.setColorAt(i, pick(cols));
      this.petals.push({ active: false, p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), life: 0, landed: 0, scale: 1, ambient: i < 50 });
    }
    this.petalMesh.instanceColor.needsUpdate = true;
    this.root.add(this.petalMesh);
    this._pm = new THREE.Matrix4();
    this._pq = new THREE.Quaternion();
    this._ps = new THREE.Vector3();
    for (let i = 0; i < 50; i++) this._spawnPetal(this.petals[i], true);
  }

  _spawnPetal(pt, ambient = false, origin = null) {
    pt.active = true;
    if (origin) pt.p.copy(origin).add(new THREE.Vector3(rr(-1.6, 1.6), rr(-0.5, 0.8), rr(-1.6, 1.6)));
    else {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 20;
      pt.p.set(Math.cos(a) * r, ambient ? rr(1, 11) : rr(6, 11), Math.sin(a) * r - 3);
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
    const N = 2200;
    this.rainN = N;
    this.rainDrops = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 30;
      this.rainDrops.set([Math.cos(a) * r, rr(0, 22), Math.sin(a) * r, rr(13, 18)], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: '#f2f6ff', transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  _buildHandWisps() {
    this.wisps = [0, 1].map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: '#f2d27a', transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: '#fffaf0', transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ringTex, color: '#f2d27a', transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      s.renderOrder = 10; core.renderOrder = 11; ring.renderOrder = 12;
      this.root.add(s, core, ring);
      return { s, core, ring, pos: new THREE.Vector3(0, 3, 4), strength: 0 };
    });
  }

  // ---------------------------------------------------------------- events
  blink() {
    let n = 0;
    for (const pt of this.petals) {
      if (n >= 46) break;
      if (pt.ambient || pt.active) continue;
      let origin = null;
      if (rand() < 0.55) {
        origin = new THREE.Vector3();
        pick(this.trees.slice(0, 6)).canopy.getWorldPosition(origin);
      }
      this._spawnPetal(pt, false, origin);
      n++;
    }
  }

  pulse(strength = 1, cx = 0, cz = -2) {
    this.pulses.push({ t: 0, strength, cx, cz });
    if (this.pulses.length > 3) this.pulses.shift();
  }

  plantAtScreen(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3), hit) || hit.distanceTo(this.camera.position) > 40) {
      hit.copy(this.camera.position).addScaledVector(new THREE.Vector3(ray.ray.direction.x, 0, ray.ray.direction.z).normalize(), 14);
    }
    const dz = hit.z + 4, r = Math.hypot(hit.x, dz);
    if (r > 28) { hit.x *= 28 / r; hit.z = dz * (28 / r) - 4; }
    if (hit.z > 12) hit.z = 12;
    return this.plantAt(hit.x, hit.z);
  }

  plantAt(x, z) {
    if (this.planted.length >= 30) this.planted.shift().dying = true;
    if (this.flowers.length >= this.FLOWER_MAX) {
      const victim = this.flowers.find((f) => !f.planted && !f.dying);
      if (victim) victim.dying = true;
    }
    const f = this._newFlower(pick(this.flowerTypes), x, z, rr(0.95, 1.3), true);
    this.planted.push(f);
    this.flowers.push(f);
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
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const t = this.t;
    const U = this.U;
    const breath = Math.sin(t * 0.55) * 0.5 + 0.5;

    const happy = m.smile, angry = m.angry, sad = m.sad;
    const sum = happy + angry + sad;
    const k = sum > 1 ? 1 / sum : 1;
    const w = { happy: happy * k, angry: angry * k, sad: sad * k };
    w.rest = Math.max(0, 1 - w.happy - w.angry - w.sad);
    const L = blendLook(w, this.look);

    if (angry > 0.45) {
      this.nextLightning -= dt * (0.6 + angry);
      if (this.nextLightning <= 0) {
        this.flash = 0.6 + angry * 0.5;
        this.nextLightning = rr(2.2, 5.5);
        this.onLightning?.(this.flash);
      }
    } else this.nextLightning = Math.max(this.nextLightning, 1.5);
    this.flash = Math.max(0, this.flash - dt * 2.6);
    this.flashLevel = Math.max(0, this.flash > 0.55 ? this.flash : this.flash * (0.5 + 0.5 * Math.sin(t * 60)));

    const S = this.skyMat.uniforms;
    S.uTop.value.copy(L.top);
    S.uMid.value.copy(L.mid);
    S.uHorizon.value.copy(L.horizon);
    S.uSun.value.copy(L.sun).multiplyScalar(0.6 * Math.max(0, 1 - angry * 0.7 - sad * 0.7));
    S.uFlash.value = this.flashLevel * 0.6;
    S.uTime.value = t;
    this.scene.fog.color.copy(L.fog);
    this.scene.fog.near = lerp(25, 12, sad * 0.8 + angry * 0.4);
    this.scene.fog.far = lerp(120, 70, sad * 0.7 + angry * 0.3);
    this.sun.color.copy(L.sun);
    this.sun.intensity = L.sunI * (0.97 + 0.03 * breath) + this.flashLevel * 3;
    this.sun.position.set(-25 + happy * 6, 32 - happy * 6 + sad * 4, -20);
    this.hemi.color.copy(L.hemiSky);
    this.hemi.groundColor.copy(L.hemiGround);
    this.hemi.intensity = L.hemiI + this.flashLevel * 2;
    this.fill.intensity = happy * 30 + 2 * breath;
    this.cloudMat.color.copy(L.cloud);
    this.cloudMat.emissive.copy(L.cloud).multiplyScalar(0.3 + this.flashLevel);
    U.uLight.value.copy(L.sun).multiplyScalar(L.sunI * 0.32 + this.flashLevel * 0.6);
    U.uAmb.value.copy(L.hemiSky).multiplyScalar(L.hemiI * 0.38).lerp(L.hemiGround, 0.25);
    U.uGlow.value.set('#fff0cf').lerp(this._cA ||= new THREE.Color('#ffb3b3'), angry * 0.6).lerp(this._cS ||= new THREE.Color('#cfe0ff'), sad * 0.6);

    // ---- wind ----
    const gustNoise = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3);
    const storm = angry * (0.7 + 0.9 * gustNoise);
    this.gust = Math.max(this.gust - dt * 0.6, m.handGust || 0, 0);
    const windTarget = 0.12 + 0.06 * breath + m.brow * 1.25 + storm * 1.1 + this.gust + sad * 0.1;
    this.wind = damp(this.wind, windTarget, windTarget > this.wind ? 0.7 : 1.6, dt);
    this.windAngle += dt * (0.03 + angry * 0.5 * Math.sin(t * 0.4));
    this.windDir.set(Math.cos(this.windAngle), Math.sin(this.windAngle) * 0.6).normalize();
    U.uWind.value = this.wind;
    U.uTime.value = t;

    const growTarget = 0.35 + happy * 0.65 - sad * 0.15;
    this.growth = damp(this.growth, growTarget, growTarget > this.growth ? 3.5 : 7, dt);
    U.uGrow.value = 0.8 + this.growth * 0.45 - sad * 0.1;
    this.droop = damp(this.droop, sad, 1.5, dt);
    U.uDroop.value = this.droop;

    // ---- pulses ----
    let pr = -100, pa = 0, pcx = 0, pcz = 0;
    for (const p of this.pulses) p.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < 4);
    const P = this.pulses[this.pulses.length - 1];
    if (P) {
      const speed = P.strength > 0.5 ? 10 : 5;
      pr = P.t * speed * (1 - P.t / 12);
      pa = P.strength * Math.pow(1 - P.t / 4, 1.6);
      pcx = P.cx; pcz = P.cz;
    }
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
        handVecs[i].set(wp.x, wp.y, wp.z, W.strength);
        this.handsWorld.push({ p: wp, s: W.strength });
        const col = h.gesture === 'fist' ? '#de8f9f' : h.gesture === 'pinch' ? '#a996e6' : '#f2d27a';
        W.s.material.color.lerp(this._tmpC ? this._tmpC.set(col) : (this._tmpC = new THREE.Color(col)), 1 - Math.exp(-dt / 0.2));
        W.ring.material.color.copy(W.s.material.color);
        W.s.material.opacity = damp(W.s.material.opacity, 1, 0.3, dt);
        W.core.material.opacity = damp(W.core.material.opacity, 0.9, 0.3, dt);
        W.ring.material.opacity = damp(W.ring.material.opacity, 0.85, 0.3, dt);
        const sc = 2.2 + h.open * 2.2 + Math.sin(t * 3) * 0.2;
        W.s.scale.setScalar(sc);
        W.core.scale.setScalar(0.8 + h.open * 0.4);
        W.ring.scale.setScalar(sc * (0.55 + 0.1 * Math.sin(t * (h.gesture === 'fist' ? 8 : 2.5))));
        W.s.position.copy(wp); W.core.position.copy(wp); W.ring.position.copy(wp);
      } else {
        W.strength = damp(W.strength, 0, 0.3, dt);
        handVecs[i].w = W.strength;
        for (const sp of [W.s, W.core, W.ring]) sp.material.opacity = damp(sp.material.opacity, 0, 0.4, dt);
      }
    }

    this._updateFlowers(dt, happy, angry, sad, breath, pr, pa, pcx, pcz);

    // ---- trees: springy sway + breathing crowns ----
    for (const tr of this.trees) {
      const ph = tr.phase;
      const d = Math.hypot(tr.pos.x - pcx, tr.pos.y - pcz);
      tr.bump = Math.max(tr.bump * Math.exp(-dt * 2), Math.exp(-Math.pow((d - pr) * 0.6, 2)) * pa);
      const sway = Math.sin(t * 0.8 + ph) * 0.5 + Math.sin(t * 1.3 + ph * 2) * 0.25;
      spring(tr.sx, this.windDir.x * this.wind * 0.05 + sway * (0.012 + this.wind * 0.03), tr.k, 1.6, dt);
      spring(tr.sz, this.windDir.y * this.wind * 0.05 + sway * 0.7 * (0.012 + this.wind * 0.03), tr.k, 1.6, dt);
      tr.group.rotation.set(tr.sz.x, 0, -tr.sx.x);
      tr.canopy.rotation.set(tr.sz.x * 1.5, Math.sin(t * 0.3 + ph) * 0.05, -tr.sx.x * 1.5);
      const s = 1 + Math.sin(t * 0.55 + ph) * 0.02 + tr.bump * 0.1 + this.growth * 0.05 - this.droop * 0.04;
      tr.crown.scale.set(s, s * (0.98 - this.droop * 0.05), s);
      for (const bl of tr.floats) {
        const u = bl.userData;
        bl.position.set(u.base.x + Math.sin(t * 0.6 + u.phase) * 0.3, u.base.y + Math.sin(t * 0.7 + u.phase) * 0.35 - this.droop * 0.3, u.base.z + Math.cos(t * 0.5 + u.phase) * 0.3);
      }
    }

    for (const ln of this.lanterns) {
      const ph = ln.phase;
      const sw = Math.sin(t * 1.1 + ph) * (0.03 + this.wind * 0.08);
      spring(ln.sx, this.windDir.x * this.wind * 0.12 + sw, ln.k, 1.2, dt);
      spring(ln.sz, this.windDir.y * this.wind * 0.12 + sw * 0.6, ln.k, 1.2, dt);
      ln.group.rotation.set(ln.sz.x, 0, -ln.sx.x);
      const d = Math.hypot(ln.pos.x - pcx, ln.pos.y - pcz);
      const ring = Math.exp(-Math.pow((d - pr) * 0.8, 2)) * pa;
      const glow = 0.35 + happy * 0.9 + ring * 1.5 + Math.sin(t * 1.3 + ph) * 0.1 - sad * 0.2 - angry * 0.1;
      ln.pod.material.emissiveIntensity = Math.max(0.1, glow);
      ln.halo.material.opacity = Math.max(0.05, 0.2 + glow * 0.3);
      ln.halo.scale.setScalar(1.1 + glow * 0.7);
    }

    for (const c of this.cloudList) {
      const u = c.userData;
      const v = (0.3 + this.wind * 3) * u.speed;
      u.x += dt * v * this.windDir.x;
      u.z += dt * v * this.windDir.y * 0.3;
      if (u.x > 130) u.x = -130; else if (u.x < -130) u.x = 130;
      if (u.z > 0) u.z = -130; else if (u.z < -140) u.z = -5;
      c.position.set(u.x, u.y + Math.sin(t * 0.25 + u.phase) * 0.6 - sad * 3 - angry * 4, u.z);
    }

    this._updateParticles(dt, m, pr, pa, pcx, pcz);
    this._updatePetals(dt, m);
    this._updateRain(dt, sad);

    this.pMat.uniforms.uTime.value = t;
    this.pMat.uniforms.uBright.value = 0.45 + happy * 0.75 - sad * 0.2 + angry * 0.1;
    this.pMat.uniforms.uTint.value.setRGB(1, 1, 1).lerp(this._pA ||= new THREE.Color(1.0, 0.55, 0.55), angry * 0.6).lerp(this._pS ||= new THREE.Color(0.7, 0.8, 1.0), sad * 0.6);

    // ---- camera: slow floating drift + head-coupled parallax, all on springs ----
    const C = this.cam;
    const driftX = Math.sin(t * 0.07) * 2.2 + Math.sin(t * 0.031 + 1) * 1.2;
    const driftY = Math.sin(t * 0.11) * 0.35;
    spring(C.x, driftX + m.yaw * 4 + m.fx * 3, 2.2, 2.6, dt);
    spring(C.y, 4.4 + driftY + m.fy * 1.5 - m.pitch * 1.2 + happy * 0.4, 2.2, 2.6, dt);
    spring(C.z, 18 + Math.sin(t * 0.05) * 1.5 - happy * 1.5 + angry * 1.5, 2.2, 2.6, dt);
    spring(C.roll, m.roll * 0.55, 6, 4.2, dt);
    spring(C.lx, m.yaw * 1.5 + Math.sin(t * 0.05) * 1.5, 2, 2.5, dt);
    spring(C.ly, 2.4 - m.pitch * 0.8, 2, 2.5, dt);
    const shake = this.flashLevel * 0.05;
    this.camera.position.set(C.x.x + rr(-shake, shake), C.y.x, C.z.x);
    this.camera.lookAt(C.lx.x, C.ly.x, -4);
    this.camera.rotateZ(-C.roll.x); // the horizon tilts with your head
    this.fill.position.set(this.camera.position.x * 0.5, 5, 2);

    this.renderer.render(this.scene, this.camera);
  }

  _updateFlowers(dt, happy, angry, sad, breath, pr, pa, pcx, pcz) {
    const t = this.t;
    const bloomGlobal = clamp01(0.26 + happy * 0.74 - angry * 0.28 - sad * 0.18 + breath * 0.03);
    const mH = this._mH ||= new THREE.Matrix4();
    const mT = this._mT ||= new THREE.Matrix4();
    const mR = this._mR ||= new THREE.Matrix4();
    const q = this._fq ||= new THREE.Quaternion();
    const e = this._fe ||= new THREE.Euler();
    const v = this._fv ||= new THREE.Vector3();
    const sv = this._fs ||= new THREE.Vector3();
    const s2 = this._fs2 ||= new THREE.Vector3();
    for (const T of this.flowerTypes) { T._o = 0; T._i = 0; T._c = 0; }
    let stemI = 0, leafI = 0;

    for (let fi = this.flowers.length - 1; fi >= 0; fi--) {
      const f = this.flowers[fi];
      const T = f.type;
      const d = Math.hypot(f.pos.x - pcx, f.pos.y - pcz);
      const ring = Math.exp(-Math.pow((d - pr) * 0.9, 2)) * pa;
      f.bump = Math.max(f.bump * Math.exp(-dt * 3), ring);

      let handBloom = 0, hx = 0, hz = 0;
      for (const H of this.handsWorld) {
        const dx = H.p.x - f.pos.x, dz = H.p.z - f.pos.y;
        const dd = Math.hypot(dx, dz);
        const fall = Math.exp(-(dd * dd) / 9);
        handBloom += Math.max(0, H.s) * fall * 0.5;
        hx += (dx / (dd + 0.1)) * H.s * fall * 0.35;
        hz += (dz / (dd + 0.1)) * H.s * fall * 0.35;
      }
      f.bloom = damp(f.bloom, clamp01(bloomGlobal + f.bump * 0.6 + handBloom), f.tau, dt);

      let sc = f.scale * (0.82 + this.growth * 0.32);
      if (f.planted) sc *= THREE.MathUtils.smootherstep(t - f.born, 0, 2.2);
      if (f.dying) {
        f.dieT = (f.dieT ?? 1) - dt * 0.8;
        if (f.dieT <= 0) { this.flowers.splice(fi, 1); continue; }
        sc *= f.dieT;
      }
      sc = Math.max(sc * (1 + f.bump * 0.12), 1e-4);

      // springy stem: wind lean (same travelling wave as the grass) + sway + hands + pulse
      const ph = f.phase + f.pos.x * 0.3 + f.pos.y * 0.2;
      const along = f.pos.x * this.windDir.x + f.pos.y * this.windDir.y;
      const wave = Math.sin(along * 0.32 - t * (1.2 + this.wind * 2.2)) * 0.5 + 0.5;
      const windLean = this.wind * (0.14 + 0.2 * wave);
      const sway = Math.sin(t * 1.1 + ph) * 0.6 + Math.sin(t * 1.9 + ph * 1.7) * 0.3;
      const amp = 0.035 + this.wind * 0.06;
      const pdx = f.pos.x - pcx, pdz = f.pos.y - pcz, pd = Math.hypot(pdx, pdz) + 1e-3;
      spring(f.bx, this.windDir.x * windLean + sway * amp + hx + (pdx / pd) * ring * 0.35, f.k, 2.4, dt);
      spring(f.bz, this.windDir.y * windLean + sway * 0.6 * amp + hz + (pdz / pd) * ring * 0.35, f.k, 2.4, dt);
      spring(f.nod, this.droop * 1.1 - f.bump * 0.25 + Math.sin(t * 0.9 + ph) * 0.05, f.k * 0.6, 2.2, dt);
      const bx = Math.max(-0.6, Math.min(0.6, f.bx.x)), bz = Math.max(-0.6, Math.min(0.6, f.bz.x));
      const H = f.stemH;

      sv.set(sc, sc * H, sc);
      q.identity();
      mH.compose(f.base, q, sv);
      this.stemMesh.setMatrixAt(stemI, mH);
      this.stemBend.setXY(stemI, bx * H, bz * H);
      stemI++;

      e.order = 'YXZ';
      for (let li = 0; li < 2; li++) {
        const a = f.leafAt[li];
        v.set(f.base.x + bx * H * a * a * sc, f.base.y + H * a * sc, f.base.z + bz * H * a * a * sc);
        e.set(0.9 + Math.sin(t * 2 + ph + li) * 0.08 * (0.5 + this.wind) + this.droop * 0.4, f.leafYaw[li], 0);
        q.setFromEuler(e);
        sv.setScalar(f.leafS[li] * sc);
        mH.compose(v, q, sv);
        this.leafMesh.setMatrixAt(leafI++, mH);
      }

      // the head sits on the bent tip, tilted along the stem's tangent
      v.set(f.base.x + bx * H * sc, f.base.y + H * sc * (1 - 0.25 * (bx * bx + bz * bz)), f.base.z + bz * H * sc);
      e.order = 'XYZ';
      e.set(Math.atan(2 * bz) + f.nod.x, 0, -Math.atan(2 * bx));
      q.setFromEuler(e);
      sv.setScalar(sc);
      mH.compose(v, q, sv);
      T.centerMesh.setMatrixAt(T._c++, mH);

      const b = f.bloom;
      const ease = b * b * (3 - 2 * b);
      const flutterAmp = 0.04 * (0.4 + this.wind);
      for (let i = 0; i < T.petals; i++) {
        const j = f.jitter[i];
        const tilt = lerp(0.12 + j[2], T.openTilt + j[1], ease) + Math.sin(t * 3 + j[0]) * flutterAmp + breath * 0.03;
        mR.makeRotationX(tilt).scale(s2.setScalar(T.len));
        mT.multiplyMatrices(mH, T.yawOuter[i]).multiply(mR);
        T.outerMesh.setMatrixAt(T._o++, mT);
      }
      for (let i = 0; i < T.inner; i++) {
        const j = f.jitter[T.petals + i];
        const tilt = lerp(0.05 + j[2], T.openTilt * 0.62 + j[1], ease) + Math.sin(t * 3 + j[0]) * flutterAmp;
        mR.makeRotationX(tilt).scale(s2.setScalar(T.len * 0.68));
        mT.multiplyMatrices(mH, T.yawInner[i]).multiply(mR);
        T.innerMesh.setMatrixAt(T._i++, mT);
      }
    }
    for (const T of this.flowerTypes) {
      T.outerMesh.count = T._o; T.innerMesh.count = T._i; T.centerMesh.count = T._c;
      T.outerMesh.instanceMatrix.needsUpdate = T.innerMesh.instanceMatrix.needsUpdate = T.centerMesh.instanceMatrix.needsUpdate = true;
    }
    this.stemMesh.count = stemI;
    this.leafMesh.count = leafI;
    this.stemMesh.instanceMatrix.needsUpdate = true;
    this.leafMesh.instanceMatrix.needsUpdate = true;
    this.stemBend.needsUpdate = true;
  }

  _screenToGarden(nx, ny, out) {
    const ndc = this._ndc ||= new THREE.Vector2();
    ndc.set(nx * 2 - 1, -(ny * 2 - 1));
    const ray = this._ray ||= new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const normal = this.camera.getWorldDirection(this._nrm ||= new THREE.Vector3()).negate();
    const plane = (this._pl ||= new THREE.Plane()).setFromNormalAndCoplanarPoint(normal, this._tgt ||= new THREE.Vector3(0, 2.5, 4));
    const hit = this._hit ||= new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) hit.set(0, 3, 4);
    hit.y = Math.max(hit.y, groundHeight(hit.x, hit.z) + 0.5);
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
      const x = pos[j], y = pos[j + 1], z = pos[j + 2];
      let fx = (Math.sin(y * 0.6 + t * 0.35 + z * 0.3) + 0.5 * Math.sin(z * 1.1 - t * 0.5)) * activity + wx;
      let fy = (0.4 * Math.sin(x * 0.5 + t * 0.3 + i) + 0.25 * Math.cos(z * 0.7 + t * 0.2)) * activity * 0.6 - sink;
      let fz = (Math.cos(x * 0.55 - t * 0.3 + y * 0.25) + 0.5 * Math.cos(x * 0.9 + t * 0.45)) * activity + wz;
      if (m.angry > 0.2) {
        const sw = m.angry * 3; // swirling eddies, not random jitter
        fx += Math.sin(t * 2.3 + z * 0.8 + i) * sw;
        fz += Math.cos(t * 2.1 + x * 0.8 + i) * sw;
        fy += Math.sin(t * 3.1 + i) * sw * 0.4;
      }
      if (pa > 0.01) {
        const dx = x - pcx, dz = z - pcz;
        const d = Math.hypot(dx, dz) + 1e-3;
        const ring = Math.exp(-Math.pow((d - pr) * 0.6, 2)) * pa * 14;
        fx += (dx / d) * ring; fz += (dz / d) * ring; fy += ring * 0.4;
      }
      for (const H of hands) {
        const dx = H.p.x - x, dy = H.p.y - y, dz = H.p.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2) + 1e-3;
        const fall = 1 / (1 + d2 * 0.1);
        let s = H.s * 9 * fall;
        if (H.s > 0 && d < 0.9) s *= d / 0.9;
        fx += (dx / d) * s - (dz / d) * H.s * 3 * fall;
        fy += (dy / d) * s;
        fz += (dz / d) * s + (dx / d) * H.s * 3 * fall;
      }
      const rz = z + 4, r = Math.hypot(x, rz);
      if (r > 28) { fx -= (x / r) * (r - 28) * 2; fz -= (rz / r) * (r - 28) * 2; }
      const g = groundHeight(x, z);
      if (y < g + 0.4) fy += (g + 0.4 - y) * 4;
      if (y > 12) fy -= (y - 12) * 2;
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
        scale *= 1 - THREE.MathUtils.smoothstep(pt.landed, 2.5, 4.5);
        if (pt.landed > 4.5) {
          if (pt.ambient) { this._spawnPetal(pt, true); pt.p.y = rr(9, 12); } else pt.active = false;
        }
        if (this.wind > 0.9 && Math.random() < dt * this.wind * 0.6) { pt.landed = 0; pt.v.y = 1.5; }
      } else {
        const fl = pt.flutter;
        const ax = Math.sin(t * 2.2 + fl) * 0.9 + wx;
        const az = Math.cos(t * 1.9 + fl * 1.3) * 0.9 + wz;
        const ay = -0.5 - m.sad * 0.4 + Math.sin(t * 3 + fl) * 0.2;
        let hx = 0, hy = 0, hz = 0;
        for (const H of hands) {
          const dx = H.p.x - pt.p.x, dy = H.p.y - pt.p.y, dz = H.p.z - pt.p.z;
          const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) + 1e-3;
          let s = (H.s * 6) / (1 + d2 * 0.12);
          if (H.s > 0 && d < 1) s *= d;
          hx += (dx / d) * s - (dz / d) * H.s * 2;
          hy += (dy / d) * s + (Math.abs(H.s) * 0.4) / (1 + d2 * 0.2);
          hz += (dz / d) * s + (dx / d) * H.s * 2;
        }
        pt.v.x += (ax + hx - pt.v.x * 1.2) * dt;
        pt.v.z += (az + hz - pt.v.z * 1.2) * dt;
        pt.v.y += (ay + hy - pt.v.y * 1.5) * dt;
        pt.p.addScaledVector(pt.v, dt);
        pt.rot.x += pt.spin.x * dt * (1 + this.wind);
        pt.rot.y += pt.spin.y * dt;
        pt.rot.z += pt.spin.z * dt * (1 + this.wind);
        if (pt.p.y <= ground) {
          pt.p.y = ground;
          pt.landed = 0.001;
          pt.rot.set(-Math.PI / 2 + rr(-0.2, 0.2), pt.rot.y, 0);
        } else if (Math.hypot(pt.p.x, pt.p.z + 4) > 40) {
          if (pt.ambient) this._spawnPetal(pt, true); else pt.active = false;
        }
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
    const ox = this.camera.position.x, oz = this.camera.position.z - 14;
    const sx = this.windDir.x * this.wind * 0.12, sz = this.windDir.y * this.wind * 0.12;
    for (let i = 0; i < this.rainN; i++) {
      const j = i * 4;
      D[j + 1] -= D[j + 3] * dt;
      D[j] += sx * D[j + 3] * dt;
      D[j + 2] += sz * D[j + 3] * dt;
      if (D[j + 1] < -1) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 30;
        D[j] = Math.cos(a) * r; D[j + 2] = Math.sin(a) * r; D[j + 1] = 20 + Math.random() * 3;
      }
      const k = i * 6, len = 0.7;
      pos[k] = D[j] + ox; pos[k + 1] = D[j + 1]; pos[k + 2] = D[j + 2] + oz;
      pos[k + 3] = D[j] + ox - sx * len * 6; pos[k + 4] = D[j + 1] + len; pos[k + 5] = D[j + 2] + oz - sz * len * 6;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }
}
