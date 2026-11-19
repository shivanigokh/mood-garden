# Mood Garden

**Your face changes the weather.**

Mood Garden is a living meadow that stretches to the horizon and reacts to your face and hands in real time through your webcam. Smile and the flowers open, blink and petals fall, frown and it starts to rain. A small mirrored view in the corner shows your face with its tracked mesh and hand skeletons, so you can see what the garden sees. The camera feed never leaves your device.

Built with plain HTML, CSS and JavaScript, [Three.js](https://threejs.org/) for rendering, and [MediaPipe Face Landmarker + Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) for tracking. There is no build step.

## Run it

### Online
If GitHub Pages is enabled for this repo, open **https://shivanigokh.github.io/mood-garden/** in Chrome, Edge, Firefox or Safari and click **Enter the garden**.

### Locally
Browsers only allow camera access on `https://` pages or on `localhost`, and ES modules don't load from `file://`, so serve the folder with any static server:

```bash
git clone https://github.com/shivanigokh/mood-garden.git
cd mood-garden

# pick one
python3 -m http.server 8000
npx serve .            # or: npx http-server -p 8000
```

Then open **http://localhost:8000** and click **Enter the garden**.

Everything the app needs (Three.js, the MediaPipe WASM runtime, and both `.task` models) is vendored in this repo, so it works offline after cloning. Only the two Google Fonts are loaded from the web, and the page falls back to system fonts without them.

### Camera permissions
- When you click **Enter the garden**, the browser asks for the camera. Click **Allow**.
- If you blocked it by accident, click the camera or lock icon in the address bar, set Camera to **Allow**, and reload.
- On macOS, also check *System Settings → Privacy & Security → Camera* and make sure your browser is enabled.
- If another app (Zoom, Teams, etc.) is using the camera, close it first.
- No camera? Choose **Wander without a camera** to explore; clicking the garden plants flowers and sends ripples.

## How to play

| You do | The garden does |
| --- | --- |
| **Smile** (graded, not on/off) | Flowers open in a wave, plants grow, light warms to peach and gold, pollen gets lively, lantern pods glow |
| **Blink** | A soft drift of petals falls from the trees and sky (once per blink, never repeats while your eyes stay closed) |
| **Raise eyebrows** | Wind rises: grass ripples, trees and flowers sway, clouds and particles race |
| **Open mouth** | A pulse of light expands outward through the grass, flowers, trees and particles |
| **Tilt head** | The horizon tilts with you; turning or moving your head shifts the perspective |
| **Furrow brows / angry face** | A storm rolls in: plum-red sky, darker light, gusty wind, agitated embers, flowers close, lightning and thunder |
| **Frown / sad face** | Rain falls, flowers and grass droop, light turns cool blue-grey, fog thickens |
| **Relaxed face** | Everything eases back to rest, while the garden keeps breathing and swaying on its own |
| **Open palm** | A warm wisp follows your hand, drawing light and petals into a swirl; nearby flowers lean in and bloom |
| **Fist** | Pushes particles, petals and grass away |
| **Pinch** (thumb + index) | Plants a new flower where you point; it grows in |
| **Wave** | A quick hand movement sends a gust of wind |

Controls (top right): show/hide your face view, camera on/off, ambient sound on/off, reset garden, and the interaction guide. Press **D** for live signal meters, which help when tuning lighting or position.

**Tips:** face the camera with even, front lighting. The first second after your face is found is spent learning *your* neutral face; keep it relaxed. If expressions feel off (for example after changing seat or lighting), press **Reset** to re-learn.

## Feast (the food game)

Use the **Garden / Feast / Studio** switch at the top of the page to open **Feast**, a second face-controlled experience. Food falls, drifts and gets tossed in from the sides over your mirrored camera view. Move your head to put your mouth under it and **open your mouth** to eat it.

- A ring follows your mouth. It turns gold when your mouth is open, which is when you can catch food.
- Catch treats quickly one after another to build a combo (up to ×6). 🌟 is worth 50.
- Food that hits a closed mouth bonks off.
- Eating a 💣 costs one of your three lives.
- A round lasts 60 seconds and gets faster as it goes. Your best score is saved in this browser.
- Press **Space** or **P** to pause. The game also pauses when you switch tabs or step out of frame.

The game runs on the same on-device tracker as the garden, so nothing is uploaded.

## Studio (hand music)

**Studio** in the top switch turns your hands into instruments. It runs only the hand model, so it starts quickly. Turn your sound on, then pick an instrument at the bottom of the screen (or press **1**, **2** or **3**).

- **Harmonium.** Hold up both hands, palms facing, as if holding the bellows. Move your hands apart and together to pump air. The faster you pump, the louder it plays, and it keeps sounding briefly after you stop, like real bellows. Raise or lower your hands to pick the note, shown as Sa Re Ga Ma Pa Dha Ni Sa down the right edge. A low Sa and Pa drone plays underneath.
- **Air drums.** Strike down through a pad with your index fingertip: hi-hat, snare, kick, tom and crash. A harder, faster strike plays louder. Lift your hand to re-arm.
- **Theremin.** Your right hand's height sets the pitch, sliding smoothly over three octaves. Your left hand's height sets the volume. With one hand, opening it makes the sound louder.

The hand button in the top right hides or shows the hand outlines. All sound is synthesised live with Web Audio. There are no samples.

## How it works

```
index.html      the garden: landing screen, HUD, guide
feast.html      the food game (feast.css, js/feast.js)
studio.html     hand-played instruments (studio.css, js/studio.js)
style.css       visual styling (no frameworks)
js/main.js      app wiring: camera flow, UI, main loop, events
js/tracking.js  camera, expression maths, smoothing, gesture detection
js/tracker-worker.js  runs the MediaPipe models in a Web Worker
js/garden.js    Three.js world: meadow, grass shader, instanced flowers, trees, weather
js/audio.js     generative Web Audio ambience (no audio files)
vendor/         three.module.min.js (r170), @mediapipe/tasks-vision 0.10.14
models/         face_landmarker.task, hand_landmarker.task
```

**Expression detection.** Each signal combines face-mesh geometry with MediaPipe's blendshape scores, measured relative to a personal baseline captured when your face first appears (and slowly re-adapted while you're neutral):

