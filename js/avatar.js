// AVATAR: spin once in front of the camera and get a 3D game version of yourself.
//
// The scan: stand back, then turn slowly to your left following the guide. Every 15°
// a full-resolution frame is captured with MediaPipe's body mask and 3D landmarks
// (the landmarks refine the turn angle). From those 24 views scan3d.js carves a
// visual hull, meshes it, and works out which camera image best shows each point.
// The result is drawn with your real camera images on it, with an optional toon
// game look (banded light, rim light, ink outline), rigged to a simple skeleton so
// it copies your pose live. It can spin on a turntable, be saved as a .glb 3D file,
// or be put on a poster.

import * as THREE from 'three';
import { PoseTracker } from './body.js?v=11';
import { ScanCover } from './scan-cover.js?v=2';
import { clamp01, ease, cameraErrorMessage, Sfx, setupToggle } from './shared.js?v=8';
import * as S3 from './scan3d.js?v=10';
import * as Fit from './fitbody.js?v=6';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const stage = $('stage');
const sctx2 = stage.getContext('2d');
const glCanvas = $('gl');
const scanCv = $('scan');
const sctx = scanCv.getContext('2d');
const landing = $('landing');
const enterBtn = $('enter');
const note = $('landing-note');
const hud = $('hud');
const banner = $('banner');
const statusEl = $('status');
const statusText = statusEl.querySelector('.status-text');
const mirror = $('mirror');
const buildEl = $('build');
const cover = new ScanCover($('cover'));

const TAU = Math.PI * 2;
const INK = '#1a0d2a';
const N_VIEWS = 24;
const SPIN_SECONDS = 18; // one slow, comfortable turn
const RES = { nx: 200, ny: 208, nz: 200, nu: 200, nv: 208 };

let W = 0, H = 0, DPR = 1;
const backdrop = document.createElement('canvas');
const bctx = backdrop.getContext('2d');

// ======================================================================
// Three.js stage
// ======================================================================
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
const rig = new THREE.Group(); // turntable + mirror
scene.add(rig);
const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.32, 48), new THREE.MeshBasicMaterial({ color: 0x1a0d2a, transparent: true, opacity: 0.35, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2;
shadow.scale.set(1, 0.55, 1);
shadow.position.y = 0.001;
scene.add(shadow);

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  stage.width = Math.round(W * DPR);
  stage.height = Math.round(H * DPR);
  sctx2.setTransform(DPR, 0, 0, DPR, 0, 0);
  backdrop.width = stage.width;
  backdrop.height = stage.height;
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  paintCity(bctx, W, H, 1);
  sctx2.drawImage(backdrop, 0, 0, W, H);
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  // frame a body of height 1 standing at the origin, with a little headroom
  // (the name badge sits over the top of the screen, so keep the head below it)
  const fitH = 1.55, fitW = 0.95;
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const dist = Math.max(fitH / 2 / tan, fitW / 2 / tan / camera.aspect);
  camera.position.set(0, 0.62, dist);
  camera.lookAt(0, 0.6, 0);
  camera.updateProjectionMatrix();
  sizeScanCanvas();
}
function sizeScanCanvas() {
  const r = scanCv.getBoundingClientRect();
  scanCv.width = Math.max(2, Math.round(r.width * DPR));
  scanCv.height = Math.max(2, Math.round(r.height * DPR));
}
window.addEventListener('resize', resize);

// ======================================================================
// Shaders: real camera images blended per view, with a toon game look
// ======================================================================
const IDX = [0, 1, 2, 3, 4, 5];
const wDecl = IDX.map((i) => `attribute vec4 w${i}; varying vec4 v${i};`).join('\n');
const wCopy = IDX.map((i) => `v${i} = w${i};`).join(' ');
const wUnpack = IDX.map((i) => `ws[${i * 4}] = v${i}.x; ws[${i * 4 + 1}] = v${i}.y; ws[${i * 4 + 2}] = v${i}.z; ws[${i * 4 + 3}] = v${i}.w;`).join('\n');

const skinMat = new THREE.ShaderMaterial({
  uniforms: {
    atlas: { value: null },
    views: { value: Array.from({ length: N_VIEWS }, () => new THREE.Vector4()) },
    cols: { value: 6 },
    rows: { value: 4 },
    toon: { value: 1 },
    faceTex: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) },
  },
  vertexShader: /* glsl */ `
    #include <common>
    #include <skinning_pars_vertex>
    ${wDecl}
    attribute vec2 faceUV;
    attribute float faceW;
    varying vec2 vFaceUV;
    varying float vFaceW;
    varying vec3 vRest;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vRest = position;
      vFaceUV = faceUV;
      vFaceW = faceW;
      ${wCopy}
      #include <beginnormal_vertex>
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <defaultnormal_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vN = normalize(transformedNormal);
      vV = normalize(-mvPosition.xyz);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D atlas;
    uniform vec4 views[${N_VIEWS}];
    uniform float cols;
    uniform float rows;
    uniform float toon;
    uniform sampler2D faceTex;
    varying vec2 vFaceUV;
    varying float vFaceW;
    ${IDX.map((i) => `varying vec4 v${i};`).join('\n')}
    varying vec3 vRest;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      float ws[24];
      ${wUnpack}
      vec3 col = vec3(0.0);
      float tw = 0.0;
      float vl = clamp(vRest.y / 1.04, 0.002, 0.998);
      for (int i = 0; i < ${N_VIEWS}; i++) {
        float w = ws[i];
        if (w < 0.004) continue;
        vec4 V = views[i];
        float u = clamp(vRest.x * V.x + vRest.z * V.y + 0.5, 0.002, 0.998);
        vec2 uv = vec2((V.z + u) / cols, 1.0 - (V.w + 1.0 - vl) / rows);
        col += w * texture2D(atlas, uv).rgb;
        tw += w;
      }
      col /= max(tw, 1e-4);
      // the close-up face photo, where there is one
      if (vFaceW > 0.001) col = mix(col, texture2D(faceTex, vFaceUV).rgb, vFaceW);
      vec3 n = normalize(vN);
      vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
      float ndl = dot(n, L);
      // toon: three light bands, punchier colour, a warm sunset rim
      float band = ndl > 0.3 ? 1.06 : ndl > -0.15 ? 0.93 : 0.8;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      vec3 sat = mix(vec3(lum), col, 1.2);
      vec3 post = mix(sat, floor(sat * 8.0 + 0.5) / 8.0, 0.45);
      vec3 shadeTint = mix(vec3(0.9, 0.86, 1.0), vec3(1.0), step(0.3, ndl));
      vec3 t = post * band * shadeTint;
      float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.0);
      t += rim * vec3(1.0, 0.6, 0.45) * 0.22;
      vec3 photo = col * (0.9 + 0.12 * max(ndl, 0.0));
      gl_FragColor = vec4(clamp(mix(photo, t, toon), 0.0, 1.0), 1.0);
    }`,
});

