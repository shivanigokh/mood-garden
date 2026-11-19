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

Use the **Garden / Feast / Studio / Shadows / Pet** switch at the top of the page to open **Feast**, a second face-controlled experience. Food falls, drifts and gets tossed in from the sides over your mirrored camera view. Move your head to put your mouth under it and **open your mouth** to eat it.

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

## Shadows (hand shadow puppets)

**Shadows** turns the screen into a lamp-lit wall. Your hands cast soft shadows on it, and certain shapes come alive when you hold them still for about a second. You can also call any animal from the row of names at the bottom.

| Shape | Animal |
| --- | --- |
| Index and little finger up, middle fingers tucked | **Dog** |
| Two fingers up in a V | **Rabbit** |
| Three fingers up, little finger tucked | **Deer** |
| Thumb and little finger out, the rest curled | **Cat** |
| Thumbs-up | **Elephant** |
| One pointing finger | **Snake** |
| OK sign (thumb and index tips touching) | **Swan** |
| Both hands open, thumbs hooked side by side | **Bird** |
| Both hands open, crossed at the wrists | **Butterfly** |
| Two flat hands, one above the other, like jaws | **Crocodile** |

Once an animal jumps off your hand, it plays with it. It comes over and follows your hand along the floor, and when several are around they take turns. Hold your hand low and it sniffs or nuzzles it; stroke over it with an open hand to pet it (hearts, wagging, purring). Hold your hand higher and dogs, cats, rabbits and deer jump for it, the elephant reaches with its trunk and trumpets a spray of water, the snake rears up and flicks its tongue, the crocodile lifts its open jaws (and snaps at a hand that darts past), and the swan bends its neck to you. Birds and butterflies land on a still hand. A fast swipe startles everyone.

The silhouettes are built from smooth tapered curves with real walk cycles (two-bone leg IK, stance and swing), tails and ears that swing with a lag, and turns that pivot instead of flipping. Hand landmarks are filtered and lightly predicted between detections, so the shadows glide at the display frame rate.

## Mirror Pet

**Pet** is Pip, a soft little creature who copies your face continuously. Every MediaPipe blendshape drives a matching control on Pip, smoothed only lightly so it keeps up: each eye's blink, squint, widening and gaze; each brow's inner and outer lift and frown; cheek raise and puff; and the mouth's jaw drop, each corner's smile and frown, stretch, pucker, funnel, upper and lower lip and sideways shift. Your head's tilt, turn and nod come straight from the face landmarks. Pip mirrors you like a mirror would: wink your left eye and Pip winks the eye on the left of the screen.

On top of that Pip reacts. A big smile brings blushes, hearts and bounces, and a laugh gets giggles. Surprise makes it jump, sadness brings tears and a little rain cloud, and a scowl makes it go red and steam. A kiss pout sends hearts. Look away and Pip falls asleep, then wakes up when you come back. Click Pip for a boop.

## Party (motion minigames)

**Party** is a set of four original minigames you play with your whole body, for one player or two standing side by side (two people in view becomes a head-to-head). MediaPipe Pose tracks shoulders, arms, hands and head; the camera fills the screen in true colour and the games are drawn over you.