- **Smile**: mouth-corner lift and mouth widening (landmarks 61, 291, 13, 14) + `mouthSmile` blendshapes → continuous 0..1 intensity.
- **Blink**: 6-point eye aspect ratio for both eyes + `eyeBlink`. Fires on the closing edge with hysteresis (closes above 0.6, must reopen below 0.32) and a short cooldown, so a held closure never retriggers.
- **Eyebrows**: brow-to-eyelid distance normalised by face height + `browInnerUp`/`browOuterUp`.
- **Mouth open**: inner-lip gap over mouth width + `jawOpen`. The pulse fires once per opening, with a 1.1s cooldown.
- **Head tilt**: roll from the outer eye corners; yaw and pitch from the nose relative to the cheeks and eyes.
- **Angry**: `browDown`, inner-brow gap narrowing, brow lowering, `noseSneer`; suppressed by smiling or raised brows.
- **Sad**: `mouthFrown`, mouth corners dropping, inner brows raised more than outer, lip press; suppressed by smiling.

Every value runs through frame-rate-independent exponential smoothing with separate rise and fall times, and the garden smooths again on its side, so changes arrive gradually rather than snapping.

**Hands.** Up to two hands. Palm openness is fingertip reach divided by palm size; pinch is thumb-to-index distance with hysteresis; hand speed drives wind gusts. The hand's screen position is projected into the garden.

**Smooth motion.** The face and hand models run in a Web Worker, so the 3D scene never waits on them (falls back to the main thread if the browser can't, or add `?noworker` to the URL). Flowers, trees, lantern stalks and the camera all move on damped springs, stems bend along a curve in the vertex shader, and grass and flowers ride the same travelling wind waves, so movement flows instead of snapping. If frames drop below ~45 fps the garden lowers resolution and grass density automatically.

**Privacy.** Video frames go from the `<video>` element straight into MediaPipe's on-device WebAssembly/WebGL models. The mirrored preview is drawn only on your screen. Nothing is recorded, stored or uploaded, and turning the camera off stops the stream.

## Testing without a camera

Open the browser console:

```js
moodGarden.simulate({ smile: 1 })     // also: brow, mouth, angry, sad, roll, yaw, pitch
moodGarden.blink(); moodGarden.pulse(1); moodGarden.plant(0.5, 0.7)
moodGarden.stopSimulating()
```

## Credits

Three.js (MIT), MediaPipe Tasks Vision and models (Apache 2.0). Garden code MIT.