const outlineMat = new THREE.ShaderMaterial({
  uniforms: { outline: { value: 0.0045 } },
  side: THREE.BackSide,
  vertexShader: /* glsl */ `
    #include <common>
    #include <skinning_pars_vertex>
    uniform float outline;
    void main() {
      #include <beginnormal_vertex>
      #include <begin_vertex>
      transformed += normalize(objectNormal) * outline;
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
    }`,
  fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(0.1, 0.05, 0.16, 1.0); }`,
});

// ======================================================================
// The built avatar
// ======================================================================
let model = null;
let mode = 'live'; // live | turntable
let spinY = 0, dragV = 0;

function buildModel(mesh, normals, W8, views, atlasInfo, front, skin = null, face = null) {
  if (model) { rig.remove(model.group); model.geo.dispose(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const n = mesh.positions.length / 3;
  for (let a = 0; a < 6; a++) {
    const arr = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) arr[i * 4 + k] = W8[i * 24 + a * 4 + k];
    geo.setAttribute('w' + a, new THREE.BufferAttribute(arr, 4));
  }
  geo.setAttribute('faceUV', new THREE.BufferAttribute(face ? face.uv : new Float32Array(n * 2), 2));
  geo.setAttribute('faceW', new THREE.BufferAttribute(face ? face.w : new Float32Array(n), 1));
  if (face) {
    const ft = new THREE.CanvasTexture(face.canvas);
    ft.colorSpace = THREE.NoColorSpace;
    ft.generateMipmaps = false;
    ft.minFilter = THREE.LinearFilter;
    skinMat.uniforms.faceTex.value = ft;
  }
  // rig
  const J = S3.restJoints(front);
  const layout = S3.boneLayout(J);
  const { si, sw } = skin || S3.skinWeights(mesh, layout);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const group = new THREE.Group();
  const bones = {};
  for (const name of S3.BONES) { const b = new THREE.Bone(); b.name = name; bones[name] = b; }
  for (const name of S3.BONES) {
    const p = S3.PARENT[name];
    const at = layout[name].at;
    if (p) {
      const pa = layout[p].at;
      bones[name].position.set(at.x - pa.x, at.y - pa.y, at.z - pa.z);
      bones[p].add(bones[name]);
    } else {
      bones[name].position.set(at.x, at.y, at.z);
      group.add(bones[name]);
    }
  }
  rig.add(group);
  rig.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(S3.BONES.map((b) => bones[b]));
  const tex = new THREE.CanvasTexture(atlasInfo.atlas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  skinMat.uniforms.atlas.value = tex;
  skinMat.uniforms.cols.value = atlasInfo.cols;
  skinMat.uniforms.rows.value = atlasInfo.rows;
  views.forEach((v, i) => skinMat.uniforms.views.value[i].set(v.cos, v.sin, v.col, v.row));
  const sm = new THREE.SkinnedMesh(geo, skinMat);
  const om = new THREE.SkinnedMesh(geo, outlineMat);
  sm.frustumCulled = om.frustumCulled = false;
  group.add(sm, om);
  group.updateMatrixWorld(true);
  sm.bind(skel);
  om.bind(skel, sm.bindMatrix);
  const restDir = {};
  for (const [b, [a, c]] of Object.entries(S3.DIRS)) {
    const pa = J[a], pc = J[c];
    restDir[b] = new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, 0).normalize();
  }
  model = { group, mesh: sm, outline: om, bones, restDir, geo, views, front, J };
  return model;
}

// pose the skeleton from live landmarks (image space, not mirrored)
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();
function poseModel(lm, dt) {
  if (!model) return;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const world = {};
  const k = ease(dt, 0.08);
  for (const name of S3.BONES) {
    const bone = model.bones[name];
    const parent = S3.PARENT[name];
    const pw = parent ? world[parent] : new THREE.Quaternion();
    let target = new THREE.Quaternion();
    const pair = S3.DIRS[name];
    if (lm && pair) {
      const a = S3.landmarkPoint(lm, pair[0]), b = S3.landmarkPoint(lm, pair[1]);
      if ((a.visibility ?? 1) > 0.5 && (b.visibility ?? 1) > 0.5) {
        _v.set((b.x - a.x) * vw, -(b.y - a.y) * vh, -((b.z || 0) - (a.z || 0)) * vw * 0.5).normalize();
        // webcam depth is noisy: cap how far a bone may point at or away from the camera
        if (Math.abs(_v.z) > 0.55) { const xy = Math.hypot(_v.x, _v.y) || 1e-6, f = Math.sqrt(1 - 0.55 * 0.55) / xy; _v.set(_v.x * f, _v.y * f, Math.sign(_v.z) * 0.55); }
        _q.setFromUnitVectors(model.restDir[name], _v);
        target = pw.clone().invert().multiply(_q);
      }
    }
    bone.quaternion.slerp(target, k);
    world[name] = pw.clone().multiply(bone.quaternion);
  }
}

// ======================================================================
// The scan
// ======================================================================
let tracker = null;
let scan = { state: 'idle' };
let fullT = 0;

function resetScan() {
  scan = { state: 'waiting', caps: [], next: 0, guide: 0, busy: false };
  fullT = 0;
  mirror.classList.add('big');
  mirror.classList.remove('hidden');
  ['btn-mode', 'btn-look', 'btn-glb', 'btn-poster'].forEach((id) => ($(id).disabled = true));
  if (model) model.group.visible = false;
  cover.reset();
  $('cover-pct').textContent = '0%';
  $('btn-scan').textContent = 'Start turning';
  setTimeout(sizeScanCanvas, 750);
}

function bodyCheck(lm) {
  const v = (i, t = 0.5) => (lm[i].visibility ?? 1) > t;
  const head = v(0) || v(7) || v(8);
  const core = head && v(11) && v(12) && v(23, 0.4) && v(24, 0.4);
  const knees = v(25, 0.35) || v(26, 0.35);
  const feet = (v(27, 0.35) || v(28, 0.35)) && Math.max(lm[27].y, lm[28].y) < 1.0;
  const headIn = lm[0].y > 0.02;
  // full: head to toe. ok: head to at least the knees (the feet get filled in)
  return { full: core && knees && feet && headIn, ok: core && knees && headIn, core, headIn };
}

// shoulder line from the 3D landmarks gives the turn angle, up to front/back
function refineYaw(world, nominal) {
  if (!world) return nominal;
  const L = world[11], R = world[12];
  const est = Math.atan2(L.z - R.z, L.x - R.x);
  let best = nominal, bd = Infinity;
  for (const cand of [est, est + Math.PI]) {
    const d = Math.abs(Math.atan2(Math.sin(cand - nominal), Math.cos(cand - nominal)));
    if (d < bd) { bd = d; best = cand; }
  }
  if (bd > (50 * Math.PI) / 180) return nominal;
  const d = Math.atan2(Math.sin(best - nominal), Math.cos(best - nominal));
  return nominal + d * 0.85; // mostly the measurement: people rarely turn at the guide's pace
}

function scanStep(dt, person) {
  const lm = person?.raw || null;
  if (scan.state === 'waiting') {
    const chk = lm ? bodyCheck(lm) : null;
    fullT = chk?.full ? fullT + dt : chk?.ok ? fullT + dt * 0.5 : 0;
    setBanner(!lm ? 'Step into the frame so I can see you' :
      chk.full ? 'Got you! Hold your arms out from your sides like an A…' :
      chk.ok ? 'Nearly: step back to show your feet, or press Start turning' :
      !chk.headIn ? 'Your head is cut off: tilt the camera up or step back' :
      'Step back so I can see you down to your knees');
    if (fullT > 1.4 || (scan.force && lm)) { scan.force = false; $('btn-scan').textContent = 'Rescan'; scan.state = 'spinning'; scan.guide = 0; scan.next = 0; S.go(); }
  } else if (scan.state === 'spinning') {
    const step = TAU / N_VIEWS;
    // the guide waits for slow captures so the angles stay true
    if (lm) scan.lastSeen = performance.now();
    const seen = performance.now() - (scan.lastSeen || 0) < 1200;
    if (seen && scan.guide < (scan.next + 1) * step) scan.guide = Math.min(TAU, scan.guide + (TAU / SPIN_SECONDS) * dt);
    const target = (scan.next / N_VIEWS) * TAU;
    if (scan.next < N_VIEWS && scan.guide >= target && !scan.busy && seen) {
      scan.busy = true;
      const want = scan.next, at = scan.guide;
      tracker.capture().then((cap) => {
        scan.busy = false;
        if (scan.state !== 'spinning' || scan.next !== want) return;
        if (!cap || !cap.mask || !cap.rgba) { scan.fails = (scan.fails || 0) + 1; scan.err = tracker.captureError || 'unknown'; return; }
        // a capture whose mask barely has a body in it is no use
        let fg = 0; for (let i = 0; i < cap.mask.length; i += 7) if (cap.mask[i] > 0.5) fg++;
        if (fg * 7 < cap.mask.length * 0.01) { scan.fails = (scan.fails || 0) + 1; scan.err = 'body mask came back empty'; return; }
        scan.fails = 0;
        try { cover.addCapture(cap, at); $('cover-pct').textContent = Math.round(cover.coverage() * 100) + '%'; } catch (e) { console.warn('coverage', e); }
        cap.theta = refineYaw(cap.world, Math.min(at, target + step));
        cap.nominal = at;
        scan.caps.push(cap);
        scan.next++;
        S.tick(scan.next / N_VIEWS);
        if (scan.next >= N_VIEWS) { scan.state = 'face'; scan.faceT = 0; scan.faceStart = performance.now(); $('btn-scan').textContent = 'Skip face photo'; S.go(); }
      });
    }
    const pct = Math.round((scan.caps.length / N_VIEWS) * 100);
    if (scan.fails >= 4) setBanner(`Camera capture is failing (${scan.err}) · ${pct}%`);
    else setBanner(seen ? `Arms slightly out, turn slowly left with the figure · ${scan.caps.length}/${N_VIEWS}` : 'Come back into view');
  } else if (scan.state === 'face') {
    // last step: a close-up so the face is sharp (from across the room it's tiny)
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    let msg = 'Last step: walk up close to the camera and look straight at it';
    let ok = false;
    if (lm && lm[2].visibility > 0.5 && lm[5].visibility > 0.5 && lm[0].visibility > 0.5) {
      const eyeD = Math.hypot((lm[2].x - lm[5].x) * vw, (lm[2].y - lm[5].y) * vh);
      const midX = ((lm[2].x + lm[5].x) / 2) * vw;
      if (eyeD < vw * 0.055) msg = 'Closer… your face should fill more of the camera';
      else if (Math.abs(lm[0].x * vw - midX) > eyeD * 0.22) msg = 'Look straight at the camera';
      else { ok = true; msg = 'Perfect, hold still…'; }
    }
    scan.faceT = ok ? scan.faceT + dt : 0;
    setBanner(msg);
    if (scan.faceT > 0.7 && !scan.busy) {
      scan.busy = true;
      tracker.capture().then((cap) => {
        scan.busy = false;
        if (scan.state !== 'face') return;
        if (cap && cap.rgba && cap.lm) { S.shutter(); build(scan.caps, cap); }
        else scan.faceT = 0;
      });
    }
    if (performance.now() - scan.faceStart > 30000) build(scan.caps, null);
  }
}

async function build(caps, faceCap = null) {
  scan.state = 'building';
  setBanner('Building your 3D self');
  buildEl.hidden = false;
  const bar = buildEl.querySelector('i'), label = buildEl.querySelector('span');
  const step = async (f, text) => { bar.style.width = Math.round(f * 100) + '%'; label.textContent = text; await new Promise((r) => setTimeout(r, 16)); };
  try {
    await step(0.02, 'Lining up your silhouettes…');
    // smooth the turn angles: unwrap, keep them in order, and even out jitter
    const th = caps.map((c) => c.theta);
    for (let i = 1; i < th.length; i++) while (th[i] < th[i - 1] - Math.PI) th[i] += TAU;
    const sm = th.map((t, i) => (i === 0 || i === th.length - 1 ? t : 0.5 * t + 0.25 * (th[i - 1] + th[i + 1])));
    for (let i = 1; i < sm.length; i++) if (sm[i] < sm[i - 1] + 0.02) sm[i] = sm[i - 1] + 0.02;
    caps.forEach((c, i) => (c.theta = sm[i]));
    const views = S3.measure(caps);
    const bad = views.filter((v) => v.px < 40).length;
    if (bad > N_VIEWS / 3) throw new Error('The camera lost you during the turn. Try again with more light and a plainer background.');
    await step(0.08, 'Cutting out your outline from every angle…');
    await step(0.05, 'Lining up the angle of every shot…');
    await S3.alignViews(views, (f) => { bar.style.width = Math.round((0.05 + f * 0.12) * 100) + '%'; });
    const atlasInfo = S3.prepare(views, RES);
    // the view closest to facing the camera gives your proportions and rest pose
    const withLm = views.filter((v) => v.lm);
    if (!withLm.length) throw new Error('I never got a clear look at your pose. Try again with more light.');
    const front = withLm.reduce((a, b) => (Math.abs(Math.sin(b.theta / 2)) < Math.abs(Math.sin(a.theta / 2)) ? b : a));
    await step(0.3, 'Measuring you…');
    const fit = Fit.fitBody(views, front);
    const mesh = fit.mesh, normals = fit.normals;
    await step(0.5, 'Shaping your game body…');
    const ORES = { nx: 100, ny: 104, nz: 100, nu: RES.nu, nv: RES.nv };
    const { occ, c } = Fit.occupancy(fit.parts, ORES);
    await step(0.7, 'Painting on your real colours…');
    const Wts = S3.viewWeights(mesh, normals, views, occ, ORES, c);
    await step(0.92, 'Rigging your skeleton…');
    let face = null;
    if (faceCap) { try { face = Fit.faceMap(fit, faceCap, front); } catch (e) { console.warn('face', e); } }
    buildModel(mesh, normals, Wts, views, atlasInfo, front, fit.skin, face);
    Object.assign(model, { atlasInfo, weights: Wts, meshData: mesh, normals, title: makeTitle(front), reveal: 0, fitInfo: { skirt: fit.skirt, hair: fit.hair, face: !!face }, face });
    await step(1, 'Done');
    scan.state = 'done';
    buildEl.hidden = true;
    mirror.classList.remove('big');
    $('btn-scan').textContent = 'Rescan';
    setTimeout(sizeScanCanvas, 750);
    model.group.visible = true;
    ['btn-mode', 'btn-look', 'btn-glb', 'btn-poster'].forEach((id) => ($(id).disabled = false));
    S.done();
    for (const v of views) { v.rgba = null; v.mask = null; } // free the raw frames
    front.rgba = null;
  } catch (err) {
    console.error(err);
    buildEl.hidden = true;
    scan.state = 'failed';
    setBanner(`Scan failed <small>${err.message || err} Press Rescan.</small>`);
  }
}

// ======================================================================
// Scanner overlay on the camera view: skeleton, laser and the turn guide
// ======================================================================
function drawScanOverlay(person, t) {
  const cw = scanCv.width, ch = scanCv.height;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, cw, ch);
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (vw * s - cw) / 2, oy = (vh * s - ch) / 2;
  const pt = (p) => ({ x: p.x * vw * s - ox, y: p.y * vh * s - oy });
  const spinning = scan.state === 'spinning';
  if (person) {
    const lm = person.lm;
    sctx.strokeStyle = spinning ? 'rgba(90, 240, 255, 0.95)' : 'rgba(255, 207, 63, 0.9)';
    sctx.lineWidth = 2 * DPR;
    sctx.lineCap = 'round';
    const bones = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
    for (const [a, b] of bones) {
      if (lm[a].v < 0.5 || lm[b].v < 0.5) continue;
      const p = pt(lm[a]), q = pt(lm[b]);
      sctx.beginPath(); sctx.moveTo(p.x, p.y); sctx.lineTo(q.x, q.y); sctx.stroke();
    }
  }
  if (spinning || scan.state === 'building') {
    const y = (Math.sin(t * 2.2) * 0.5 + 0.5) * ch;
    const g = sctx.createLinearGradient(0, y - 40 * DPR, 0, y);
    g.addColorStop(0, 'rgba(90, 240, 255, 0)');
    g.addColorStop(1, 'rgba(90, 240, 255, 0.35)');
    sctx.fillStyle = g;
    sctx.fillRect(0, y - 40 * DPR, cw, 40 * DPR);
    sctx.fillStyle = 'rgba(200, 255, 255, 0.95)';
    sctx.fillRect(0, y, cw, 2 * DPR);
  }
}

// ======================================================================
// Backdrop: an original sunset city (2D canvas behind the 3D view)
// ======================================================================
function paintCity(c, w, h, s) {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3b1c6b');
  g.addColorStop(0.35, '#c2407a');
  g.addColorStop(0.62, '#ff8a4c');
  g.addColorStop(0.75, '#ffc46b');
  g.addColorStop(1, '#ffc46b');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const hz = h * 0.7;
  const sr = Math.min(w, h) * 0.22;
  const sg = c.createLinearGradient(0, hz - sr * 1.6, 0, hz);
  sg.addColorStop(0, '#fff2a8');
  sg.addColorStop(1, '#ff7a45');
  c.save();
  c.beginPath(); c.arc(w * 0.5, hz - sr * 0.35, sr, 0, TAU); c.clip();
  c.fillStyle = sg;
  c.fillRect(w * 0.5 - sr, hz - sr * 1.6, sr * 2, sr * 2);
  c.fillStyle = '#ff8a4c';
  for (let i = 0; i < 6; i++) c.fillRect(w * 0.5 - sr, hz - sr * 0.55 + i * sr * 0.16, sr * 2, sr * 0.025 * (i + 1));
  c.restore();
  c.fillStyle = 'rgba(255, 255, 255, 0.07)';
  const step = 14 * s;
  for (let y = 0; y < h * 0.4; y += step) for (let x = (y / step) % 2 ? step / 2 : 0; x < w; x += step) {
    c.beginPath(); c.arc(x, y, (1 - y / (h * 0.4)) * 3.2 * s, 0, TAU); c.fill();
  }
  let a = 11;
  const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  for (const [col, hmul, win] of [['#7a2f6e', 0.32, 0.25], ['#3d1a52', 0.22, 0.6]]) {
    let x = -10;
    while (x < w + 10) {
      const bw = (30 + rng() * 70) * s, bh = h * hmul * (0.35 + rng() * 0.75);
      c.fillStyle = col;
      c.fillRect(x, hz - bh, bw - 3 * s, bh);
      if (rng() < 0.35) c.fillRect(x + bw * 0.4, hz - bh - 18 * s, 3 * s, 18 * s);
      c.fillStyle = `rgba(255, 220, 140, ${win})`;
      for (let wy = hz - bh + 8 * s; wy < hz - 6 * s; wy += 11 * s) for (let wx = x + 5 * s; wx < x + bw - 10 * s; wx += 9 * s) if (rng() < 0.32) c.fillRect(wx, wy, 4 * s, 5 * s);
      x += bw;
    }
  }
  const palm = (px, ph, lean) => {
    c.strokeStyle = '#24102f';
    c.lineWidth = 9 * s;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(px, h * 0.86); c.quadraticCurveTo(px + lean * 0.5, h * 0.86 - ph * 0.5, px + lean, h * 0.86 - ph); c.stroke();
    c.fillStyle = '#24102f';
    const tx = px + lean, ty = h * 0.86 - ph;
    for (let i = 0; i < 7; i++) {
      const an = -Math.PI / 2 + (i - 3) * 0.55;
      c.beginPath();
      c.moveTo(tx, ty);
      c.quadraticCurveTo(tx + Math.cos(an - 0.4) * ph * 0.35, ty + Math.sin(an - 0.4) * ph * 0.35 - 10 * s, tx + Math.cos(an) * ph * 0.42, ty + Math.sin(an) * ph * 0.42 + ph * 0.12);
      c.quadraticCurveTo(tx + Math.cos(an + 0.2) * ph * 0.25, ty + Math.sin(an + 0.2) * ph * 0.25, tx, ty);
      c.fill();
    }
  };
  palm(w * 0.1, h * 0.5, 40 * s);
  palm(w * 0.18, h * 0.36, -25 * s);
  palm(w * 0.9, h * 0.55, -45 * s);
  const rg = c.createLinearGradient(0, hz, 0, h);
  rg.addColorStop(0, '#3a2348');
  rg.addColorStop(1, '#1f1029');
  c.fillStyle = rg;
  c.fillRect(0, hz, w, h - hz);
  c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  c.lineWidth = 2 * s;
  for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(w / 2 + sx * w * 0.06, hz); c.lineTo(w / 2 + sx * w * 0.9, h); c.stroke(); }
}

// ======================================================================
// Poster, title and export
// ======================================================================
const COLOR_NAMES = [
  ['CRIMSON', [190, 30, 45]], ['SCARLET', [235, 60, 40]], ['TANGERINE', [240, 130, 40]], ['GOLDEN', [230, 190, 50]],
  ['LIME', [140, 200, 60]], ['JADE', [40, 150, 100]], ['TEAL', [30, 140, 150]], ['SKY', [90, 170, 230]],
  ['COBALT', [40, 80, 180]], ['MIDNIGHT', [25, 30, 70]], ['VIOLET', [120, 60, 180]], ['ROSE', [230, 110, 160]],
  ['IVORY', [235, 230, 215]], ['SILVER', [170, 170, 175]], ['SHADOW', [40, 40, 45]], ['DESERT', [190, 150, 100]],
  ['COCOA', [110, 70, 45]], ['OLIVE', [110, 115, 60]], ['DENIM', [70, 95, 140]],
];
const NOUNS = ['ACE', 'RIDER', 'MAVERICK', 'LEGEND', 'DRIFTER', 'NIGHTHAWK', 'HUSTLE', 'BOSS', 'ROOKIE', 'WILDCARD', 'COMET', 'NOMAD'];
const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let shirtColor = [200, 60, 80];
function chestColor(front) {
  const { lm, w, h, rgba } = front;
  if (!rgba) return shirtColor;
  const p = { x: ((lm[11].x + lm[12].x) / 2) * 0.65 + ((lm[23].x + lm[24].x) / 2) * 0.35, y: ((lm[11].y + lm[12].y) / 2) * 0.65 + ((lm[23].y + lm[24].y) / 2) * 0.35 };
  const ch = [[], [], []];
  for (let dy = -6; dy <= 6; dy += 3) for (let dx = -6; dx <= 6; dx += 3) {
    const x = Math.round(p.x * w) + dx, y = Math.round(p.y * h) + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const o = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) ch[k].push(rgba[o + k]);
  }
  return ch.map((a) => a.sort((m, n) => m - n)[Math.floor(a.length / 2)] ?? 120);
}
function makeTitle(front) {
  if (front?.rgba) shirtColor = chestColor(front);
  const c = shirtColor;
  const name = COLOR_NAMES.reduce((best, n) => (cdist(n[1], c) < cdist(best[1], c) ? n : best))[0];
  return name + ' ' + NOUNS[Math.floor(Math.random() * NOUNS.length)];
}
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function starPath(c, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) { const an = (i / 10) * TAU - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr); }
  c.closePath();
}
function rgbHue([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

// the character alone, cropped from the 3D view
function snapshot(px = 900) {
  const prevVis = shadow.visible;
  shadow.visible = false;
  renderer.render(scene, camera);
  const w = renderer.domElement.width, h = renderer.domElement.height;
  const pts = [[-0.48, -0.02], [0.48, -0.02], [-0.48, 1.07], [0.48, 1.07]].map(([x, y]) => new THREE.Vector3(x, y, 0).project(camera));
  const xs = pts.map((p) => (p.x * 0.5 + 0.5) * w), ys = pts.map((p) => (1 - (p.y * 0.5 + 0.5)) * h);
  const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(w, Math.max(...xs)), y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(h, Math.max(...ys));
  const out = document.createElement('canvas');
  out.width = px;
  out.height = Math.round((px * (y1 - y0)) / (x1 - x0));
  out.getContext('2d').drawImage(renderer.domElement, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
  shadow.visible = prevVis;
  return out;
}

async function makePoster() {
  if (!model) return null;
  try { await document.fonts.load('80px Anton'); } catch (e) { /* fallback font */ }
  const PW = 1080, PH = 1350;
  const pc = document.createElement('canvas');
  pc.width = PW; pc.height = PH;
  const c = pc.getContext('2d');
  const hue = rgbHue(shirtColor);
  c.fillStyle = `hsl(${(hue + 180) % 360}, 65%, 55%)`;
  c.fillRect(0, 0, PW, PH);
  c.fillStyle = `hsl(${(hue + 30) % 360}, 75%, 60%)`;
  c.beginPath(); c.moveTo(PW * 0.55, 0); c.lineTo(PW, 0); c.lineTo(PW, PH); c.lineTo(PW * 0.25, PH); c.closePath(); c.fill();
  c.fillStyle = 'rgba(255, 240, 180, 0.55)';
  c.beginPath(); c.arc(PW * 0.62, PH * 0.38, PW * 0.36, 0, TAU); c.fill();
  c.fillStyle = 'rgba(26, 13, 42, 0.12)';
  for (let y = 0; y < PH; y += 22) for (let x = (y / 22) % 2 ? 11 : 0; x < PW; x += 22) {
    const r = 5 * clamp01(1 - Math.hypot(x - PW * 0.2, y - PH * 0.9) / (PW * 0.9));
    if (r > 0.3) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  }
  // the 3D character with a white sticker edge
  const shot = snapshot(900);
  const ch = PH * 0.86, cw = (shot.width / shot.height) * ch;
  const cx = PW * 0.6 - cw / 2, cy = PH * 0.97 - ch;
  const tint = (color) => {
    const cv = document.createElement('canvas');
    cv.width = shot.width; cv.height = shot.height;
    const x = cv.getContext('2d');
    x.drawImage(shot, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, cv.width, cv.height);
    return cv;
  };
  const sil = tint('#ffffff'), dark = tint(INK);
  c.globalAlpha = 0.35;
  c.drawImage(dark, cx + 18, cy + 14, cw, ch);
  c.globalAlpha = 1;
  for (let i = 0; i < 16; i++) { const an = (i / 16) * TAU; c.drawImage(sil, cx + Math.cos(an) * 10, cy + Math.sin(an) * 10, cw, ch); }
  c.drawImage(shot, cx, cy, cw, ch);
  const words = model.title.split(' ');
  c.save();
  c.translate(60, PH * 0.73);
  c.rotate(-0.07);
  c.lineJoin = 'round';
  words.forEach((wd, i) => {
    const size = i === 0 ? 120 : 170;
    c.font = `${size}px Anton, Impact, sans-serif`;
    const y = i === 0 ? 0 : 150;
    c.lineWidth = 22;
    c.strokeStyle = INK;
    c.strokeText(wd, 0, y);
    c.fillStyle = i === 0 ? '#ffcf3f' : '#ffffff';
    c.fillText(wd, 0, y);
  });
  c.restore();
  const rng = mulberry(model.seed || (model.seed = Math.floor(Math.random() * 1e6)));
  const stats = ['STAMINA', 'DRIVING', 'STEALTH', 'STYLE', 'LUCK'].map((n) => [n, 45 + Math.floor(rng() * 55)]);
  c.save();
  c.translate(56, 70);
  c.fillStyle = 'rgba(26, 13, 42, 0.85)';
  c.fillRect(0, 0, 380, 300);
  c.fillStyle = '#ffcf3f';
  c.fillRect(0, 0, 380, 8);
  c.font = '38px Anton, Impact, sans-serif';
  c.fillStyle = '#fff';
  c.fillText('PLAYER PROFILE', 24, 60);
  c.font = '600 20px Inter, sans-serif';
  stats.forEach(([n, v], i) => {
    const y = 100 + i * 40;
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText(n, 24, y + 16);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(160, y, 190, 18);
    c.fillStyle = v > 85 ? '#ffcf3f' : '#7be0ff';
    c.fillRect(160, y, 190 * (v / 100), 18);
  });
  c.restore();
  const rep = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < 5; i++) {
    c.fillStyle = i < rep ? '#ffcf3f' : 'rgba(26,13,42,0.35)';
    c.strokeStyle = INK;
    c.lineWidth = 5;
    starPath(c, PW - 330 + i * 62, 110, 26);
    c.fill(); c.stroke();
  }
  c.font = '26px Anton, Impact, sans-serif';
  c.fillStyle = INK;
  c.fillText('REPUTATION', PW - 360, 170);
  c.fillRect(0, PH - 64, PW, 64);
  c.font = '30px Anton, Impact, sans-serif';
  c.fillStyle = '#fff';
  c.fillText('SUNSET BAY  ·  CHAPTER ONE', 40, PH - 22);
  c.font = '500 18px Inter, sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.6)';
  c.textAlign = 'right';
  c.fillText('made with Mood Garden', PW - 32, PH - 26);
  return pc;
}

let posterUrl = null;
async function openPoster(newTitle) {
  if (!model) return;
  if (newTitle) model.title = makeTitle(null);
  const pc = await makePoster();
  pc.toBlob((blob) => {
    if (posterUrl) URL.revokeObjectURL(posterUrl);
    posterUrl = URL.createObjectURL(blob);
    $('poster-img').src = posterUrl;
    $('poster-save').href = posterUrl;
    $('poster-save').download = model.title.toLowerCase().replace(/\s+/g, '-') + '-poster.png';
    $('poster-view').hidden = false;
  }, 'image/png');
  S.shutter();
}

function glbBlob() {
  const colors = S3.bakeColors(model.meshData, model.weights, model.views, model.atlasInfo.atlas);
  const f = model.face;
  if (f) {
    const d = f.canvas.getContext('2d').getImageData(0, 0, 512, 512).data;
    for (let i = 0; i < f.w.length; i++) {
      const w = f.w[i];
      if (!w) continue;
      const x = Math.min(511, Math.floor(f.uv[i * 2] * 512)), y = Math.min(511, Math.floor((1 - f.uv[i * 2 + 1]) * 512));
      const o = (y * 512 + x) * 4;
      for (let k = 0; k < 3; k++) colors[i * 3 + k] = colors[i * 3 + k] * (1 - w) + (d[o + k] / 255) * w;
    }
  }
  return S3.toGLB(model.meshData.positions, model.normals, colors, model.meshData.indices);
}
function saveGLB() {
  if (!model) return;
  const url = URL.createObjectURL(glbBlob());
  const a = document.createElement('a');
  a.href = url;
  a.download = (model.title || 'avatar').toLowerCase().replace(/\s+/g, '-') + '.glb';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ======================================================================
// Sound
// ======================================================================
const sfx = new Sfx();
const S = {
  tick(p) { sfx.tone({ type: 'square', freqs: [[0, 400 + p * 800]], dur: 0.05, gain: 0.04 }); },
  go() { sfx.tone({ type: 'sine', freqs: [[0, 660], [0.2, 990]], dur: 0.3, gain: 0.15 }); },
  done() {
    sfx.hiss({ dur: 0.5, gain: 0.15, freq: 3000, q: 0.5 });
    [392, 523, 659, 784].forEach((f, i) => sfx.tone({ type: 'sawtooth', freqs: [[0, f]], dur: 0.3, gain: 0.05, delay: i * 0.08, filter: 1800, q: 0.7 }));
  },
  shutter() { sfx.hiss({ dur: 0.08, gain: 0.2, freq: 4000, q: 0.8 }); sfx.hiss({ dur: 0.1, gain: 0.15, freq: 2500, q: 0.8, delay: 0.09 }); },
  click() { sfx.tone({ type: 'triangle', freqs: [[0, 880]], dur: 0.05, gain: 0.06 }); },
};

// ======================================================================
// Loop and UI
// ======================================================================
function setStatus(st, text) { if (statusEl.dataset.state !== st) statusEl.dataset.state = st; if (statusText.textContent !== text) statusText.textContent = text; }
function setBanner(html) { if (banner.innerHTML !== html) banner.innerHTML = html; }

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min((now - last) / 1000, 0.25); // real time, for the scan timers
  const dt = Math.min(rawDt, 0.05);
  last = now;
  const t = now / 1000;
  if (tracker) tracker.update(now);
  const p = tracker?.people?.[0] || null;
  const person = p ? { lm: p.lm, raw: p.raw } : null;
  if (tracker && (tracker.running || tracker.fake) && (scan.state === 'waiting' || scan.state === 'spinning' || scan.state === 'face')) scanStep(rawDt, person);
  if (scan.state === 'done' && model) setBanner(model.title + (mode === 'live' ? ' <small>copies you live</small>' : ' <small>drag to spin</small>'));
  if (tracker?.running) setStatus(person ? 'active' : 'searching', person ? 'you’re in view' : 'looking for you');

  if (model && model.group.visible) {
    if (mode === 'live') {
      poseModel(person?.raw, dt);
      spinY += (0 - spinY) * ease(dt, 0.3);
    } else {
      poseModel(null, dt);
      spinY += (dragV + 0.5) * dt;
      dragV *= 1 - Math.min(1, dt * 2);
    }
    // grow in from the floor after building
    model.reveal = Math.min(1, (model.reveal ?? 1) + dt / 0.9);
    const e = 1 - Math.pow(1 - model.reveal, 3);
    rig.scale.set(-e, e, e); // mirrored, like the other pages
    rig.rotation.y = spinY;
    shadow.visible = true;
  } else shadow.visible = false;
  renderer.render(scene, camera);
  if (mirror.classList.contains('big')) cover.render(scan.state === 'spinning' ? scan.guide : scan.state === 'waiting' ? Math.sin(t * 0.8) * 0.5 : cover.angle + rawDt * 0.6, t);
  drawScanOverlay(person, t);
}

resize();
requestAnimationFrame(frame);

// drag to spin
let drag = null;
glCanvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX }; glCanvas.setPointerCapture(e.pointerId); });
glCanvas.addEventListener('pointermove', (e) => {
  if (!drag || !model) return;
  const dx = e.clientX - drag.x;
  drag.x = e.clientX;
  if (mode === 'live') setMode('turntable');
  spinY += dx * 0.01;
  dragV = dx * 0.4;
});
glCanvas.addEventListener('pointerup', () => { drag = null; });

function setMode(m) {
  mode = m;
  $('btn-mode').textContent = mode === 'live' ? 'Turntable' : 'Copy me';
}
$('btn-mode').addEventListener('click', () => { S.click(); setMode(mode === 'live' ? 'turntable' : 'live'); });
$('btn-look').addEventListener('click', (e) => {
  S.click();
  const toon = skinMat.uniforms.toon.value > 0.5 ? 0 : 1;
  skinMat.uniforms.toon.value = toon;
  outlineMat.uniforms.outline.value = toon ? 0.0045 : 0.0;
  e.currentTarget.textContent = toon ? 'Photo look' : 'Game look';
});
$('btn-glb').addEventListener('click', () => { S.click(); saveGLB(); });
setupToggle($('btn-mirror'), true, (v) => mirror.classList.toggle('hidden', !v));
setupToggle($('btn-audio'), true, (v) => sfx.setOn(v));
$('btn-scan').addEventListener('click', () => {
  sfx.init(); S.click(); setMode('live');
  if (!tracker) return;
  // while waiting, the button starts the turn straight away (if it can see you at all)
  if (scan.state === 'waiting') { scan.force = true; return; }
  if (scan.state === 'face') { build(scan.caps, null); return; }
  resetScan();
});
$('btn-poster').addEventListener('click', () => { sfx.init(); openPoster(false); });
$('poster-again').addEventListener('click', () => openPoster(true));
$('poster-close').addEventListener('click', () => { $('poster-view').hidden = true; });

enterBtn.addEventListener('click', async () => {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Booting scanner…';
  sfx.init();
  note.classList.remove('error');
  try {
    tracker ||= new PoseTracker(video, { numPoses: 1, masks: true });
    const loading = tracker.load();
    await tracker.startCamera();
    await loading;
    landing.classList.add('gone');
    hud.hidden = false;
    resetScan();
    requestAnimationFrame(resize);
  } catch (err) {
    console.error(err);
    tracker?.stopCamera();
    enterBtn.disabled = false;
    enterBtn.textContent = 'Try again';
    note.textContent = err?.name ? cameraErrorMessage(err) : 'Body tracking could not load. (' + (err?.message || err) + ')';
    note.classList.add('error');
  }
});

// testing hooks: build from prepared captures without spinning in front of a camera
window.avatar = {
  get scan() { return scan; },
  get model() { return model; },
  build: (caps, faceCap) => { scan = { state: 'spinning', caps }; return build(caps, faceCap); },
  capture: () => tracker?.capture(),
  setMode,
  poseModel,
  makePoster,
  glbBlob,
  skinMat,
  outlineMat,
};