| Game | How you play |
| --- | --- |
| Balloon Burst | Pop rising balloons with your hands. Gold is worth 3; grumpy storm clouds cost 2. |
| Pump Dash | Pump your arms up and down to sprint against three rival runners. Hand speed is your running speed. |
| Duck & Dodge | Move your head to catch coins and stars and avoid falling rocks. A red stripe flashing at head height zaps a moment later, so duck or stand tall. |
| Strike a Pose | A wall rushes toward you with a pose on it. Match the glowing arm outline (it turns green when you're close) for OK, Good or Perfect. |

Play all four as a party (stars per game, a final title or a champion's crown) or pick one. Raise both hands above your head to start or continue without touching anything. Best scores stay in your browser.

## Fish Tank

**Tank** is an aquarium you play with your hands. Clownfish, a school of neon tetras, angelfish, fancy goldfish and puffers swim with real body waves, school with their own kind and keep out of each other's way, among swaying weed, coral, rocks and a treasure chest that breathes bubbles.

| Gesture | What happens |
| --- | --- |
| Point one finger | Fish come to your fingertip and circle it, so you can lead them around. |
| Pinch | Sprinkles food from the pinch. Fish race for the flakes, and get full after a few. |
| Open hand | Pushes a current the way you move it, bending the weed and drifting the fish. |
| Fast swipe | Scatters the fish. Puffers puff up. |

No camera? Click to drop food and drag to stir. **Draw a fish** opens a sketch pad (colours, brush, fill, eraser, undo). Draw with the mouse or a finger, or pinch in the air to draw with your hand, name it and release it. Your drawing is sliced into strips that ride the same swimming wave as the other fish, it turns to face where it swims, and it stays in the tank (saved in this browser, up to 12).

## Avatar (3D spin scan)

**Avatar** scans you into a rotatable, rigged 3D game character built from your real camera images. Stand back so the camera sees you head to toe, arms a little out from your sides, and hold still. Then turn slowly on the spot, all the way round to your left, following the guide (about 18 seconds). A capture is taken every 15° of turn, 24 in all, and each one keeps the camera frame plus MediaPipe's body mask for that moment. Turning is tracked from the pose: the guide only moves on while you're in view, and each capture's angle is refined from the 3D shoulder line.

When the turn is done, it asks you to walk up close and look straight at the camera for one face photo (from across the room your face is only a few pixels wide). That close-up is lined up with the spin by your eyes and wrapped onto the front of the head, so the face is sharp. You can skip it.

Then the page builds the model in your browser:

1. **Line up.** People never turn at exactly the guide's pace, so each shot's angle is corrected first: for every shot, nearby angles are tried on a coarse grid and the one that carves away the least of what the other shots can see wins.
2. **Fitted game body.** Carving a body straight from webcam outlines comes out lumpy, so instead a smooth, game-style body is built and every part is sized to you: head (hair included) from the outline at eye height and the side shots, torso width from the front shot and depth from the side shots, hips or a skirt or dress down to where your outline splits into two legs, each leg following its own outline, and arms and hands placed on your joints. Hair is its own shape: its colour is read from the back of your head, then its length and width down your back are traced in the back shot, and any strands falling forward over your shoulders are traced in the front shot.
3. **Paint.** Every point on the surface is coloured from the camera frames that faced it best and actually saw it (not hidden behind an arm), mostly from the single best shot so it stays sharp, and dark shots are brightened a little. Your face, hair and clothes come from the photos themselves, not a palette.
4. **Look.** A toon shader (banded light, rim light, ink outline) gives it the game look. **Photo look** switches to plain photo texture.
5. **Rig.** The mesh gets an 11-bone skeleton placed from your landmarks, and **Copy me** poses it from your live body. **Turntable** spins it, and you can drag to rotate.

**Save 3D** downloads a .glb (vertex-coloured mesh, opens in Blender, Windows 3D Viewer and most game engines). **Make poster** builds a loading-screen style poster with the 3D render you can save as a PNG. All artwork, type treatment and names are original, and nothing leaves your computer.

**What a webcam scan can and can't do.** One webcam and a turn give the body's real outline, proportions and your actual colours and textures, which is enough to read as you. The body shape is a clean game body sized to you rather than an exact sculpt, so the nose, fingers and folds come from the photo texture, not the 3D shape. The top of the head and under the arms are never seen side-on, so they're filled in. For best results use even light, a plain uncluttered background, clothes that contrast with it, and a slow, steady turn on the spot.

## How it works

```
index.html      the garden: landing screen, HUD, guide
feast.html      the food game (feast.css, js/feast.js)
studio.html     hand-played instruments (studio.css, js/studio.js)
shadows.html    hand shadow puppets (shadows.css, js/shadows.js)
pet.html        Pip the mirror pet (pet.css, js/pet.js)
party.html      motion minigames (party.css, js/party.js)
tank.html       hand-played aquarium with drawn fish (tank.css, js/tank.js)
avatar.html     3D spin scan into a game character (avatar.css, js/avatar.js)
js/scan3d.js    shot measuring and alignment, projective texturing, rig and .glb export
js/fitbody.js   the fitted game body, sized from your front and side shots
js/scan-cover.js  the live figure that shows what's scanned and what's still to scan
js/body.js      full-body tracking (MediaPipe Pose) with one-euro smoothing
js/pose-worker.js  runs the pose model in a Web Worker
js/shared.js    small helpers and a creature-sound synth for Shadows and Pet
js/puppets.js   shadow-puppet silhouettes and their animation rigs
style.css       visual styling (no frameworks)
js/main.js      app wiring: camera flow, UI, main loop, events
js/tracking.js  camera, expression maths, smoothing, gesture detection
js/tracker-worker.js  runs the MediaPipe models in a Web Worker
js/garden.js    Three.js world: meadow, grass shader, instanced flowers, trees, weather
js/audio.js     generative Web Audio ambience (no audio files)
vendor/         three.module.min.js (r170), @mediapipe/tasks-vision 0.10.14
models/         face_landmarker.task, hand_landmarker.task, pose_landmarker_lite.task
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
