# BitMotion

Help Scout [Bitmaker](https://helpscoutty.github.io/bitmaker/)'s dither
aesthetic, generated live in the browser instead of exported as a file.

Bitmaker takes an uploaded image, downsamples it to a block grid and
Atkinson-dithers it into a handful of Help Scout palette colours. BitMotion
runs the same pipeline, but the thing being dithered is a procedural field
evaluated every frame — so there is no image, no video, no request, and it can
loop exactly or never repeat.

**Start here:** open `index.html`, shuffle until you like something, hit **Copy
config**, and paste the result into `embed-example.html`. That round trip is
the whole workflow. Then read Performance before putting it on a real page.

---

## Install

```bash
npm install @helpscout/bitmotion
```

The scope is internal, so npm has to be authenticated against `@helpscout` the
same way it is for our other private packages.

```js
import BitMotion from "@helpscout/bitmotion";      // bundler or Node ESM
const BitMotion = require("@helpscout/bitmotion"); // CommonJS
```

The package is a single dependency-free UMD file, so the same build also drops
straight into a `<script>` tag and leaves `BitMotion` on the window — which is
what the examples in this repo do:

```html
<script src="node_modules/@helpscout/bitmotion/bitmotion.js"></script>
```

TypeScript declarations ship with it. The GIF / video / PNG tooling is a
separate entry point, `@helpscout/bitmotion/export`, and belongs in tooling
rather than on a live page.

Importing it during a server-side render is inert: with no DOM there is nothing
to mount and `window` is never touched.

## Files

| File | Ship it? | What it is |
| --- | --- | --- |
| `bitmotion.js` | **Yes** | The engine. The only file a live page needs. 47KB raw, 15.6KB gzipped, no dependencies. |
| `embed-example.html` | Reference | A complete working hero, configured the way it should ship. Copy the pattern, not the file. |
| `index.html` | **No** | Playground for choosing a look and exporting previews. Internal tool. The Field, Quantiser and Cell-ceiling controls are commented out in the markup rather than deleted — the JS checks for each element before binding, so putting one back is a markup-only edit. |
| `bitmotion-export.js` | **No** | GIF / video / PNG-sequence encoders for the playground. Has no place on a production page — it roughly doubles the payload for something a visitor never uses. |
| `react.cjs`, `react.mjs` | **Yes**, for React | The React wrapper, `@helpscout/bitmotion/react`. `react.cjs` is the implementation; `react.mjs` is an ESM view of it, so there is only ever one copy. Imports `react`, nothing else. |
| `package.json`, `bitmotion.d.ts`, `bitmotion-export.d.ts`, `react.d.ts` | Packaging | npm metadata and TypeScript declarations. The `files` field is what ships: the two runtime files, their types and this README. |
| `test/` | **No** | `npm test`. `dom.mjs` stands up the smallest DOM the engine touches; `smoke.mjs` drives the mount layer, the frame cap and both upscale modes against it; `react.mjs` drives the component with a miniature React; `worker.mjs` runs the generated worker script in a `node:vm` context with a worker's globals and none of a page's. The repo installs nothing, which is why React and the worker are simulated rather than real. Not a pixel test. |
| `mask-test.html` | **No** | Scratch harness: paints the falloff mask on its own — no field, no ramp, no dither — as a 3×3 grid of the nine anchors, with live `falloff` / `inset` / `morph` / phase sliders. The silhouette and its gradient are hard to judge through the artwork, and impossible to judge through the dither; this shows the mask itself. Reach for it before touching anything in `_maskParams` or `_prepMask`. |

## Running it

The playground has no build step and no dependencies of its own. **Open
`index.html` in a browser** — double-clicking it off the filesystem is enough. Everything is
plain classic `<script>` tags in the same directory, with no `fetch`, no ES
modules and no external assets beyond a Google Fonts stylesheet that has a
fallback stack, so `file://` has nothing to trip over.

If anything does look off there, serve the folder instead and use that:

```bash
python3 -m http.server 8731
```

Then open `http://localhost:8731/index.html`.

**One local-dev gotcha with the server:** `python3 -m http.server` sends no
cache headers, so after editing `bitmotion.js` a browser will happily keep
serving the copy it already has — the playground looks like your change did
nothing. A hard reload (cmd-shift-R) or "Disable cache" in devtools fixes it.

---

## Integration

```html
<canvas id="hero" style="width:100%;height:460px"></canvas>
<script src="bitmotion.js"></script>
<script>
  BitMotion.create({
    canvas: "#hero",
    cellSize: 3,
    maxCells: 200000,
    fps: 20,
    seed: 1834027461
  });
</script>
```

Three rules:

1. **Size the canvas with CSS only.** No `width`/`height` attributes. The
   engine reads the rendered box, picks an integer cell size so blocks stay
   crisp, and re-derives the grid on resize.
2. **Always set `maxCells` in production.** See the performance section — it is
   the difference between a safe hero and a long task on every frame.
3. **Set a `seed`** unless you want a different composition on every page load.

`create()` returns an instance with `play()`, `pause()`, `seek(seconds)`,
`reseed(n)`, `setOption(key, value)` and `destroy()`. Call `destroy()` on
teardown in a SPA — it releases the resize listener and the
IntersectionObserver.

### Mounting from markup

Every `[data-bitmotion]` element on the page is mounted once the DOM is ready,
so a canvas and an attribute are enough — no script of your own:

```html
<canvas data-bitmotion='{"cellSize":3,"maxCells":200000,"seed":1834027461}'
        style="width:100%;height:460px"></canvas>
<script src="/assets/bitmotion.js"></script>
```

Options can also be written one per attribute, which is far easier inside a
template or a CMS field. The name is the option in kebab-case, values are
coerced (`"3"` to a number, `"false"` to a boolean, a bare attribute to `true`,
anything JSON-shaped parsed as JSON), and an attribute beats the same key in
the JSON blob:

```html
<canvas data-bitmotion
        data-bitmotion-scene="waves"
        data-bitmotion-cell-size="3"
        data-bitmotion-max-cells="200000"></canvas>
```

Put `data-bitmotion` on something that is not a canvas and it gets one that
fills it — useful when the sizing already lives on a wrapper. A malformed JSON
blob warns and falls back to the defaults rather than leaving the page blank.

Three calls manage what the markup started:

| Call | What it does |
| --- | --- |
| `BitMotion.init(target?, overrides?)` | Mounts markup that arrived after load. `target` is a selector, element, NodeList or array, and defaults to `[data-bitmotion]`; `overrides` beat the attributes. An element already running is returned untouched, so calling it repeatedly is safe. |
| `BitMotion.get(elementOrSelector)` | The instance mounted on an element, or `null`. |
| `BitMotion.destroyAll()` | Tears down everything `init` mounted. |

In a SPA that means `BitMotion.init()` after render and `destroyAll()` on
teardown.

### React

```jsx
import BitMotionCanvas from "@helpscout/bitmotion/react";

<BitMotionCanvas
  scene="drift"
  cellSize={3}
  maxCells={200000}
  seed={1834027461}
  className="hero"
  style={{ width: "100%", height: 460 }}
/>
```

Every engine option is a prop. Anything that is not an option — `className`,
`style`, `id`, `aria-*`, event handlers — lands on the `<canvas>` untouched,
and `ref` gives you that canvas. React is a peer dependency, and this is the
only part of the package that imports it.

The engine is resolved once per page no matter how many canvases mount, and a
`window.BitMotion` already on the page (from a `<script>` tag) is used in
preference to the bundled copy, so a page can never end up running two.
`getBitMotion()` is exported if you need the engine imperatively.

Changing a prop updates the running instance in place — `setOption` for most
of them, `reseed` for `seed`. Only `size`, `grid`, `maxCell`, `worker` and
`workerUrl` rebuild the instance: the first three are read while the grid is
being laid out, and the last two decide which thread it is laid out on. A prop
you stop passing keeps its last value: React cannot know what it should revert
to.

`worker` is a prop like any other, so a component that shares a page with
animated UI is `<BitMotionCanvas worker fps={30} … />`.

Three props are the component's own:

| Prop | What it does |
| --- | --- |
| `fadeIn` | Hold the canvas at opacity 0 until there is artwork on it, then transition it in. `fadeIn` fades over 400ms, `fadeIn={900}` sets the duration. |
| `paused` | Play state after mount. Leave it off to let `autoplay` decide and drive the instance yourself. |
| `onReady` | Called once with the instance, for imperative work — `seek`, or holding it for later. |

`fadeIn` exists because "finished loading" is not the same moment on both
paths: on the page the first frame is painted inside `create()`, but with
`worker: true` the canvas is genuinely blank until the worker reports back, and
a canvas that pops in is the part people notice. The engine's `onFirstFrame`
option is the underlying signal, and it fires at the right moment either way.

Under `prefers-reduced-motion` the canvas appears without the transition. The
canvas also carries `data-state="loading" | "ready"` whether or not `fadeIn` is
set, so a page can do its own thing in CSS:

```css
canvas[data-state="loading"] { filter: blur(8px); }
canvas[data-state="ready"]   { filter: none; transition: filter 600ms; }
```

Mounting starts the animation and unmounting destroys it, so a route change
releases the resize listener and the IntersectionObserver with no teardown code
of your own.

### Picking a look

Open `index.html`, shuffle until you like a composition, then hit **Copy
config** — it emits a paste-ready `BitMotion.create({...})` with only the
options that differ from defaults, including the seed. That is the intended
designer-to-developer handoff; nobody should be hand-tuning numbers.

The **Background** swatches set the colour the artwork sits on, and the
playground restyles the stage to match so the preview is honest. When the
emitted config carries a `background`, the container it goes into needs that
same colour — see [Backgrounds](#backgrounds).

The export panel deliberately has no settings of its own beyond output size
and file format: block size, cycle length and frame rate all come from the
console, so the file matches what was on screen. One consequence worth
knowing: because block size is fixed in pixels, exporting at 1920 wide from a
narrower preview yields a finer grid — the same composition at higher
block resolution, not a scaled-up copy of the preview.

---

## Performance

This is the part that matters for a homepage.

**Payload is a non-issue.** 15.6KB gzipped, one file, no requests, no assets.

**Frame cost is linear in cell count**, at roughly 33ns per cell. Cells scale
with canvas *area*, so cost grows with viewport width whether you want it to or
not. Measured on a 1200×520 hero at 2× DPI, live at 20fps:

| Blocks | Cells | ms/frame | p95 input delay |
| --- | --- | --- | --- |
| 6×6 | 69,200 | 2.3 | 8.4ms |
| 4×4 | 156,000 | 5.3 | 12.7ms |
| 3×3 | 277,600 | 9.1 | 13.9ms |
| 2×2 | 624,000 | 20.5 | 26ms |

Those numbers are an **idle Apple-silicon laptop**. A mid-range Windows laptop
or mid-tier phone runs single-threaded JS roughly 3–6× slower. Apply that
multiplier: 4×4 lands at 16–32ms and stays clear of the 50ms long-task
threshold; 2×2 lands at 60–120ms and becomes a long task on every frame, which
is what damages INP and shows up in Core Web Vitals.

The 3–6× multiplier is standard guidance, **not something measured here.** Run
Lighthouse on staging before shipping.

### `maxCells` is the guardrail

Because cost is linear in cells, a cell ceiling is a cost ceiling. The engine
grows the block size until the grid fits under it — same composition, coarser
blocks. Measured with `maxCells: 200000` at `cellSize: 2`:

| Canvas | Unguarded | With ceiling |
| --- | --- | --- |
| 700×460 | 10.3ms (2px blocks) | 5.3ms (3px) |
| 1200×520 | 20.6ms (2px) | 5.2ms (4px) |
| 1600×700 | 37.6ms (2px) | 6.0ms (5px) |
| 2400×900 | 71.0ms (2px) | 5.8ms (7px) |

Flat ~6ms at any width. Note the unguarded 2400×900 case: **71ms a frame on a
fast Mac** is already a long task, from nothing but a wide monitor.

It is a ceiling, not a target, and block sizes are whole pixels — so it can
undershoot. On a 1200×520 hero a 200k ceiling steps 2px blocks (231k cells) to
3px (103k cells), because there is no integer block size in between. Both a
200k and a 120k ceiling land on the same 3px grid there.

`maxCells` does not affect exports — those aren't real-time and render at
exactly the block size requested.

A GIF frame delay is a whole number of centiseconds, so only rates that divide
100 are exact: 20 and 25 are, 30 is not (it plays at 33.3). The export plan
says so when it applies.

Because block size is exact, an output size the block size does not divide
comes out a pixel or two short — 1280 wide at 6px blocks is 1278. The plan
reports the true dimensions, and the reserved margin means nothing is lost.
1920×1080 divides evenly at 2, 3, 4, 5, 6, 8, 10 and 12px.

### Sharing a page with CSS transitions

A hero that is fine on its own can still be what makes a menu, an accordion or
a hover state elsewhere on the page feel rough. Three things cause that, and
each has a lever.

**1. The frame cap has to be a real cadence.** The loop draws on the display's
frames, so a cap is only met if it divides the refresh rate. Until recently the
gate compared against exactly `1/fps` and reset its phase on every draw, which
rounded every interval up to the next whole frame:

| Display | Asked for | Delivered | Gap between draws |
| --- | --- | --- | --- |
| 60Hz | 30fps | 24.1fps | alternating 2 and 3 frames |
| 60Hz | 20fps | 17.1fps | alternating 3 and 4 |
| 120Hz | 30fps | 26.7fps | alternating 4 and 5 |

It now carries the remainder and allows half a display frame of slack, so 30fps
is 30.0fps on a constant two-frame cadence at 60Hz and a four-frame one at
120Hz. That evenness is worth as much as the rate: every drawn frame is the
expensive one, so an irregular cadence is what the rest of the page feels.
`fps: 30` is the setting to use next to anything animated; the default stays at
20, which is enough for the artwork on its own.

**2. Each drawn frame re-uploads the whole canvas.** In the default `upscale:
"canvas"` mode the backing store is the finished artwork — a 1200×460 hero at
2× DPI is 2400×920, 2.2M pixels, ~8.8MB re-rastered and re-uploaded *per
frame*, ~265MB/s at 30fps. None of that shows up in a JS profile.

`upscale: "css"` makes the backing store the grid itself (600×230 for that
hero, **16× less**) and lets the compositor scale it on the GPU, which is free.
`image-rendering: pixelated` keeps the edges hard. The trade is that the scale
factor is then whatever the element's box divides by: where it is not a whole
number, some blocks land a device pixel wider than their neighbours. That is
bounded by half a block, so at most `cell / 2` of the `gw` columns are affected
— under 0.5% in every viewport measured, and the same order as the stretch the
compositor already applies in `"canvas"` mode. The playground has an **Upscale**
toggle; flip it and look before shipping it.

**3. The render is still on the main thread.** Even at 3ms a frame it runs
inside the rAF callback, *before* style, layout and paint, so it delays the very
frame it shares. `worker: true` moves the whole pipeline into a worker via
OffscreenCanvas:

```js
BitMotion.create({ canvas: "#hero", worker: true, fps: 30, maxCells: 200000 });
```

The page keeps the element — its box, its visibility, its teardown — and posts
what it sees; the worker owns the pixels. Main-thread cost per frame goes to
zero, so no setting of `maxCells` or `cellSize` can make the artwork the reason
a transition stutters. `create()` returns a handle with the same control
surface (`play`, `pause`, `seek`, `setOption`, `reseed`, `setSize`, `destroy`)
and `usesWorker: true`.

It falls back to rendering on the page — silently, and before anything is
transferred — where the pieces are missing: no `Worker`, no `OffscreenCanvas`
(Safari before 16.4), or a Content-Security-Policy that refuses `blob:`
workers. For that last case, host two lines:

```js
// /assets/bitmotion-worker.js
importScripts("/assets/bitmotion.js");
BitMotion.startWorker();
```

and pass `workerUrl: "/assets/bitmotion-worker.js"`. No blob, no `eval`.

**And on the CSS side**, whatever the canvas is doing: transitions on
`transform` and `opacity` run on the compositor and survive a busy main thread,
while `width`, `top`, `color` and `box-shadow` do not. If a neighbour has to
animate one of those, `worker: true` is the fix rather than a workaround.

### Already handled

- Pauses rendering entirely when the canvas scrolls out of view
  (IntersectionObserver).
- Renders one static frame and stops under `prefers-reduced-motion`.
- Browsers throttle `requestAnimationFrame` to zero in background tabs, so
  there is no hidden-tab cost. In `worker: true` mode the loop runs on a timer
  instead, so the page posts the tab's visibility across and the worker stops
  with it.

### Video quality

This artwork is close to the worst case for a video codec: hard-edged blocks,
flat saturated fields, and a fifth of the cells changing every frame. Measured
against the engine's own render of the same frame (960×540, worst-channel
error per pixel):

| Codec | Mean err | Clean (≤2) | Off by >16 | Worst |
| --- | --- | --- | --- | --- |
| H.264 Baseline L3.0 @8Mbps | 3.51 | 81.8% | 4.3% | 103 |
| H.264 High L4.0 @40Mbps | 3.15 | 91.6% | 4.5% | 99 |
| **VP9 @20Mbps** | **1.55** | 86.4% | **0%** | **19** |

The column that matters is the outliers. H.264 leaves ~4.5% of pixels wrong by
up to 100 levels — visible blocking around every edge. VP9 has none beyond 16.

Two things worth knowing, because they are counterintuitive:

- **Raising the bitrate barely helps.** Both encoders settle far below the
  requested rate (H.264 used ~2Mbps of a 40Mbps budget), so the ceiling is the
  codec's own quality target, not the bitrate. VP9 is byte-for-byte identical
  at 20, 40 and 80Mbps.
- **No video option here is lossless.** Every one of these codecs subsamples
  chroma, which is exactly what rounds off the corners of saturated colour
  blocks. That is why the GIF looks perfect — it is an indexed, lossless
  format storing the five palette colours exactly. For an exact result, use
  the GIF or the PNG sequence; the video formats are for convenience.

The playground offers both video codecs explicitly rather than picking one
silently. MP4 exists for tools that require it.

### If you need 2×2 on a live page

Don't shrink the canvas — move the render off the main thread with a Web Worker
and `OffscreenCanvas`. Then input latency stops mattering regardless of frame
cost. This needs a main-thread fallback for older Safari, so it is real work,
not a flag. Not implemented here.

---

## Options

### Sizing — pick one

| Option | Default | Notes |
| --- | --- | --- |
| `cellSize` | `3` | **The sizing control.** Block size in output pixels — `4` means exactly 4×4 rendered pixels at any canvas size. |
| `resolution` | `96` | Alternative sizing, consulted only when `cellSize` is `0`. Fixes the cell *count* instead, so the composition looks identical at every breakpoint while blocks grow on larger screens. Not exposed in the playground; still worth knowing for a responsive hero. |
| `maxCells` | `0` (off) | Hard ceiling on total cells; grows blocks to fit. **Set this in production.** |
| `maxDpr` | `2` | Device-pixel-ratio ceiling. `1` quarters the cell count at some crispness cost. |

### Cost

| Option | Default | Notes |
| --- | --- | --- |
| `fps` | `20` | Frame cap. Met exactly when it divides the display's refresh rate — 20 and 30 both do on 60Hz. Use `30` next to anything animated. |
| `upscale` | `"canvas"` | `"css"` makes the backing store the grid and lets the compositor scale it: ~16× less to upload per frame, at the cost of the odd block landing a device pixel wider. See [Sharing a page with CSS transitions](#sharing-a-page-with-css-transitions). |
| `worker` | `false` | `true` renders in a worker through OffscreenCanvas, taking the main-thread cost to zero. Falls back to the page where that is unavailable. |
| `onFirstFrame` | `null` | Called once with the instance, as soon as there is artwork on the canvas — inside `create()` on the page, a message later in worker mode. What to wait for before fading a canvas in. |
| `workerUrl` | `null` | A worker file to use instead of the built-in blob, for pages whose CSP refuses `blob:` workers. |

### Look

| Option | Default | Notes |
| --- | --- | --- |
| `scene` | `"drift"` | `drift`, `waves`, `bloom`, `ribbon`, `nebula`, or `null` to cycle all. |
| `ramp` | `"dissolve"` | `dissolve`, `bleed`, `warm`, `cool`, `duo`, `ink`, or an array of `[stop, hex]` pairs. |
| `shape` | `"edges"` | Falloff mask: `edges`, `radial`, `none`. `radial` is a true circle measured in pixels, sized to the *farthest* frame edge, so on a frame that is not square it runs off the near sides — see the note below. |
| `origin` | `"center"` | Where the composition is anchored in the frame: one of the nine grid points — `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right` — or an `{x, y}` pair in 0–1 for anything between them. The field and its falloff move together, so the composition keeps its size and simply hangs off the side it is pinned to: a corner anchor leaves a quarter of it in frame and the rest outside. Nothing is laid out, only sampled, so the part outside costs nothing and cannot make the page scroll. |
| `falloff` | `0.7` | 0–1, how far the edge blurs **outward**. The silhouette has a fixed core and the fade grows out from it into the paper beyond, reaching the frame (less `inset`) at `1`. So softening makes the shape wider and taller, and `0` is the same shape with a hard edge. Size and softness move together; `inset` is what pulls the whole thing in. For `radial` on a non-square frame there is a value on the way up — around `0.35` at 16:10, lower the wider the frame — where the circle stops fitting between the near edges and starts running off them. |
| `inset` | `0.04` | Reserved paper margin as a fraction of the **short edge**. It holds on every side for `edges`, and for `radial` on the axis the circle is sized to — a big circle on a wide frame deliberately crosses the top and bottom, so there is no margin to keep there, converted per axis so the margin is the same number of pixels on all four sides. Also shrinks the field by the same fraction, so the composition fits the margin rather than being clipped by it. Raise it for more whitespace; this is what keeps an exported frame off its own edges. |
| `dither` | `"atkinson"` | `atkinson` (Bitmaker's), `bayer` (ordered, temporally calmer), `none` (flat blocks). |
| `exposure` | `0` | −1…1. Negative shows more paper. |
| `contrast` | `1` | >1 widens flat areas, <1 widens the stipple. |
| `background` | `#FAF8F7` | The colour the artwork dissolves into. Palette entries matching it render at alpha 0, and it is removed from the rest of the ramp — see below. `BitMotion.BACKGROUNDS` holds the five supported values. |
| `transparent` | `true` | `false` paints the background colour instead. |

### Backgrounds

`BitMotion.BACKGROUNDS` is the set of colours the artwork is designed to sit
on:

| Key | Hex | |
| --- | --- | --- |
| `clay` | `#FAF8F7` | default |
| `blue` | `#0064F0` | |
| `red` | `#FF856D` | |
| `lilac` | `#431379` | |
| `yellow` | `#FFDD99` | |

```js
BitMotion.create({ canvas: "#hero", background: BitMotion.BACKGROUNDS.blue });
```

Every one of them is also a ramp colour, so choosing one rewrites the ramp:
the chosen colour takes over the ramp's low stop — the one the artwork
dissolves into — and is dropped from wherever else it sat, with the surviving
stops respaced evenly over the ramp's authored range. `dissolve` on blue is
therefore blue → yellow → coral → purple, with no blue in the artwork itself.

With `transparent: true` (the default) those background cells are punched out
rather than painted, so **the container has to carry the same colour** —
otherwise the artwork dissolves into whatever is actually behind the canvas.
Set `transparent: false` and the engine paints it for you.

### Motion

| Option | Default | Notes |
| --- | --- | --- |
| `blobs` | `5` | 0–12. How many orbiting blobs `drift` composes with. Raising it makes the field busier and more likely to separate into islands; `0` leaves a bare gradient. Changing it rebuilds the composition. Costs about 0.2ms per blob at 278k cells. |
| `morph` | `0.6` | 0–1, how much the overall silhouette breathes and squashes across the loop. Drives both the outline (travelling edge warp, per-side breathing) and an antiphase squash-and-stretch of the composition itself. `0` freezes the shape. |
| `revolve` | `1` | Turns of the whole composition per loop, on **average**. The turn is not a constant sweep: in `flow` it surges, stalls for seconds at a time and occasionally drifts backwards before carrying on (about 2% of the time), wandering up to ±120° either side of where a constant spin would have put it. In `loop` the seam constrains it to a much gentler breathe. `0` holds the orientation fixed. `loop` rounds the value to a whole number, since half a turn would leave the composition upside down at the seam; `flow` never closes, so fractional values work there. |
| `mode` | `"flow"` | `flow` never repeats; `loop` is an exact cycle. |
| `loopSeconds` | `14` | One full cycle in `loop` mode. In `flow` mode it is the base tempo everything is detuned around. |
| `sceneSeconds` | `11` | Average seconds per composition in `flow` mode. Actual lengths are drawn per composition from 0.7x to 1.5x of it, so the cut is not a metronome. |
| `crossfade` | `3.5` | Seconds of blend between compositions. |
| `fps` | `20` | Render cap. The look holds up well below 30, which is where the playground's slider now stops — nothing above that buys anything here. |
| `seed` | `null` | Integer for a reproducible composition. Also drives the silhouette. |
| `autoplay` | `true` | |
| `respectReducedMotion` | `true` | |

---

## Design notes

Things that are the way they are on purpose. Changing them will look like a
regression.

**`#F5F2F0` is deliberately absent from the ramps.** Help Scout cream sits
three values from `#FAF8F7` paper, so cream cells don't read as a colour — they
read as a faint dirty rectangle behind the artwork, which is exactly the seam
the transparent background exists to avoid. Paper straight into yellow gives a
clean stipple fade. This is the one intentional palette deviation from
Bitmaker.

**The background colour is removed from the ramp, not just added to it.** A
cell in the background colour is a transparent cell — that is the whole
mechanism behind the dissolve. Leaving the background in the middle of the
ramp as well means the quantiser punches transparent holes through the centre
of the composition wherever the field passes through that value, which reads
as damage rather than as texture. So the colour appears exactly once, at the
low stop, and the survivors are respaced to close the gap: dropping a stop
without respacing leaves a wide flat stretch of one colour where two used to
blend. With the default clay background nothing is dropped and the respacing
reproduces the authored stops exactly, so that path is byte-for-byte
unchanged.

**The edge falloff fades in colour space, not by value.** Scaling the field
value toward zero walks each edge cell *down the ramp* through yellow and
coral, painting a visible border ring around the frame. Blending the resulting
colour toward paper instead lets each cell dissolve straight into the page.

**A strong margin has to move three things, not one.** `inset` pulls the
mask in, shrinks the field to match, and moves the window auto-levels measure
inside. Miss either of the last two and turning the margin up flattens the
artwork instead of framing it: the field gets squeezed into the window, the
screen outside it samples far beyond the scene's own 0..1 domain — where
`drift` is just its gradient still climbing — and levels taken over the whole
grid hand the range to those runaway values, leaving what is actually on show
inside a fraction of the ramp. The shrink is `1 - inset`, matching the window
the mask leaves rather than half of it, and the levels pass reads only that
window. Skipping the rest costs nothing: it is under paper. Full bleed has no
paper, so there the whole grid is measured as before.

**The fade grows outward from a pinned core, not inward from the frame.**
Which end of the band is nailed down decides what softening *does*. Anchored
at the frame — where this started — the only end that cannot move is the
outer one, so lengthening the gradient ate the solid core from both sides and
a softer falloff drew the composition in: exactly backwards. The core is the
pinned end now, at `CORE_R` of the way from the anchor to the frame, and the
band grows out from it into the paper beyond, reaching the frame at
`falloff` 1. Blur the edge and the shape gets bigger, which is what blurring
an edge does.

**The warp and the breathing move the CORE, not the outer end — which is
where the reach comes from.** Anything that displaces the outer end has to be
*reserved* against `inset`: the fade must finish short of the frame by the
warp's full amplitude plus the breathing's, at every angle and every phase,
or the peaks would cross the margin. That reserve came straight off the
reach, whether or not anything was at its peak. Wobbling the core costs
nothing, and it is the better place for it anyway — the core is where the ink
is dense enough to read an outline moving. It also self-damps: the outer end
is pinned, so the share of the wobble that reaches the visible boundary
scales with `1 - falloff` and disappears exactly when a wobbling silhouette
would stop making sense. `inset` now owns the outer limit outright, and the
only thing still spending reach is the per-side breathing of the frame
itself, which is kept to about a percent because sliding the whole window is
the point of it.

**The mask tables carry the fade's two ends already divided by their band.**
Wobbling the core means the band's *length* varies — per angle for the
radial, per row and per column for the edges — so the per-cell path would
need a divide. Precomputing `1/band` and `outer/band` into the same tables
that already existed turns it back into one multiply and one subtract, which
is fewer operations than the add-multiply-plus-warp-lookup it replaced.

**The mask curve is folded back on itself: `m * (2 - m)`.** A plain smoothstep
puts its half-way point half-way along the band, which spends half the fade
looking like a soft edge and half looking like nothing. Folding the curve
moves that point out to about a third of the band from the outer end: the
mass reaches further into the fade and the rest is a long, light tail — the
part the dither scatters into the page. Both ends keep a zero derivative, so
nothing gains an edge.

**The radial mask is a circle in PIXELS, sized to the farthest edge.** Two
separate things were wrong with measuring it per axis in normalised
coordinates, where 1 means the half-width horizontally and the half-height
vertically. It makes the shape an oval stretched to the frame rather than a
circle. And when the radius was additionally normalised by the half-diagonal
it put the entire fade band *outside* the canvas along the long axis — the
mask still near-opaque where the pixels ran out, the dither stopping against
a hard vertical line, which is the bug this all started with.

Distance is measured in cells, which are square, so it is a distance in
pixels and the shape is round. The unit is the distance from the anchor to
the farthest frame edge, so `falloff` 1 is a circle that reaches the far
side. A circle that big cannot also stay inside the near sides of a frame
that is not square, and it should not: it runs off them, the way a circle
fills a rectangle, which is what a banner wants and what the reference
artwork does. Winding `falloff` down shrinks it back inside; on a square
frame it never crosses an edge at any setting. The fade always finishes
inside the frame on the axis it is measured against, so `inset` still holds
there.

**The radial warp runs at whole cycles around the circle.** Its argument is an
angle, and an angle wraps: a fractional frequency comes back to `theta = -pi`
holding a different value than it left at `+pi`. That step falls on the left of
the frame, where `atan2` wraps, and shows as a notch cut into the silhouette —
a boundary disagreeing with itself, not a rendering artefact. The two edge
warps keep their fractional frequencies, because they run across the frame and
never meet themselves.

**The falloff mask edge is warped, and the warp is small on purpose.** A
straight edge-distance mask produces a rounded rectangle, which at high cell
counts reads as a vignette framing the art. The warp amplitude follows the band while the band
is short and saturates gently after that, at under one cycle across the
frame; larger amplitudes scallop the silhouette into what looks like a
decorative badge.

**`drift` is gradient-dominant with `gain > 1`.** The gradient sweeps past both
ends of the ramp, so the frame holds flat fields of the extreme colours with
the dithered transition bands between them — that banding is the Bitmaker
signature. The blobs only bend the bands. Blob-dominant fields normalise into a
saturated plateau with no interior detail.

**The mask is evaluated per frame, not baked.** It used to be a static
`gw*gh` array built once, which meant a lively drift revolving inside a frozen
window — the silhouette never changed. It is now recomputed every frame, and
that is affordable because of one decomposition: the x-warp is a function of
the ROW only and the y-warp of the COLUMN only, so a `gw + gh` pair of tables
replaces four sines per cell. The per-cell path is two adds, two multiplies
and two smoothsteps, with no trigonometry. Dropping the baked array actually
made it slightly *faster* than the static version, since that array was
megabytes of read traffic per frame.

**Breathing the mask alone is not enough, and it is worth knowing why.** The
mask is usually not what bounds the silhouette — the field's own falloff is —
so moving the mask edge barely shows. `morph` therefore also applies an
antiphase squash-and-stretch to the field transform, which is what visibly
changes the overall shape. The two screen axes scale by reciprocal factors so
the area stays roughly constant rather than pulsing bigger and smaller, and
both fold into the existing rotation matrix, so the per-cell cost is unchanged
at four multiplies.

**The video codec list is ordered deliberately, and H.264's profile matters.**
The default asked for `avc1.42E01E` — Baseline profile, level 3.0, which is
specified for 720×576 and lacks CABAC. It is now High profile level 4.0, and
VP9 is preferred over it entirely. Requested bitrates are deliberately far
above what either encoder uses, so that quality is never limited by the
budget; see Video quality in the performance section for the measurements.

**`inset` used to measure from the warp's outer envelope, and now nothing
displaces the outer end at all.** Worth knowing if you move the warp back:
the warp is bipolar, so at its positive peaks it pushes the boundary
*outward*. An inset applied naively to a boundary like that is an average
margin, not a floor, and the artwork can still touch the frame on some sides
— which is exactly how a GIF ends up looking cropped. The fix then was to
subtract the envelope bound; the fix now is that the warp and the breathing
are applied to the core instead, so the outer end is `inset` and nothing
else. Anything you add that moves the outer end has to pay for its own
envelope out of the reach.

**`mode` is baked in, not read per frame.** `detuner` is consulted when a
composition and a mask are *built*: in "loop" it leaves every rate at whole
cycles per loop, which is the only reason the seam closes, and in "flow" it
detunes them off each other so nothing ever repeats. Both capture that at
build time, so `setOption("mode", …)` has to rebuild the field and the mask
params — without it, switching to Loop leaves a piece whose every part ends
the cycle somewhere other than where it began, and the loop cuts at the wrap.
To check a change here, compare the seam against an ordinary frame step:
render N frames across the cycle, take the fraction of palette indices that
differ between neighbours, and the wrap should sit at the median of the
rest. A broken loop reads about twice that — the dither alone churns ~15% of
cells between any two frames, so eyeballing a still will not tell you.

**A linear gradient can only make parallel bands.** That is worth stating
plainly, because it is why `drift` used to look predictable: with the gradient
weighted far above the blobs, every composition was a set of parallel stripes,
and revolving parallel stripes just gives tidy rotating stripes. Colour only
separates into islands when the field has local extrema strong enough to close
a contour around themselves. So each composition now draws a balance —
gradient-led ones keep the classic banding, blob-led ones weaken the gradient
until the blobs carry the frame. Blob weights are heavier and signed (a blob
can carve a hole as readily as raise a peak), softness is weighted toward
tight, and each blob draws its own orbit direction rather than alternating by
index. Flattening any of that back out returns the stripes.

**In `flow` mode, nothing runs at a whole number of cycles per loop.** This is
the single biggest thing keeping a long look from reading as a short tape. Loop
mode needs the seam to close, so every rate in it — blob orbits, gradient
sweep, wave speeds, edge warp, squash, revolve — has to be a whole number of
cycles per `loopSeconds`. The consequence is that all of them share a common
period, and that period is the loop: the entire animation repeats exactly every
14 seconds, whether or not you asked it to. Flow mode never has to close, so
`detuner()` does two things to each rate. It nudges it off its whole number by
up to ±17% — detuned rates share no common period, so the parts drift in and
out of phase and the composition keeps arriving where it has not been — and it
scales every rate in a composition by one **tempo**, drawn per composition from
0.55x to 1.6x. The tempo is what stops the piece having a single gear: without
it the shapes changed every ten seconds but the *speed* never did, so each
composition was the same event in a new costume. Measured: a `drift` field one
full loop later used to be bit-identical; it now differs by about 29% of the
field's own amplitude, and the fastest composition in a run now moves 3.3x
faster than the slowest (it was 1.9x). Rounding those rates back to integers
restores the repeat.

**Blob orbits are epicycles, not circles.** One circle traced at a constant
rate is the most predictable path there is — watch a blob round the top and you
know the rest of the pass. Each blob now carries a faster counter-turning
epicycle and a slow breathing of the orbit's own size, so it loops, stalls and
swings wide instead of retracing the same ellipse. The orbit radius is scaled
back by the combined peak of both, or the blobs would simply swing further
off-frame and spend more of the loop invisible.

**`revolve` modulates its rate, and the two modes need different numbers.** The
wobble terms are added to the *angle*, which modulates the rate. `loop` has to
close, which forces whole cycles per loop; a wobble at one cycle per loop can
only displace the composition a little before it has to come back, so it just
breathes. `flow` never closes, so its wobble runs *slower* than the loop — a
period of three to six loops — and that low frequency is what buys a visible
swing: big amplitude spent on displacement instead of oscillation. The first
attempt used flow amplitudes at loop frequencies and moved the composition
±18°, which is invisible; at ±120° it reads as the thing changing its mind.

**`_revolveAngle` is a separate method for a reason.** Folding those few lines
into `_fill` instead of calling out to a method made the fill **five times
slower** (0.35ms → 1.95ms at 800×333) — the per-cell loop stops getting
compiled the way it was. Keep them out of that function.

**`revolve` rotates the sampling grid, not the mask.** A scene's gradient axis
is fixed for the life of a composition — only its offset slides — so without
this the colours belong permanently to the same corners. Rotating the sample
coordinates about the frame centre revolves gradient and blobs together, while
the falloff mask stays in screen space so the artwork remains framed as the
colour turns inside it. The rotation is aspect-corrected; skipping that shears
a non-square grid instead of turning it. Costs about 2.7% a frame.

**Scenes are split into `prep(phase)` and `at(x, y)`.** Anything depending on
time but not position belongs in `prep`. It was originally one function and the
per-cell trig cost ~10M wasted `sin`/`cos` calls a frame at small block sizes.

**The ramp and quantise steps are fused into one pass.** `acc` carries only
diffused error, so each cell's colour is folded in on arrival. Splitting them
back out means an extra round trip through a buffer that is tens of megabytes
at small block sizes.

**Loop mode pre-calibrates its levels over the whole cycle.** Auto-levels via a
running average carries history, so t=0 wouldn't match t=`loopSeconds` and the
loop would jump at the seam. Loop mode samples the cycle once up front and
fixes the range, making each frame a pure function of phase.

**Don't "simplify" the LZW code-size bump in the exporter.** It is delayed by
one emission on purpose: a GIF decoder can't complete a dictionary entry until
it reads the *following* code, so its code-size growth lags the encoder's by
exactly one. This came from Bitmaker's own encoder and is verified against
independent decoders.

---

## Verification

`npm test` runs the headless tests — they build the small DOM the engine
actually touches and drive the mount layer and the React wrapper through it, so
the markup path, option precedence, prop updates and teardown are covered on
every change. The rest of the
list below was measured in a browser and is current as of the last change:

- **The frame cap delivers its rate.** Replaying the loop's own gate against a
  jittery display: 30fps requested came out at 24.1fps on 60Hz and 26.7fps on
  120Hz, in gaps alternating 2/3 and 4/5 frames. With the remainder carried and
  half a frame of slack it is 30.0fps on both, at a constant 2 and 4 frames.
  `npm test` asserts the delivered rate is within 1fps of the cap at 20 and 30
  on 60Hz and 120Hz, and fails against the old gate.
- **`upscale: "css"` uploads 16× less.** A 1200×460 hero at 2× DPI: 2400×920 =
  2.2M pixels a frame in `"canvas"` mode against 600×230 = 0.14M in `"css"`.
  Block evenness is bounded by `cell / 2` columns of `gw` — 0 of 600 at
  1200×460, 0 of 683 at 1366×400, 2 of 619 at the deliberately awkward
  1237×433.
- **The worker script is the engine.** The generated worker source is executed
  in `npm test` inside a context with a worker's globals and none of a page's:
  it boots, derives the same 150×75 grid from a posted box that the page would
  have measured, paints the transferred canvas, resizes, and closes on destroy.
- **Per-frame allocation is zero.** Every buffer is built in `_resize`; the
  render path allocates nothing, so there is no GC sawtooth to explain a
  neighbouring animation stuttering.
- **Loop closure is exact.** 0 cells differ between t=0 and t=`loopSeconds`
  across all five scenes, so an exported loop wraps with no seam and no
  duplicated frame.
- **GIF export round-trips byte-exact.** Encoded, decoded through the browser's
  own GIF decoder, compared against the engine's render: 0 pixels mismatched.
- **Export dimensions are exact** at every size preset and block size —
  1920×1080 at 2px is a 960×540 grid, 1080×1920 at 3px is 360×640.
- **The perf refactors are behaviour-preserving.** Mid-cycle frame-difference
  counts are identical before and after both the `prep`/`at` split and the
  fused quantise pass (4614 / 7522 / 6014 / 6373 / 5174), so output is
  bit-for-bit unchanged.
- **`revolve` does not break the loop.** 0 cells differ at the seam for every
  scene at 0, 1, 2 and 3 turns per loop — including with the rate wobble, and
  also at `shape` `radial`/`none`, `morph` 0 and `blobs` 0.
- **Flow mode no longer repeats at the loop period.** A `drift` field sampled
  one full loop apart used to be bit-identical (mean absolute difference 0);
  it now differs by 0.23 per cell, against a field amplitude of order 1.
  Frame-to-frame cell agreement between t and t+`loopSeconds`, averaged over
  three minutes, fell from 0.84 to 0.80 (the floor is the shared paper
  background, which matches either way).
- **The revolve genuinely wanders.** Differentiating `_revolveAngle` over 400
  seeds and eight loops each, turns-per-loop ranges -0.59 to 2.58 and is
  negative about 1.6% of the time — long stalls and brief drifts backwards,
  not a jitter. Against a constant spin it leads or lags by up to ±120°.
  `revolve: 0` returns an angle of exactly 0 at every phase.
- **Composition lengths vary but stay bounded.** Spans run 0.7x–1.5x of
  `sceneSeconds`, floored at `crossfade + 0.5` so a composition is never over
  before it has finished fading in. 48 compositions over 10 minutes.
- **The motion changes are free.** Frame cost at 800×333 is 9.28ms against
  9.09ms before, and `_fill` for `drift` is 2.28ms in both — the extra trig is
  all in `prep`, which runs once a frame, not per cell.
  Benchmarking caveat: compare two builds loaded the *same way*. Timing a
  `<script src>` copy on the demo page against a freshly compiled one reads
  50% slow, because the page's own render loop is competing for the frame.
  That confound produced a phantom regression twice while working on this.
- **Blob count does not break the loop.** 0 cells differ at the seam for
  `drift` and `nebula` at 0, 3, 5 and 12 blobs — the orbit speeds are whole
  turns per cycle.
- **The animated silhouette still closes the loop.** 0 cells differ at the
  seam across all five scenes at `morph` 0, 0.6 and 1.
- **Nothing reaches the frame edge.** Scanning the painted bounding box across
  24 phases of a loop, every scene keeps a margin on all four sides at the
  default `inset`. Before the envelope fix the margin was 0 cells — the
  artwork touched the border, which is what made exports look cropped. The
  floor holds while the outline animates: scanning 36 phases, the worst margin
  across several seeds at full `morph` was 11-15 cells, never zero.

Not verified: real-world performance on low-end hardware, and any browser
other than Chromium on macOS.
