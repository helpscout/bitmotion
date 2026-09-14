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

## Files

| File | Ship it? | What it is |
| --- | --- | --- |
| `bitmotion.js` | **Yes** | The engine. The only file a live page needs. 47KB raw, 15.6KB gzipped, no dependencies. |
| `embed-example.html` | Reference | A complete working hero, configured the way it should ship. Copy the pattern, not the file. |
| `index.html` | **No** | Playground for choosing a look and exporting previews. Internal tool. The Field, Quantiser and Cell-ceiling controls are commented out in the markup rather than deleted — the JS checks for each element before binding, so putting one back is a markup-only edit. |
| `bitmotion-export.js` | **No** | GIF / video / PNG-sequence encoders for the playground. Has no place on a production page — it roughly doubles the payload for something a visitor never uses. |

## Running it

There is no build step and nothing to install. **Open `index.html` in a
browser** — double-clicking it off the filesystem is enough. Everything is
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

### Picking a look

Open `index.html`, shuffle until you like a composition, then hit **Copy
config** — it emits a paste-ready `BitMotion.create({...})` with only the
options that differ from defaults, including the seed. That is the intended
designer-to-developer handoff; nobody should be hand-tuning numbers.

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

### Already handled

- Pauses rendering entirely when the canvas scrolls out of view
  (IntersectionObserver).
- Renders one static frame and stops under `prefers-reduced-motion`.
- Browsers throttle `requestAnimationFrame` to zero in background tabs, so
  there is no hidden-tab cost.

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

### Look

| Option | Default | Notes |
| --- | --- | --- |
| `scene` | `"drift"` | `drift`, `waves`, `bloom`, `ribbon`, `nebula`, or `null` to cycle all. |
| `ramp` | `"dissolve"` | `dissolve`, `bleed`, `warm`, `cool`, `duo`, `ink`, or an array of `[stop, hex]` pairs. |
| `shape` | `"edges"` | Falloff mask: `edges`, `radial`, `none`. |
| `falloff` | `0.45` | 0–1, how far the fade reaches in from the frame. |
| `inset` | `0.04` | Reserved paper margin as a fraction of the **short edge**, converted per axis so the margin is the same number of pixels on all four sides. Also shrinks the field to match, so the composition fits the margin rather than being clipped by it. Raise it for more whitespace; this is what keeps an exported frame off its own edges. |
| `dither` | `"atkinson"` | `atkinson` (Bitmaker's), `bayer` (ordered, temporally calmer), `none` (flat blocks). |
| `exposure` | `0` | −1…1. Negative shows more paper. |
| `contrast` | `1` | >1 widens flat areas, <1 widens the stipple. |
| `background` | `#FAF8F7` | Palette entries matching this render at alpha 0. |
| `transparent` | `true` | `false` paints the background colour instead. |

### Motion

| Option | Default | Notes |
| --- | --- | --- |
| `blobs` | `5` | 0–12. How many orbiting blobs `drift` composes with. Raising it makes the field busier and more likely to separate into islands; `0` leaves a bare gradient. Changing it rebuilds the composition. Costs about 0.2ms per blob at 278k cells. |
| `morph` | `0.6` | 0–1, how much the overall silhouette breathes and squashes across the loop. Drives both the outline (travelling edge warp, per-side breathing) and an antiphase squash-and-stretch of the composition itself. `0` freezes the shape. |
| `revolve` | `1` | Whole turns of the whole composition per loop. `0` holds the orientation fixed. Must be an integer — half a turn would leave the composition upside down at the loop seam, so the value is rounded. |
| `mode` | `"flow"` | `flow` never repeats; `loop` is an exact cycle. |
| `loopSeconds` | `14` | One full cycle in `loop` mode. |
| `sceneSeconds` | `11` | Seconds per composition in `flow` mode. |
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

**The edge falloff fades in colour space, not by value.** Scaling the field
value toward zero walks each edge cell *down the ramp* through yellow and
coral, painting a visible border ring around the frame. Blending the resulting
colour toward paper instead lets each cell dissolve straight into the page.

**The falloff mask edge is warped, and the warp is small on purpose.** A
straight edge-distance mask produces a rounded rectangle, which at high cell
counts reads as a vignette framing the art. The warp amplitude is a *fraction
of the fade band* at under one cycle across the frame; larger amplitudes
scallop the silhouette into what looks like a decorative badge.

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

**`inset` measures from the warp's outer envelope, not its average.** The mask
warp is bipolar, so at its positive peaks it pushes the boundary *outward*. An
inset applied naively is therefore an average margin, not a floor, and the
artwork can still reach the frame edge on some sides — which is exactly how a
GIF ends up looking cropped. Subtracting the envelope bound (`band * 0.56`,
from the amplitudes chosen in `axis()`) makes the margin a guarantee. If you
change those amplitudes, change that constant to match.

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

Current as of the last change:

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
  scene at 0, 1, 2 and 3 turns per loop.
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
