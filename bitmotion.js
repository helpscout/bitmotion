/*!
 * BitMotion — live Bitmaker-style dithered motion graphics for the web.
 *
 * Same visual pipeline as Help Scout Bitmaker (smooth source field ->
 * downscale to a block grid -> Atkinson error-diffusion dither into a small
 * palette -> nearest-neighbour upscale), except the source is generated
 * procedurally every frame instead of coming from an image or video file.
 *
 * No dependencies, no assets, no network. Canvas 2D only.
 * 47KB raw / 15.6KB gzipped.
 *
 *   BitMotion.create({ canvas: "#hero", cellSize: 4, maxCells: 200000 });
 *
 * Or let the markup do it — every [data-bitmotion] element is mounted once
 * the DOM is ready, and init() picks up anything added after that:
 *
 *   <canvas data-bitmotion data-bitmotion-scene="waves"></canvas>
 *   BitMotion.init();
 *
 * Palette entries equal to `background` render fully transparent, so the
 * animation dissolves seamlessly into whatever the page sits on.
 *
 * Two things to know before shipping this on a page:
 *   - Frame cost is linear in cell count (~33ns per cell). Set `maxCells` to
 *     put a hard ceiling on it; without one, a wide viewport multiplies the
 *     work until the render becomes a long task.
 *   - It pauses when scrolled out of view and stays static under
 *     prefers-reduced-motion, both automatically.
 *
 * See README.md for the full option reference.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BitMotion = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TAU = Math.PI * 2;

  // Help Scout palette (matches Bitmaker's ALL_COLORS).
  var HS = {
    paper: "#FAF8F7",
    cream: "#F5F2F0",
    yellow: "#FFDD99",
    coral: "#FF856D",
    blue: "#0064F0",
    purple: "#431379",
    ink: "#131B24"
  };

  // Atkinson pushes only 6/8 of the quantisation error to neighbours — to
  // (+1,0) (+2,0) (-1,+1) (0,+1) (+1,+1) (0,+2), an eighth each. The
  // discarded 2/8 is what gives it the crisp, sparse stipple. The kernel is
  // unrolled by hand in the render loop rather than kept as a table here.

  /* ---------------------------------------------------------------- colour */

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // Colours are compared by string all over `setRamp`, so they have to agree
  // on case and on the leading hash first.
  function normHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    return m ? "#" + m[1].toLowerCase() : "#000000";
  }

  // Builds a 256-entry lookup table from gradient stops, so the per-cell hot
  // loop never interpolates colour — it just indexes.
  function buildRamp(stops) {
    var lut = new Uint8Array(256 * 3);
    var sorted = stops.slice().sort(function (a, b) { return a.at - b.at; });
    for (var i = 0; i < 256; i++) {
      var v = i / 255, a = sorted[0], b = sorted[sorted.length - 1];
      for (var s = 0; s < sorted.length - 1; s++) {
        if (v >= sorted[s].at && v <= sorted[s + 1].at) {
          a = sorted[s]; b = sorted[s + 1];
          break;
        }
      }
      var span = b.at - a.at;
      var t = span <= 0 ? 0 : (v - a.at) / span;
      lut[i * 3] = a.rgb.r + (b.rgb.r - a.rgb.r) * t;
      lut[i * 3 + 1] = a.rgb.g + (b.rgb.g - a.rgb.g) * t;
      lut[i * 3 + 2] = a.rgb.b + (b.rgb.b - a.rgb.b) * t;
    }
    return lut;
  }

  function normalizeStops(spec) {
    return spec.map(function (s) {
      return { at: s[0], rgb: hexToRgb(s[1]) };
    });
  }

  /* ---------------------------------------------------------------- ramps */

  // `dissolve` ramps down to paper at the low end, so the artwork fades into
  // the page. `bleed` fills every cell with saturated colour.
  // Note the deliberate absence of HS.cream (#F5F2F0) next to HS.paper
  // (#FAF8F7): the two are only a few values apart, so cream cells read not
  // as a colour but as a faint dirty rectangle sitting behind the artwork —
  // exactly the seam the transparent background is meant to avoid. Paper
  // straight into yellow gives a clean stipple fade instead.
  var RAMPS = {
    dissolve: [[0.0, HS.paper], [0.22, HS.yellow], [0.48, HS.coral], [0.74, HS.blue], [1.0, HS.purple]],
    bleed: [[0.0, HS.yellow], [0.33, HS.coral], [0.66, HS.blue], [1.0, HS.purple]],
    warm: [[0.0, HS.paper], [0.40, HS.yellow], [1.0, HS.coral]],
    cool: [[0.0, HS.paper], [0.50, HS.blue], [1.0, HS.purple]],
    duo: [[0.0, HS.paper], [0.45, HS.coral], [1.0, HS.purple]],
    ink: [[0.0, HS.paper], [0.55, HS.blue], [1.0, HS.ink]]
  };

  // The backgrounds the artwork is designed to sit on. Every one of them is
  // also a ramp colour, which is the whole reason `resolveStops` exists.
  var BACKGROUNDS = {
    clay: HS.paper,
    blue: HS.blue,
    red: HS.coral,
    lilac: HS.purple,
    yellow: HS.yellow
  };

  // Ramps are authored with HS.paper sitting in the *background slot* — the
  // stop the artwork dissolves into, and the one that renders at alpha 0.
  // Choosing a different background rewrites that slot to the new colour and
  // deletes the new colour from wherever else it sat in the ramp: a cell
  // painted in the background colour is a transparent cell, so leaving one
  // mid-ramp punches holes through the middle of the composition rather than
  // only at its edges.
  //
  // The survivors are then respaced evenly across what is left of the range,
  // so dropping a stop closes the gap instead of leaving a wide flat stretch
  // of one colour where two used to blend. With the default clay background
  // nothing is dropped and the even respacing reproduces the authored stops
  // exactly, so that path is unchanged.
  function resolveStops(spec, background) {
    var bgKey = normHex(background);
    var slotKey = normHex(HS.paper);
    var slotAt = null, keep = [], lo = null, hi = null;

    for (var i = 0; i < spec.length; i++) {
      var at = spec[i][0], key = normHex(spec[i][1]);
      if (key === slotKey && slotAt === null) { slotAt = at; continue; }
      // The span the survivors are spread over is the one the ramp was
      // authored with, not the one the survivors happen to span. Taking it
      // from the survivors would leave a flat stretch of the last colour
      // whenever the dropped stop was the top of the ramp.
      if (lo === null) lo = at;
      hi = at;
      if (key === bgKey) continue;   // collides with the background: drop it
      keep.push(key);
    }

    // Nothing left but the background — a two-stop ramp of one colour is not
    // a ramp, so hand back the flat background and let it render as empty.
    if (!keep.length) return [[slotAt === null ? 0 : slotAt, bgKey]];
    if (hi <= lo) hi = lo + 1e-6;

    var out = [];
    // A ramp with no background slot (`bleed`) stays full-bleed: nothing is
    // added at the low end, so no cell is ever transparent.
    if (slotAt !== null) out.push([slotAt, bgKey]);
    for (var j = 0; j < keep.length; j++) {
      var t = keep.length === 1 ? 1 : j / (keep.length - 1);
      out.push([lo + (hi - lo) * t, keep[j]]);
    }
    return out;
  }

  /* --------------------------------------------------------------- scenes */

  // Every scene is a smooth scalar field over x, y and phase (0..1 across one
  // loop), returning roughly 0..1. Time terms use whole numbers of TAU
  // cycles, so the loop closes exactly. Fields must stay LOW frequency: wide,
  // soft gradients are what give the dither its broad scattered transitions.

  // Each scene is built as two halves: `prep(phase)` computes everything that
  // depends only on time, and `at(x, y)` evaluates the field for one cell.
  // The split exists purely for speed — trig that varies with phase but not
  // position was being recomputed for every cell, which is millions of
  // wasted sin/cos calls a frame once the grid gets dense enough for small
  // blocks. Anything hoistable belongs in prep.
  var SCENES = {};

  // Everything that moves is driven by one clock: `phase`, which advances by
  // 1 every `loopSeconds`. "loop" mode needs the seam to close, so every rate
  // in it has to be a WHOLE number of cycles per loop. The catch is that a set
  // of whole-number rates shares a common period — the loop itself — so the
  // entire animation is exactly periodic at `loopSeconds`. Watch one loop and
  // you have seen all of it, which is what makes a long look read as a short
  // tape on repeat.
  //
  // "flow" mode never has to close. `detuner` returns a function that leaves
  // rates alone in "loop" mode and does two things to them in "flow" mode.
  //
  // First, one TEMPO for the whole composition. Without it every composition
  // moves at the same pace: the shapes change every ten seconds but the speed
  // never does, so the piece has one gear and reads as the same event over and
  // over. Drawing a tempo per composition means some drift and some churn.
  //
  // Second, a per-rate DETUNE on top. Detuned rates share no common period, so
  // the parts of one composition drift in and out of phase with each other
  // instead of locking into formation and repeating. +-17% is enough: a pair
  // of 1-turn rates at 0.9 and 1.1 beat against each other over ten loops.
  function detuner(opts, rnd) {
    if (opts && opts.mode === "loop") return function (turns) { return turns; };
    var tempo = 0.55 + rnd() * 1.05;
    return function (turns) { return turns * tempo * (1 + (rnd() - 0.5) * 0.34); };
  }

  // Slow diagonal wash with orbiting soft blobs. The house style.
  SCENES.drift = function (p, rnd, opts) {
    // Two things decide whether a composition reads as bands or as islands.
    //
    // A linear gradient can only ever produce PARALLEL bands — revolve it and
    // you get tidy rotating stripes, which is what made this predictable.
    // Colour only "breaks apart" when the field has local extrema strong
    // enough to punch through the gradient and close a contour around
    // themselves. That needs blobs that are both heavier than the gradient
    // and tight enough not to just bend it.
    //
    // So each composition picks a balance: gradient-led ones keep the classic
    // Bitmaker banding, blob-led ones weaken the gradient until the blobs
    // carry the frame and the colour separates into islands.
    var det = detuner(opts, rnd);
    var blobLed = rnd() < 0.5;
    var ang = rnd() * TAU;
    var gx = Math.cos(ang), gy = Math.sin(ang);
    var gain = blobLed ? (0.30 + rnd() * 0.45) : (1.0 + rnd() * 0.8);
    var sweep = TAU * det((1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1));
    var sweepAmt = 0.10 + rnd() * 0.16;

    var want = opts && opts.blobs != null ? opts.blobs : 5;
    var n = Math.max(0, Math.min(12, Math.round(want)));

    var cx = new Float64Array(n), cy = new Float64Array(n);
    var rx = new Float64Array(n), ry = new Float64Array(n);
    var kk = new Float64Array(n), ph = new Float64Array(n);
    var ww = new Float64Array(n), inv = new Float64Array(n);
    // Epicycle: a second, smaller circle riding on the first.
    var k2 = new Float64Array(n), ph2 = new Float64Array(n), ep = new Float64Array(n);
    // Slow breathing of the orbit's own size.
    var bk = new Float64Array(n), bp = new Float64Array(n);
    var BREATHE = 0.22;
    for (var i = 0; i < n; i++) {
      cx[i] = 0.08 + rnd() * 0.84;
      cy[i] = 0.08 + rnd() * 0.84;
      rx[i] = 0.08 + rnd() * 0.38;
      ry[i] = 0.08 + rnd() * 0.38;
      // Direction is drawn per blob rather than alternating by index, and
      // speeds run 1-3 turns, so blobs cross each other instead of holding
      // formation. Whole turns keep the loop closed.
      kk[i] = det((rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 3 | 0)));
      ph[i] = rnd();
      // One circle traced at a constant rate is the most predictable path
      // there is: once you have watched a blob round the top you know the
      // rest. A faster epicycle turning the other way makes the same blob
      // loop, stall and swing wide, and breathing the orbit stops it
      // retracing the same ellipse on the next pass. Both are still whole
      // cycles, so "loop" mode still closes.
      k2[i] = det((rnd() < 0.5 ? -1 : 1) * (2 + (rnd() * 4 | 0)));
      ph2[i] = rnd();
      ep[i] = 0.12 + rnd() * 0.30;
      bk[i] = det((rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 2 | 0)));
      bp[i] = rnd();
      // The epicycle and the breathing both ADD excursion, so the orbit is
      // scaled back by their combined peak. Without this the blobs would
      // simply swing further off-frame and spend more of the loop invisible.
      var norm = 1 / ((1 + ep[i]) * (1 + BREATHE));
      rx[i] *= norm;
      ry[i] *= norm;
      // Heavier than before, and signed, so a blob can carve a hole as
      // readily as it can pile up a peak.
      ww[i] = (rnd() < 0.5 ? -1 : 1) * (blobLed ? 0.45 + rnd() * 0.75
                                                : 0.30 + rnd() * 0.45);
      // Tight blobs make islands; wide ones make swells. Weight the draw
      // toward tight so most compositions have some separation in them.
      var soft = rnd() < 0.6 ? (0.13 + rnd() * 0.18) : (0.32 + rnd() * 0.32);
      inv[i] = 1 / soft; // reciprocal, so `at` multiplies
    }

    var bx = new Float64Array(n), by = new Float64Array(n);
    var base = 0.5;

    return {
      prep: function (phase) {
        base = 0.5 + Math.sin(phase * sweep) * sweepAmt;
        for (var i = 0; i < n; i++) {
          var a = TAU * (phase * kk[i] + ph[i]);
          var a2 = TAU * (phase * k2[i] + ph2[i]);
          var br = 1 + Math.sin(TAU * (phase * bk[i] + bp[i])) * BREATHE;
          bx[i] = cx[i] + (Math.cos(a) + Math.cos(a2) * ep[i]) * rx[i] * br;
          by[i] = cy[i] + (Math.sin(a) + Math.sin(a2) * ep[i]) * ry[i] * br;
        }
      },
      at: function (x, y) {
        var v = base + ((x - 0.5) * gx + (y - 0.5) * gy) * gain;
        for (var i = 0; i < n; i++) {
          var dx = (x - bx[i]) * inv[i];
          var dy = (y - by[i]) * inv[i];
          v += ww[i] / (1 + dx * dx + dy * dy);
        }
        return v;
      }
    };
  };

  // Interference of a handful of plane waves — rippling moire bands.
  SCENES.waves = function (p, rnd, opts) {
    var det = detuner(opts, rnd);
    var n = 3 + (rnd() * 3 | 0);
    var kx = new Float64Array(n), ky = new Float64Array(n);
    var w = new Float64Array(n), ph0 = new Float64Array(n);
    var amp = 0.6 / n;
    for (var i = 0; i < n; i++) {
      var ang = rnd() * TAU;
      var freq = (1.2 + rnd() * 3.4) * TAU;
      kx[i] = Math.cos(ang) * freq;
      ky[i] = Math.sin(ang) * freq;
      w[i] = TAU * det((1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1));
      ph0[i] = rnd() * TAU;
    }
    var off = new Float64Array(n);

    return {
      prep: function (phase) {
        for (var i = 0; i < n; i++) off[i] = phase * w[i] + ph0[i];
      },
      at: function (x, y) {
        var v = 0.5;
        for (var i = 0; i < n; i++) v += Math.sin(x * kx[i] + y * ky[i] + off[i]) * amp;
        return v;
      }
    };
  };

  // Concentric pulse radiating from an off-centre origin.
  SCENES.bloom = function (p, rnd, opts) {
    var det = detuner(opts, rnd);
    var cx = 0.3 + rnd() * 0.4, cy = 0.3 + rnd() * 0.4;
    var rings = (0.9 + rnd() * 1.3) * TAU;
    var speed = TAU * det((1 + (rnd() * 2 | 0)) * (rnd() < 0.4 ? -1 : 1));
    var squash = 0.7 + rnd() * 0.6;
    var wobK = 2 + (rnd() * 3 | 0);
    var spinK = det(1);
    // A pulse radiating from a pinned origin is a bullseye: the rings move
    // but the centre never does, and the eye locks onto it. Wandering the
    // origin on two mismatched cycles keeps the source itself travelling,
    // so the same rings sweep the frame from a different place each pass.
    var wanK = det((rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 2 | 0)));
    var wanK2 = det((rnd() < 0.5 ? -1 : 1) * (2 + (rnd() * 3 | 0)));
    var wanP = rnd(), wanP2 = rnd();
    var wanR = 0.05 + rnd() * 0.11;
    var spin = 0, drift = 0, ox = cx, oy = cy;

    return {
      prep: function (phase) {
        spin = phase * TAU * spinK;
        drift = phase * speed;
        ox = cx + (Math.cos(TAU * (phase * wanK + wanP)) * 0.7 +
                   Math.cos(TAU * (phase * wanK2 + wanP2)) * 0.3) * wanR;
        oy = cy + (Math.sin(TAU * (phase * wanK + wanP)) * 0.7 +
                   Math.sin(TAU * (phase * wanK2 + wanP2)) * 0.3) * wanR;
      },
      at: function (x, y) {
        var dx = x - ox, dy = (y - oy) * squash;
        var d = Math.sqrt(dx * dx + dy * dy);
        var wob = Math.sin(Math.atan2(dy, dx) * wobK + spin) * 0.06;
        return 0.5 + Math.sin((d + wob) * rings - drift) * 0.42 * (1 - d * 0.5);
      }
    };
  };

  // Wide diagonal bands warped by a slow sine — sweeping ribbons of colour.
  SCENES.ribbon = function (p, rnd, opts) {
    var det = detuner(opts, rnd);
    var ang = rnd() * TAU;
    var gx = Math.cos(ang), gy = Math.sin(ang);
    var bands = (0.5 + rnd() * 0.9) * TAU;
    var warpK = (1 + rnd() * 2.5) * TAU;
    var warpAmt = 0.12 + rnd() * 0.22;
    var drift = TAU * det(1 + (rnd() * 2 | 0));
    var warpRate = det(1);
    // Bands of a fixed width sliding at a fixed rate are a conveyor belt.
    // Breathing the spacing makes them crowd and open out as they travel,
    // which reads as the ribbon turning towards and away from you.
    var spreadK = det((rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 2 | 0)));
    var spreadP = rnd(), spreadAmt = 0.12 + rnd() * 0.16;
    var wp = 0, dp = 0, bandsNow = bands;

    return {
      prep: function (phase) {
        wp = phase * TAU * warpRate;
        dp = phase * drift;
        bandsNow = bands * (1 + Math.sin(TAU * (phase * spreadK + spreadP)) * spreadAmt);
      },
      at: function (x, y) {
        var u = x * gx + y * gy;
        var warp = Math.sin((x * 0.6 - y) * warpK + wp) * warpAmt;
        return 0.5 + Math.sin((u + warp) * bandsNow - dp) * 0.45;
      }
    };
  };

  // Layered blobs plus a counter-rotating swirl — the busiest of the four.
  SCENES.nebula = function (p, rnd, opts) {
    var inner = SCENES.drift(p, rnd, opts);
    var det = detuner(opts, rnd);
    var swirlK = (1 + rnd() * 2) * TAU;
    var spinRate = TAU * det((1 + (rnd() * 2 | 0)) * (rnd() < 0.35 ? -1 : 1));
    var arms = 2 + (rnd() * 2 | 0);
    // The swirl's own winding loosens and tightens, so the arms do not just
    // sweep past at a constant rate like a radar hand.
    var windK = det((rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 2 | 0)));
    var windP = rnd();
    var spin = 0, wind = swirlK;

    return {
      prep: function (phase) {
        inner.prep(phase);
        spin = phase * spinRate;
        wind = swirlK * (1 + Math.sin(TAU * (phase * windK + windP)) * 0.3);
      },
      at: function (x, y) {
        var dx = x - 0.5, dy = y - 0.5;
        var r = Math.sqrt(dx * dx + dy * dy);
        var th = Math.atan2(dy, dx);
        return inner.at(x, y) + Math.sin(th * arms + r * wind - spin) * 0.22 * (1 - r);
      }
    };
  };

  var SCENE_NAMES = Object.keys(SCENES);

  /* ----------------------------------------------------------------- misc */

  // Small deterministic PRNG (mulberry32) so a given seed always replays the
  // exact same composition.
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Where in the frame the composition is anchored: nine named points on a
  // 3x3 grid, in normalised frame coordinates. Anchoring off-centre moves the
  // field AND its falloff together, so the composition keeps its shape and
  // simply hangs off the side it is pinned to — a corner anchor shows a
  // quarter of it. Nothing is laid out, only sampled, so the part that leaves
  // the frame costs nothing and can never make the page scroll.
  var ORIGINS = {
    "top-left":    [0,   0  ], "top":    [0.5, 0  ], "top-right":    [1, 0  ],
    "left":        [0,   0.5], "center": [0.5, 0.5], "right":        [1, 0.5],
    "bottom-left": [0,   1  ], "bottom": [0.5, 1  ], "bottom-right": [1, 1  ]
  };

  // Accepts a name or an {x, y} pair, so anything between the nine points is
  // still expressible from a config.
  function originXY(v) {
    if (v && typeof v === "object") {
      return { x: clamp01(v.x == null ? 0.5 : v.x), y: clamp01(v.y == null ? 0.5 : v.y) };
    }
    var p = ORIGINS[v] || ORIGINS.center;
    return { x: p[0], y: p[1] };
  }

  /* --------------------------------------------------------------- engine */

  var DEFAULTS = {
    canvas: null,
    size: null,            // {w, h} in CSS px to override measuring the element
    grid: null,            // {w, h} exact cell counts, bypassing `resolution`
    maxCell: 0,            // cap on cell size in device px (0 = uncapped)
    cellSize: 3,           // exact block size in OUTPUT pixels; the primary
                           // sizing control. Set it to 0 to size by
                           // `resolution` instead.
    maxDpr: 2,             // device-pixel-ratio ceiling; 1 quarters the cell count
    maxCells: 0,           // hard ceiling on grid cells; coarsens blocks to fit
    resolution: 96,        // cells along the long edge — only consulted when
                           // `cellSize` is 0. Keeps a composition identical
                           // across breakpoints, where cellSize keeps the
                           // block size identical instead.
    ramp: "dissolve",      // key of RAMPS, or an array of [stop, hex] pairs
    background: HS.paper,  // palette entries matching this render transparent
    transparent: true,     // false = paint the background colour instead
    mode: "flow",          // "loop" for a perfect cycle, "flow" for endless variation
    loopSeconds: 14,       // one full cycle in "loop" mode
    sceneSeconds: 11,      // seconds per composition in "flow" mode
    crossfade: 3.5,        // seconds of blend between compositions
    blobs: 5,              // how many orbiting blobs drift composes with.
                           // More means busier and more likely to separate
                           // into islands; 0 leaves a bare gradient.
    revolve: 1,            // whole turns of the whole composition per loop
    scene: "drift",        // pin a scene name, or null to cycle all of them
    scenes: null,          // restrict the rotation to these scene names
    fps: 20,               // render cap; the look is fine well below 60
    dither: "atkinson",    // "atkinson" | "bayer" | "none"
    levels: true,          // auto-normalise each field to the full ramp range
    exposure: 0,           // -1..1 after normalising; negative shows more paper
    contrast: 1,           // >1 widens the flat areas, <1 widens the stipple
    shape: "edges",        // falloff mask: "edges" | "radial" | "none"
    origin: "center",      // anchor point for the composition and its mask:
                           // one of the nine ORIGINS names, or {x, y} in
                           // 0..1. Off-centre anchors deliberately hang part
                           // of the composition outside the frame.
    falloff: 0.7,          // 0..1 — how far the edge blurs OUTWARD. The
                           // silhouette has a fixed core; the fade grows out
                           // from it into the paper beyond, reaching the
                           // frame (less `inset`) at 1. Softening therefore
                           // widens the shape instead of shrinking it, and 0
                           // is the same shape with a hard edge.
    morph: 0.6,            // 0..1 — how much the outline breathes and squishes
                           // over the loop. 0 freezes the silhouette.
    inset: 0.04,           // guaranteed paper margin, as a fraction of the
                           // short edge. Also shrinks the field to match, so
                           // the composition fits the margin rather than
                           // being clipped by it. This is what keeps an
                           // exported frame from touching its own edges.
    seed: null,            // integer for a reproducible sequence
    autoplay: true,
    respectReducedMotion: true
  };

  var BAYER8 = (function () {
    var m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
             [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
             [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
             [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
    var out = new Float32Array(64);
    for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) out[y * 8 + x] = m[y][x] / 64 - 0.5;
    return out;
  })();

  function BitMotionInstance(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (var j in opts) if (opts[j] !== undefined) o[j] = opts[j];
    this.o = o;

    this.canvas = typeof o.canvas === "string" ? document.querySelector(o.canvas) : o.canvas;
    if (!this.canvas) throw new Error("BitMotion: `canvas` option is required");
    this.ctx = this.canvas.getContext("2d", { alpha: true });
    this.ctx.imageSmoothingEnabled = false;
    // If the backing store and the CSS box ever disagree — a maxDpr below the
    // display's, an odd container width — the compositor upscales with
    // bilinear filtering and softens every block edge. This keeps them hard.
    this.canvas.style.imageRendering = "pixelated";

    // Grid canvas: one device pixel per cell. Scaled up on draw.
    this.grid = document.createElement("canvas");
    this.gctx = this.grid.getContext("2d", { alpha: true });

    this.rndSeed = o.seed == null ? (Math.random() * 0x7fffffff) | 0 : o.seed | 0;
    this.sceneIndex = 0;
    this.startTime = 0;
    this.elapsed = 0;
    this.lastDraw = -1e9;
    this.running = false;
    this.visible = true;
    this._raf = null;

    this.setRamp(o.ramp);
    this._pickScene(0);
    this._resize();

    var self = this;
    this._onResize = function () { self._resize(); if (!self.running) self._render(self.elapsed); };
    window.addEventListener("resize", this._onResize);

    if (typeof IntersectionObserver === "function") {
      this._io = new IntersectionObserver(function (entries) {
        self.visible = entries[0].isIntersecting;
        if (self.visible && self.running) self._loop();
      }, { threshold: 0 });
      this._io.observe(this.canvas);
    }
    this._onVis = function () { if (!document.hidden && self.running) self._loop(); };
    document.addEventListener("visibilitychange", this._onVis);

    var reduced = o.respectReducedMotion &&
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) this._render(o.loopSeconds * 0.25);
    else if (o.autoplay) this.play();
    else this._render(0);
  }

  BitMotionInstance.prototype.setRamp = function (ramp) {
    var authored = typeof ramp === "string" ? RAMPS[ramp] : ramp;
    if (!authored) authored = RAMPS.dissolve;
    this.o.ramp = ramp;

    // Resolved against the current background: the background takes over the
    // ramp's low stop and is removed from everywhere else. See resolveStops.
    var spec = resolveStops(authored, this.o.background);
    this.stops = spec;
    this.rampLut = buildRamp(normalizeStops(spec));

    // The dither palette is the set of distinct colours in the ramp.
    var bg = hexToRgb(this.o.background);
    var seen = {}, pal = [];
    this.bgIndex = -1;
    spec.forEach(function (s) {
      var rgb = hexToRgb(s[1]);
      var key = rgb.r + "," + rgb.g + "," + rgb.b;
      if (seen[key]) return;
      seen[key] = true;
      if (rgb.r === bg.r && rgb.g === bg.g && rgb.b === bg.b) this.bgIndex = pal.length;
      pal.push(rgb);
    }, this);
    this.palette = pal;
    this.palFlat = new Int32Array(pal.length * 3);
    for (var i = 0; i < pal.length; i++) {
      this.palFlat[i * 3] = pal[i].r;
      this.palFlat[i * 3 + 1] = pal[i].g;
      this.palFlat[i * 3 + 2] = pal[i].b;
    }
    return this;
  };

  BitMotionInstance.prototype.setOption = function (key, value) {
    // The background is baked into the resolved ramp and the palette, so
    // changing it rebuilds both, exactly as changing the ramp does.
    if (key === "ramp" || key === "background") {
      if (key === "background") this.o.background = value;
      this.setRamp(key === "ramp" ? value : this.o.ramp);
      if (!this.running) this._render(this.elapsed);
      return this;
    }
    this.o[key] = value;
    if (key === "resolution" || key === "cellSize" || key === "maxDpr" ||
        key === "maxCells") this._resize();
    if (key === "morph") this._maskParams();
    if (key === "shape") this._resize(); // radial needs its per-cell tables
    // The anchor is baked into the radial tables, and it moves the field the
    // auto-levels were measured against, so both have to be redone.
    if (key === "origin") this._buildRadial();
    if (key === "shape" || key === "falloff" || key === "inset" || key === "origin") {
      this._maskParams();
      this._lo = null;
      this._calibrate();
    }
    if (key === "scene" || key === "scenes" || key === "blobs") this._pickScene(this.elapsed);
    if (key === "mode" || key === "levels" || key === "revolve") {
      this._lo = null;
      // `mode` is not a switch the renderer reads each frame — it is baked
      // into every RATE in the piece. `detuner` leaves them at whole cycles
      // per loop in "loop" and detunes them off each other in "flow", and
      // whole cycles are the entire reason the seam closes. Both the
      // composition and the mask capture it when they are built, so
      // switching mode without rebuilding them leaves every part of the
      // piece ending the cycle somewhere other than where it began: the
      // loop then cuts at the wrap instead of closing. Rebuild both.
      // `_pickScene` calibrates on its way out, so nothing else to do.
      if (key === "mode") {
        this._maskParams();
        this._pickScene(this.elapsed);
      } else {
        this._calibrate();
      }
    }
    if (!this.running) this._render(this.elapsed);
    return this;
  };

  BitMotionInstance.prototype.reseed = function (seed) {
    this.rndSeed = seed == null ? (Math.random() * 0x7fffffff) | 0 : seed | 0;
    this.sceneIndex = 0;
    this._maskParams(); // the silhouette's shape and motion are seeded too
    this._pickScene(this.elapsed);
    if (!this.running) this._render(this.elapsed);
    return this;
  };

  BitMotionInstance.prototype._sceneList = function () {
    var list = this.o.scenes && this.o.scenes.length ? this.o.scenes : SCENE_NAMES;
    return list.filter(function (n) { return SCENES[n]; });
  };

  // Builds the field for composition `n`. In "flow" mode each composition gets
  // a fresh seed and a different scene; in "loop" mode there is only ever one.
  BitMotionInstance.prototype._buildField = function (n) {
    var list = this._sceneList();
    var name = this.o.scene && SCENES[this.o.scene]
      ? this.o.scene
      : list[((n % list.length) + list.length) % list.length];
    var rnd = makeRandom(this.rndSeed + n * 0x9e3779b1);
    return { name: name, scene: SCENES[name](n, rnd, this.o) };
  };

  // How long composition `n` holds the screen, in seconds. Equal-length
  // compositions turn the cut itself into a metronome: after two of them you
  // know when the next one lands, which makes the whole piece feel
  // scheduled. Lengths are drawn per composition — deterministically from
  // the seed, so a given seed still replays identically — and run from 0.7x
  // to 1.5x of `sceneSeconds`, floored at the crossfade so a short
  // composition is never over before it has finished arriving.
  BitMotionInstance.prototype._spanFor = function (n, base) {
    if (this.o.mode === "loop") return base;
    var r = makeRandom((this.rndSeed ^ 0x2545f491) + n * 0x9e3779b1)();
    return Math.max(this.o.crossfade + 0.5, base * (0.7 + r * 0.8));
  };

  // Walks composition boundaries forward to find the one containing `time`.
  // Variable spans mean the boundary is no longer a division, so the walk is
  // incremental: it advances by at most one composition per frame in normal
  // playback and only rebuilds from zero if the clock jumps backwards.
  BitMotionInstance.prototype._segment = function (time) {
    var base = Math.max(this.o.crossfade + 0.5, this.o.sceneSeconds);
    var seg = this._seg;
    if (!seg || seg.base !== base || seg.start > time) {
      seg = this._seg = { base: base, n: 0, start: 0, span: this._spanFor(0, base) };
    }
    while (time >= seg.start + seg.span) {
      seg.start += seg.span;
      seg.n++;
      seg.span = this._spanFor(seg.n, base);
    }
    return seg;
  };

  BitMotionInstance.prototype._pickScene = function () {
    this._fieldCache = {};
    this._seg = null;
    this.current = this._buildField(0);
    this._calibrate();
    return this;
  };

  // In "loop" mode the levels cannot be adapted frame to frame: an
  // exponential average carries history, so the tone at t=0 would not match
  // the tone at t=loopSeconds and the loop would visibly jump at the seam.
  // Instead, sample the whole cycle once up front and fix the range, which
  // makes the render an exact function of phase — and therefore periodic.
  // The block of cells where the field is inside its own 0..1 domain: the
  // window `inset` leaves, moved to the anchor. Auto-levels measure only
  // here. Outside it the scene is being extrapolated — for `drift` that is
  // its gradient still climbing with nothing left to bend it — and those
  // runaway values would set the range for the whole frame, squeezing
  // everything actually on show into a fraction of the ramp. A strong
  // margin flattened the artwork for exactly this reason. Nothing is lost
  // by skipping that region: it is under the mask's paper.
  //
  // `revolve` turns the domain, so the corners of this block can sample a
  // little past it. A little is fine — it is a range, not a boundary.
  BitMotionInstance.prototype._levelRect = function () {
    var gw = this.gw, gh = this.gh;
    var inset = Math.max(0, Math.min(0.45, this.o.inset || 0));
    // Full bleed has no mask, so there is no paper hiding the extrapolated
    // region — it is all on show and all of it has to be in range.
    if (this.o.shape === "none" || inset <= 0) {
      return { x0: 0, y0: 0, x1: gw - 1, y1: gh - 1 };
    }
    var half = (1 - inset) * 0.5;
    var org = this._origin();
    var x0 = Math.floor((org.x - half) * (gw - 1));
    var x1 = Math.ceil((org.x + half) * (gw - 1));
    var y0 = Math.floor((org.y - half) * (gh - 1));
    var y1 = Math.ceil((org.y + half) * (gh - 1));
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > gw - 1) x1 = gw - 1;
    if (y1 > gh - 1) y1 = gh - 1;
    if (x1 < x0) x1 = x0;
    if (y1 < y0) y1 = y0;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  };

  BitMotionInstance.prototype._calibrate = function () {
    this._fixedLo = null;
    if (this.o.mode !== "loop" || !this.o.levels || !this.current) return this;
    if (!this.gw || !this.gh || !this.work) return this;

    // Sampled through _fill rather than by calling the scene directly, so the
    // calibration sees exactly what the renderer will — including `revolve`.
    var work = this.work;
    var lo = Infinity, hi = -Infinity;
    var STEPS = 24;
    var r = this._levelRect(), gw = this.gw;

    for (var s = 0; s < STEPS; s++) {
      this._fill(work, this.current.scene, s / STEPS, 1, null, 0);
      for (var y = r.y0; y <= r.y1; y++) {
        var base = y * gw;
        for (var x = r.x0; x <= r.x1; x++) {
          var v = work[base + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (hi - lo < 1e-4) hi = lo + 1e-4;
    this._fixedLo = lo;
    this._fixedHi = hi;
    return this;
  };

  BitMotionInstance.prototype._field = function (n) {
    var key = String(n);
    if (!this._fieldCache) this._fieldCache = {};
    if (!this._fieldCache[key]) this._fieldCache[key] = this._buildField(n);
    // Keep the cache tiny — only the current pair is ever needed.
    var keys = Object.keys(this._fieldCache);
    if (keys.length > 4) delete this._fieldCache[keys[0]];
    return this._fieldCache[key];
  };

  BitMotionInstance.prototype._resize = function () {
    var cssW, cssH, dpr;

    if (this.o.size) {
      // Explicit output size: used for export, where the frame must be an
      // exact pixel size rather than whatever the element happens to measure.
      cssW = Math.max(1, this.o.size.w);
      cssH = Math.max(1, this.o.size.h);
      dpr = 1;
    } else {
      dpr = Math.min(window.devicePixelRatio || 1, Math.max(1, this.o.maxDpr));
      var rect = this.canvas.getBoundingClientRect();
      cssW = Math.max(1, rect.width || this.canvas.clientWidth || 640);
      cssH = Math.max(1, rect.height || this.canvas.clientHeight || 360);
    }

    var gw, gh, cell;

    if (this.o.grid) {
      // Exact cell counts. Deriving the short edge from the aspect ratio
      // rounds, which can overshoot the requested pixel height by a cell —
      // fatal when an export has to land on exactly 1920×1080.
      gw = Math.max(1, Math.round(this.o.grid.w));
      gh = Math.max(1, Math.round(this.o.grid.h));
      cell = Math.max(1, Math.ceil(cssW * dpr / gw));
    } else if (this.o.cellSize > 0) {
      // Block size drives the grid — the inverse of `resolution`, and the
      // direct control when what you care about is how chunky a block is.
      //
      // This is in OUTPUT pixels, not CSS pixels, so `cellSize: 2` really is
      // a 2×2 block in the rendered bitmap. On a 2x display that is half a
      // CSS pixel wide, which is the finest the format can express — and it
      // costs four times the cells of the same number in CSS px, so `maxDpr`
      // is the lever if the frame budget matters more than the crispness.
      cell = Math.max(1, Math.round(this.o.cellSize));
      gw = Math.max(1, Math.round(cssW * dpr / cell));
      gh = Math.max(1, Math.round(cssH * dpr / cell));
    } else {
      var res = Math.max(8, Math.round(this.o.resolution));
      if (cssW >= cssH) { gw = res; gh = Math.max(1, Math.round(res * cssH / cssW)); }
      else { gh = res; gw = Math.max(1, Math.round(res * cssW / cssH)); }
      // Integer cell size keeps every block exactly the same width, which is
      // what makes the grid read as crisp rather than slightly jittery.
      cell = Math.max(1, Math.ceil(cssW * dpr / gw));
    }
    if (this.o.maxCell > 0) cell = Math.min(cell, this.o.maxCell);

    // Frame cost tracks cell count almost linearly, so a cell ceiling is a
    // direct cost ceiling — the one guardrail worth having in production,
    // where the canvas can be any size on hardware of any speed. Growing the
    // block size is the graceful way to stay under it: the composition is
    // unchanged, just coarser. Without this a wide viewport on a slow device
    // silently multiplies the work.
    if (this.o.maxCells > 0 && !this.o.grid) {
      var budget = this.o.maxCells;
      while (gw * gh > budget && cell < 512) {
        cell++;
        gw = Math.max(1, Math.round(cssW * dpr / cell));
        gh = Math.max(1, Math.round(cssH * dpr / cell));
      }
    }
    this.gw = gw; this.gh = gh; this.cell = cell;
    this.grid.width = gw; this.grid.height = gh;
    this.canvas.width = gw * cell;
    this.canvas.height = gh * cell;
    this.ctx.imageSmoothingEnabled = false;

    this.imgData = this.gctx.createImageData(gw, gh);
    this.work = new Float32Array(gw * gh);
    this.acc = new Float32Array(gw * gh * 3);

    // Mask scratch. These are sized by width or height, not by cell count,
    // which is what makes an animated silhouette affordable — the old baked
    // mask was a whole gw*gh float array and is gone.
    var invW = 1 / (gw - 1 || 1), invH = 1 / (gh - 1 || 1);
    this._nxs = new Float32Array(gw);
    this._nys = new Float32Array(gh);
    for (var xi = 0; xi < gw; xi++) this._nxs[xi] = xi * invW;
    for (var yi = 0; yi < gh; yi++) this._nys[yi] = yi * invH;
    this._colDist = new Float32Array(gw);
    this._rowDist = new Float32Array(gh);
    // The fade's two ends, per row for the x-fade and per column for the
    // y-fade, already divided through by their own band — see _prepMask.
    this._xInv = new Float32Array(gh);
    this._xOut = new Float32Array(gh);
    this._yInv = new Float32Array(gw);
    this._yOut = new Float32Array(gw);
    this._rOut = new Float32Array(256);
    this._rInv = new Float32Array(256);

    this._buildRadial();
    // Palette index per cell, kept alongside the RGBA so exporters can encode
    // indexed formats (GIF) straight from the grid without re-quantising.
    this.indices = new Uint8Array(gw * gh);
    this._lo = null; // re-measure levels against the new grid
    this._maskParams();
    this._calibrate();
    return this;
  };

  // The resolved anchor, memoised on the option itself: `_fill` and
  // `_prepMask` both want it every frame, and neither should be handing the
  // collector a fresh object 40 times a second. Setting `o.origin` to a new
  // value — which is what `setOption` does — invalidates it; mutating an
  // {x, y} object in place does not, so don't.
  BitMotionInstance.prototype._origin = function () {
    if (this._orgKey !== this.o.origin || !this._org) {
      this._orgKey = this.o.origin;
      this._org = originXY(this.o.origin);
    }
    return this._org;
  };

  // Per-cell radius and angle for the radial mask — the only two tables that
  // depend on WHERE the composition is anchored, so this is also what an
  // `origin` change rebuilds. Radial pays for them; `edges` does not, so they
  // are allocated only while that shape is in use.
  //
  // A TRUE CIRCLE, and a big one. Two decisions:
  //
  // Distance is measured in CELLS, which are square, so it is a distance in
  // pixels. Measuring per axis in normalised coordinates — where 1 is the
  // half-width horizontally and the half-height vertically — is what made
  // the shape an oval stretched to the frame. It also put the fade's whole
  // band outside the canvas along the long axis back when the radius was
  // normalised by the half-diagonal, which is the hard line this started
  // with; that part is fixed either way, but pixels are what make it round.
  //
  // The unit is the distance to the FARTHEST frame edge, so `falloff` 1 is a
  // circle that reaches the far side. On a frame that is not square a circle
  // that big cannot also stay inside the near sides, and it is not supposed
  // to: it runs off them, which is how a circle fills a rectangle and what
  // the artwork wants on a banner. Wind `falloff` down and the circle shrinks
  // inside the frame; there is a point on the way — where the radius equals
  // the short half-extent — below which nothing crosses an edge at all.
  // `inset` still holds its margin on the long axis, where the fade ends.
  BitMotionInstance.prototype._buildRadial = function () {
    var gw = this.gw, gh = this.gh;
    if (this.o.shape !== "radial" || !gw || !gh) {
      this._rad = null;
      this._thetaIdx = null;
      return this;
    }
    var org = this._origin();
    var n = gw * gh;
    var rad = this._rad && this._rad.length === n ? this._rad : new Float32Array(n);
    var th = this._thetaIdx && this._thetaIdx.length === n ? this._thetaIdx : new Uint8Array(n);

    // The anchor in cells, and the reach to each side from it. An anchored
    // circle measures its own four distances, so pinning it to an edge grows
    // it to span the frame from there rather than shrinking it to the corner
    // it sits in.
    var cx = org.x * (gw - 1), cy = org.y * (gh - 1);
    var far = Math.max(cx, gw - 1 - cx, cy, gh - 1 - cy);
    if (far < 1e-6) far = 1e-6;
    var invFar = 1 / far;

    for (var ry = 0; ry < gh; ry++) {
      var ay = ry - cy;
      var base = ry * gw;
      for (var rx = 0; rx < gw; rx++) {
        var ax = rx - cx;
        var p2 = base + rx;
        rad[p2] = Math.sqrt(ax * ax + ay * ay) * invFar;
        th[p2] = ((Math.atan2(ay, ax) / TAU + 0.5) * 256) & 255;
      }
    }
    this._rad = rad;
    this._thetaIdx = th;
    return this;
  };

  // The falloff mask is what makes the artwork sit ON the page rather than in
  // a box: it pulls the field toward the low (paper) end of the ramp near the
  // frame, so the dither thins out and dissolves into the background instead
  // of stopping at a hard canvas edge. Static per size, so it is built once.
  // Seeded shape parameters. Separated from evaluation because these are
  // fixed for a composition while the mask itself is now re-evaluated every
  // frame — the silhouette has to breathe, or the artwork reads as a lively
  // drift trapped inside a frozen window.
  BitMotionInstance.prototype._maskParams = function () {
    var gw = this.gw, gh = this.gh;
    if (!gw || !gh) return this;

    var falloff = Math.max(0.001, Math.min(1, this.o.falloff));

    // WHICH WAY THE FADE GROWS. The silhouette has a fixed core — CORE_R of
    // the way from the anchor to the frame — and the fade grows OUTWARD from
    // it, into the paper between the core and the frame, reaching the frame
    // at `falloff` 1. That is the whole point: blurring the edge makes the
    // shape wider and taller, never smaller.
    //
    // Anchoring the fade at the frame instead and letting it eat inward —
    // which is what this did — can only ever shrink the shape, because the
    // one end that is pinned is the outer one. Softening then ate the core
    // from both sides at once and the composition drew itself in. The core
    // is the pinned end now, and `inset` still owns where the outer limit
    // is, so a margin asked for is a margin kept.
    var band = falloff * 0.5;
    // Wobble amplitude. It follows the band while the band is small — a
    // crisp edge should undulate in proportion to itself — and saturates
    // gently after that instead of tracking a long fade all the way up.
    // A hyperbolic soft-min rather than a hard `Math.min`, so there is no
    // kink in the middle of the slider where the behaviour changes.
    var sband = 0.12 * band / Math.sqrt(0.0144 + band * band);
    var minSide = Math.min(gw, gh);
    var sx = minSide / gw, sy = minSide / gh;
    var rnd = makeRandom(this.rndSeed ^ 0x5bf03635);
    var det = detuner(this.o, rnd);

    // Amplitudes are a fraction of the boundary budget, and the spatial
    // frequency stays under one cycle across the frame, so it undulates instead
    // of scalloping into decoration. Amplitudes scale per axis by that axis'
    // share of the short edge, keeping the wobble the same size in PIXELS on
    // both axes. `m`/`m2` are the TIME frequencies: whole numbers of turns
    // per loop, which is what lets the boundary travel and still close.
    function axis(axisScale) {
      return {
        a: sband * (0.18 + rnd() * 0.22) * axisScale,
        k: (0.55 + rnd() * 0.75) * TAU,
        p: rnd() * TAU,
        m: det((1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1)),
        a2: sband * (0.06 + rnd() * 0.10) * axisScale,
        k2: (1.3 + rnd() * 1.2) * TAU,
        p2: rnd() * TAU,
        m2: det((1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1))
      };
    }

    // Snaps an axis' two spatial frequencies to whole cycles, for the one
    // warp whose argument runs round a circle rather than across the frame.
    // Keeping the two terms at different harmonics preserves the detail the
    // second one is there for.
    function closed(a) {
      a.k = TAU * Math.max(1, Math.round(a.k / TAU));
      a.k2 = TAU * Math.max(2, Math.round(a.k2 / TAU));
      return a;
    }

    // The edge mask's distance runs 0 at the frame to 0.5 at the middle,
    // while the radial's runs 0 at the anchor to 1 at the frame — the same
    // journey measured at half the scale, which is why the radial core is
    // twice the number. Both put the core half way, so `falloff` means the
    // same fraction of the same journey in either shape.
    this._mp = {
      coreD: 0.25,                          // edges: core distance in from the frame
      // Radial: core radius, as a fraction of the reach to the farthest
      // edge. Kept well under the short half-extent of any sane frame, so
      // that winding `falloff` down really does pull the circle inside the
      // frame rather than bottoming out on a core that never fitted.
      coreR: 0.35,
      falloff: falloff,
      sband: sband,
      sx: sx, sy: sy,
      x: axis(sx),
      y: axis(sy),
      // The radial warp's argument is an ANGLE, and an angle wraps. `axis`
      // draws fractional frequencies, which is right for the two edge warps
      // — they run across the frame and never meet themselves — but around a
      // circle a fractional frequency arrives back at theta = -pi holding a
      // different value than it left at +pi. That step lands on the left of
      // the frame, where atan2 wraps, and it is the notch cut into the
      // silhouette there: not a rendering artefact but a boundary that
      // genuinely disagrees with itself. Whole cycles round the circle make
      // the two ends meet.
      r: closed(axis(1)),
      // Per-side breathing. Opposite sides run in antiphase, so the window
      // squeezes on one side as it releases on the other — it slides and
      // squashes rather than just pulsing symmetrically.
      kx: det(1 + (rnd() * 2 | 0)), px: rnd() * TAU,
      ky: det(1 + (rnd() * 2 | 0)), py: rnd() * TAU,
      kr: det(1 + (rnd() * 2 | 0)), pr: rnd() * TAU
    };

    // Squash-and-stretch of the composition itself. Breathing the mask alone
    // barely shows, because the mask is not what bounds the silhouette most
    // of the time — the field's own falloff is. Scaling the field
    // anisotropically is what actually changes the overall shape: it widens
    // as it flattens and back, in antiphase, so the area stays roughly
    // constant instead of pulsing bigger and smaller. Whole cycles per loop,
    // so it closes.
    this._sq = {
      k: det((1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1)),
      p: rnd() * TAU,
      k2: det((1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1)),
      p2: rnd() * TAU
    };

    // How `revolve` is paced — see `_revolveAngle`, which applies these.
    //
    // The two modes want opposite things here, so they get different numbers.
    //
    // "loop" has to close, which forces whole cycles per loop. A wobble at one
    // cycle per loop can only ever displace the composition a little before it
    // has to come back, so the amplitude stays small and the turn just
    // breathes: TAU * (a1 * w1 + a2 * w2) = 0.81 of a turn per loop of rate
    // deviation, which never quite cancels the 1-turn base. It slows down and
    // speeds up but never doubles back.
    //
    // "flow" never closes, so the wobble can run SLOWER than the loop — a
    // period of three to six loops — and that is what buys a visible one. Big
    // amplitude at low frequency is a large, slow swing: the composition
    // turns, stalls for several seconds, drifts back a little, then carries
    // on. Same rate deviation per term (TAU * a * w), but spent on
    // displacement rather than on oscillation, so it reads as a change of
    // mind rather than a vibration.
    this._rev = this.o.mode === "loop"
      ? { w1: 1, a1: 0.055 + rnd() * 0.030, p1: rnd() * TAU,
          w2: 2, a2: 0.010 + rnd() * 0.012, p2: rnd() * TAU }
      : { w1: 0.15 + rnd() * 0.20, a1: 0.25 + rnd() * 0.25, p1: rnd() * TAU,
          w2: 0.50 + rnd() * 0.40, a2: 0.05 + rnd() * 0.06, p2: rnd() * TAU };
    return this;
  };

  // Per-frame mask preparation. Everything expensive lives here, in arrays
  // sized by grid WIDTH or HEIGHT rather than by cell count: the x-warp is a
  // function of the row only and the y-warp of the column only, so a
  // gw+gh-sized pair of tables replaces four sines per cell. The per-cell
  // path in _render is then two adds, two multiplies and two smoothsteps —
  // no trigonometry at all.
  BitMotionInstance.prototype._prepMask = function (phase) {
    var shape = this.o.shape;
    if (shape === "none") return;
    if (!this._mp) this._maskParams();
    var mp = this._mp;
    if (!mp) return;

    var gw = this.gw, gh = this.gh;
    var nxs = this._nxs, nys = this._nys;
    var inset = Math.max(0, Math.min(0.45, this.o.inset || 0));
    var morph = Math.max(0, Math.min(1, this.o.morph == null ? 0.6 : this.o.morph));
    var falloff = mp.falloff;
    var tp = TAU * phase;

    // WHICH END MOVES. The warp and the breathing are applied to the CORE,
    // and the outer end of the fade is left to `inset` alone. Putting them
    // on the outer end — which is what this did — means reserving room for
    // their outward swing, and that reserve came straight off the reach:
    // the fade had to finish short of the frame by the warp's amplitude
    // plus the breathing's, whether or not either was at its peak. Wobbling
    // the core instead costs nothing, and it is the better place for it
    // anyway: the core is where the ink is dense enough to see an outline
    // move. It also self-damps — as the fade lengthens the outer end is
    // pinned, so the wobble that reaches the visible boundary shrinks to
    // nothing exactly when a wobbling silhouette would stop making sense.
    if (shape === "radial") {
      // The outer limit, owned outright by `inset`.
      var X = 1 - inset;
      var pulse = 0.5 + 0.5 * Math.sin(tp * mp.kr + mp.pr);
      var breathe = mp.sband * 0.55 * morph * pulse;
      var baseCore = mp.coreR * X;
      var maxCore = X - 0.02;
      var rOut = this._rOut, rInv = this._rInv, r = mp.r;
      var offA = r.p + r.m * tp, offB = r.p2 + r.m2 * tp;
      // Per ANGLE rather than per radius: the table now carries the fade's
      // two ends already divided through, so the per-cell path is one
      // multiply and one subtract and the warp costs nothing extra.
      for (var i = 0; i < 256; i++) {
        var t = i / 256 - 0.5;
        var core = baseCore + breathe +
                   Math.sin(t * r.k + offA) * r.a + Math.sin(t * r.k2 + offB) * r.a2;
        if (core > maxCore) core = maxCore; else if (core < 0.02) core = 0.02;
        var bandR = (X - core) * falloff;
        if (bandR < 1e-3) bandR = 1e-3;
        var invR = 1 / bandR;
        rInv[i] = invR;
        rOut[i] = (core + bandR) * invR;   // tr = rOut[i] - rad * rInv[i]
      }
      return;
    }

    // Antiphase pairs: as sL grows, (1 - sL) shrinks. This one is left on
    // the frame rather than the core, because sliding the whole window is
    // the point of it — so it is the one thing that still costs reach, and
    // it is kept small enough for that to be a rounding error.
    var sL = 0.5 + 0.5 * Math.sin(tp * mp.kx + mp.px);
    var sT = 0.5 + 0.5 * Math.sin(tp * mp.ky + mp.py);
    var spanF = (mp.sband < 0.035 ? mp.sband : 0.035) * 0.55 * morph;
    var iL = inset * mp.sx + spanF * mp.sx * sL;
    var iR = inset * mp.sx + spanF * mp.sx * (1 - sL);
    var iT = inset * mp.sy + spanF * mp.sy * sT;
    var iB = inset * mp.sy + spanF * mp.sy * (1 - sT);

    var colDist = this._colDist, rowDist = this._rowDist;
    var xInv = this._xInv, xOut = this._xOut;
    var yInv = this._yInv, yOut = this._yOut;
    var wx = mp.x, wy = mp.y;
    var xA = wx.p + wx.m * tp, xB = wx.p2 + wx.m2 * tp;
    var yA = wy.p + wy.m * tp, yB = wy.p2 + wy.m2 * tp;
    var coreD = mp.coreD * (1 - 2 * inset);
    var maxCoreD = 0.5 - inset;

    // The anchor slides the window the mask describes, so the frame it fades
    // against travels with the composition rather than staying stapled to the
    // canvas. Sampled coordinates, not laid-out ones: a side pushed past the
    // canvas simply never fades, which is what an off-centre anchor is for.
    // One add per column and per row, so the per-cell path is untouched.
    var org = this._origin();
    var offX = 0.5 - org.x, offY = 0.5 - org.y;

    // The x-fade's core undulates down the frame, so its two ends are a
    // function of the ROW; the y-fade's of the column. Same division-free
    // trick as the radial: the tables hold the ends already divided by the
    // band they belong to.
    for (var x = 0; x < gw; x++) {
      var nx = nxs[x] + offX;
      var dl = nx - iL, dr = (1 - nx) - iR;
      colDist[x] = dl < dr ? dl : dr;
      var cy = coreD + Math.sin(nx * wy.k + yA) * wy.a + Math.sin(nx * wy.k2 + yB) * wy.a2;
      if (cy > maxCoreD) cy = maxCoreD; else if (cy < 0.01) cy = 0.01;
      var by = cy * falloff;
      if (by < 1e-3) by = 1e-3;
      var iby = 1 / by;
      yInv[x] = iby;
      yOut[x] = (cy - by) * iby;           // ty = rowDist[y] * yInv[x] - yOut[x]
    }
    for (var y = 0; y < gh; y++) {
      var ny = nys[y] + offY;
      var dt = ny - iT, db = (1 - ny) - iB;
      rowDist[y] = dt < db ? dt : db;
      var cx = coreD + Math.sin(ny * wx.k + xA) * wx.a + Math.sin(ny * wx.k2 + xB) * wx.a2;
      if (cx > maxCoreD) cx = maxCoreD; else if (cx < 0.01) cx = 0.01;
      var bx = cx * falloff;
      if (bx < 1e-3) bx = 1e-3;
      var ibx = 1 / bx;
      xInv[y] = ibx;
      xOut[y] = (cx - bx) * ibx;           // tx = colDist[x] * xInv[y] - xOut[y]
    }
  };

  /* ---------------------------------------------------------------- render */

  /* ---------------------------------------------------------------- render */

  BitMotionInstance.prototype._render = function (time) {
    var o = this.o, gw = this.gw, gh = this.gh;
    var work = this.work;

    // --- 1. evaluate the smooth source field -----------------------------
    if (o.mode === "loop") {
      var phase = (time / o.loopSeconds) % 1;
      this._fill(work, this.current.scene, phase, 1, null, 0);
      this._prepMask(phase);
      this.sceneName = this.current.name;
    } else {
      var seg = this._segment(time);
      var span = seg.span;
      var n = seg.n;
      var local = time - seg.start;
      var a = this._field(n);
      // Phase keeps advancing globally so nothing snaps at a boundary.
      var ph = time / o.loopSeconds;
      var fadeIn = o.crossfade > 0 ? clamp01((span - local) / o.crossfade) : 1;
      this._prepMask(ph);
      if (fadeIn < 1) {
        var b = this._field(n + 1);
        this._fill(work, a.scene, ph, smoothstep(fadeIn), b.scene, smoothstep(1 - fadeIn));
        this.sceneName = a.name === b.name
          ? a.name + " (crossfade)"
          : a.name + " → " + b.name;
      } else {
        this._fill(work, a.scene, ph, 1, null, 0);
        this.sceneName = a.name;
      }
    }

    // --- 2. normalise, then field -> continuous RGB via the ramp LUT -----
    // Scenes are built from randomised sums, so their raw range drifts with
    // the parameters. Auto-levels rescale it to the ramp, tracked with an
    // exponential average so the tone eases rather than pumping frame to
    // frame.
    var lo = 0, hi = 1;
    if (o.levels && this._fixedLo != null) {
      lo = this._fixedLo;
      hi = this._fixedHi;
    } else if (o.levels) {
      var fmin = Infinity, fmax = -Infinity;
      var lr = this._levelRect();
      for (var ly = lr.y0; ly <= lr.y1; ly++) {
        var lbase = ly * gw;
        for (var lx = lr.x0; lx <= lr.x1; lx++) {
          var wv = work[lbase + lx];
          if (wv < fmin) fmin = wv;
          if (wv > fmax) fmax = wv;
        }
      }
      if (fmax - fmin < 1e-4) fmax = fmin + 1e-4;
      if (this._lo == null) { this._lo = fmin; this._hi = fmax; }
      else {
        var k = 0.04;
        this._lo += (fmin - this._lo) * k;
        this._hi += (fmax - this._hi) * k;
      }
      lo = this._lo;
      hi = this._hi > this._lo + 1e-4 ? this._hi : this._lo + 1e-4;
    }
    var scale = 1 / (hi - lo);

    var acc = this.acc, lut = this.rampLut, contrast = o.contrast, exposure = o.exposure;
    var masked = o.shape !== "none";
    var radialMask = masked && o.shape === "radial";
    var colDist = this._colDist, rowDist = this._rowDist;
    var xInvT = this._xInv, xOutT = this._xOut;
    var yInvT = this._yInv, yOutT = this._yOut;
    var radArr = this._rad, thetaIdx = this._thetaIdx;
    var rOut = this._rOut, rInv = this._rInv;
    var out = this.imgData.data;
    var idxOut = this.indices;
    var pal = this.palFlat, np = this.palette.length;
    var bgIdx = this.bgIndex, transparent = o.transparent;
    var bgRgb = hexToRgb(o.background);
    var mode = o.dither;
    var pr = 0, pg = 0, pb = 0;
    if (masked) {
      var paper = hexToRgb(o.background);
      pr = paper.r; pg = paper.g; pb = paper.b;
    }

    // --- 3. ramp + quantise, fused into one pass -------------------------
    // These were two passes: one writing every cell's ramp colour into `acc`,
    // another reading it back to quantise. At small block sizes `acc` is tens
    // of megabytes, so that round trip was the single biggest cost in the
    // frame — more than generating the field.
    //
    // Fusing them works because `acc` only ever needs to carry *diffused
    // error*: the error a cell receives is written by earlier cells in scan
    // order, and its own ramp colour can be computed on arrival and added.
    // So `acc` starts at zero and the colour is folded in per cell, which is
    // arithmetically identical to the two-pass version.
    var diffusing = (mode === "atkinson");
    if (diffusing) acc.fill(0);

    for (var y = 0; y < gh; y++) {
      var rowBase = y * gw;
      // Hoisted per row: the only mask terms that vary with y.
      var rowD = masked && !radialMask ? rowDist[y] : 0;
      // The x-fade's two ends are constant down a row, so they hoist.
      var xInv = masked && !radialMask ? xInvT[y] : 0;
      var xOut = masked && !radialMask ? xOutT[y] : 0;
      for (var x = 0; x < gw; x++) {
        var p = rowBase + x;

        var v = (work[p] - lo) * scale;
        if (contrast !== 1) v = (v - 0.5) * contrast + 0.5;
        if (exposure) v += exposure;
        var qi = v < 0 ? 0 : v > 1 ? 255 : (v * 255) | 0;
        qi *= 3;
        var r = lut[qi], g = lut[qi + 1], b = lut[qi + 2];

        // The falloff fades toward the background *in colour space*, not by
        // walking the value down the ramp — scaling the value would drag
        // every edge cell through the ramp's low colours and paint a visible
        // border ring around the frame. Fading the colour instead lets each
        // cell dissolve straight into the page, which is what the dither then
        // scatters against.
        if (masked) {
          // Two smoothsteps over a pair of table lookups — the whole animated
          // silhouette, with no trigonometry and no division in the per-cell
          // path: the tables carry the fade's ends pre-divided by its band.
          var mv;
          if (radialMask) {
            var ti = thetaIdx[p];
            var tr = rOut[ti] - radArr[p] * rInv[ti];
            if (tr < 0) tr = 0; else if (tr > 1) tr = 1;
            mv = tr * tr * (3 - 2 * tr);
          } else {
            var tx = colDist[x] * xInv - xOut;
            if (tx < 0) tx = 0; else if (tx > 1) tx = 1;
            var ty = rowD * yInvT[x] - yOutT[x];
            if (ty < 0) ty = 0; else if (ty > 1) ty = 1;
            mv = tx * tx * (3 - 2 * tx) * ty * ty * (3 - 2 * ty);
          }
          // Widen the mass without moving the boundary. A plain smoothstep
          // puts its half-way point half-way along the band, so lengthening
          // the gradient eats into the solid middle from both sides at once
          // and a softer falloff reads as a SMALLER shape. Folding the curve
          // back on itself pushes the half-way point out to about a third of
          // the band: the fade still finishes exactly where it did, the flat
          // core survives, and the gradient spends its length on a long
          // outer tail — which is the part that dissolves into the page.
          // Both ends keep a zero derivative, so nothing gains an edge.
          mv = mv * (2 - mv);
          if (mv < 1) {
            var nv = 1 - mv;
            r = r * mv + pr * nv;
            g = g * mv + pg * nv;
            b = b * mv + pb * nv;
          }
        }

        if (diffusing) {
          var a3 = p * 3;
          r += acc[a3]; g += acc[a3 + 1]; b += acc[a3 + 2];
        } else if (mode === "bayer") {
          var bias = BAYER8[(y & 7) * 8 + (x & 7)] * 56;
          r += bias; g += bias; b += bias;
        }

        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;

        // Nearest palette entry, inlined — this is the hot loop.
        var best = 0, bestD = Infinity;
        for (var c = 0, c3 = 0; c < np; c++, c3 += 3) {
          var dr = r - pal[c3], dg = g - pal[c3 + 1], db = b - pal[c3 + 2];
          var d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = c; }
        }
        var b3 = best * 3;

        if (diffusing) {
          var er = (r - pal[b3]) * 0.125;
          var eg = (g - pal[b3 + 1]) * 0.125;
          var eb = (b - pal[b3 + 2]) * 0.125;
          // Atkinson's six neighbours, unrolled. The offsets were a nested
          // array literal; indexing that per neighbour per cell is millions
          // of double dereferences a frame for six constants.
          var down1 = (y + 1 < gh), down2 = (y + 2 < gh);
          var t;
          if (x + 1 < gw) { t = (p + 1) * 3; acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
          if (x + 2 < gw) { t = (p + 2) * 3; acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
          if (down1) {
            var rn = p + gw;
            if (x > 0)      { t = (rn - 1) * 3; acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
            { t = rn * 3;       acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
            if (x + 1 < gw) { t = (rn + 1) * 3; acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
          }
          if (down2) { t = (p + gw + gw) * 3; acc[t] += er; acc[t + 1] += eg; acc[t + 2] += eb; }
        }

        idxOut[p] = best;

        var oi = p * 4;
        if (best === bgIdx && transparent) {
          out[oi] = out[oi + 1] = out[oi + 2] = 0;
          out[oi + 3] = 0;
        } else if (best === bgIdx) {
          out[oi] = bgRgb.r; out[oi + 1] = bgRgb.g; out[oi + 2] = bgRgb.b; out[oi + 3] = 255;
        } else {
          out[oi] = pal[b3];
          out[oi + 1] = pal[b3 + 1];
          out[oi + 2] = pal[b3 + 2];
          out[oi + 3] = 255;
        }
      }
    }

    // --- 4. blit and scale up with hard pixel edges ----------------------
    this.gctx.putImageData(this.imgData, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!transparent) {
      this.ctx.fillStyle = o.background;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.ctx.drawImage(this.grid, 0, 0, this.canvas.width, this.canvas.height);
  };

  // Writes the field into `work`, optionally blending two compositions.
  // The angle `revolve` has turned the composition to by `phase`.
  //
  // A whole turn per loop at a constant rate is the most predictable thing on
  // screen: three seconds of it and you can call the next thirty. The two
  // wobble terms are added to the ANGLE, which modulates the RATE — the
  // composition surges, stalls and (in "flow") drifts back a little instead of
  // sweeping round like a second hand. See `_rev` for why the two modes carry
  // very different amplitudes.
  //
  // Kept out of `_fill` so its per-cell loop stays exactly the shape the JIT
  // already compiles well — folding these few lines into that function cost
  // five times the fill.
  BitMotionInstance.prototype._revolveAngle = function (phase, turns) {
    var ang = TAU * turns * phase;
    var rv = this._rev;
    // Vary a turn, never invent one: with `revolve: 0` the composition holds.
    if (!turns || !rv) return ang;
    return ang + (Math.sin(TAU * rv.w1 * phase + rv.p1) * rv.a1 +
                  Math.sin(TAU * rv.w2 * phase + rv.p2) * rv.a2) * TAU * turns;
  };

  // prep() runs once per frame; only at() is in the per-cell path.
  //
  // `revolve` turns the sampling grid about the frame centre, which revolves
  // the whole composition — gradient axis and blobs together. Without it a
  // scene's gradient axis is fixed for its whole life and only its offset
  // slides, so the colours forever belong to the same corners. The falloff
  // mask is deliberately NOT rotated: it lives in screen space, so the
  // artwork stays framed while the colour turns inside it.
  //
  // Turns must be whole numbers or the loop would not close — half a turn
  // leaves the composition upside down at the seam.
  BitMotionInstance.prototype._fill = function (work, sceneA, phase, wA, sceneB, wB) {
    var gw = this.gw, gh = this.gh;
    var invW = 1 / (gw - 1 || 1), invH = 1 / (gh - 1 || 1);
    var x, y, ny, row, nx;

    sceneA.prep(phase);
    var atA = sceneA.at;
    var atB = null;
    if (sceneB) { sceneB.prep(phase); atB = sceneB.at; }

    // Whole turns only in "loop" mode — half a turn would leave the
    // composition upside down at the seam. "flow" mode never closes, so a
    // fractional `revolve` is free there.
    var turns = this.o.revolve || 0;
    if (this.o.mode === "loop") turns = Math.round(turns);
    var inset = Math.max(0, Math.min(0.45, this.o.inset || 0));

    // Reserving a margin in the mask alone would just clip the composition at
    // the new boundary. Shrinking the field by the same fraction makes it fit
    // inside the margin instead. Sampling a wider area makes features smaller,
    // hence the reciprocal — and because rotation and uniform scale about the
    // same centre commute, the factor folds straight into the rotation matrix
    // and costs nothing extra per cell.
    //
    // The fraction is `inset`, not twice it. The mask's margin is `inset` of
    // the HALF-extent per side, so the window it leaves is `1 - inset` of the
    // frame; shrinking by `1 - 2 * inset` squeezed the field into half that,
    // and the difference does not show as a smaller composition — it shows as
    // a washed-out one. The screen then samples far outside the field's own
    // 0..1 domain, where a scene is only its gradient still climbing, and
    // auto-levels measure the whole grid: those runaway values set the range
    // and everything inside the window is squeezed into a fraction of the
    // ramp. At the old factor a strong margin flattened the artwork to a
    // plain wash, which is why `inset` could not be turned up far.
    var shrink = 1 - inset;
    var invShrink = shrink > 0.05 ? 1 / shrink : 1;

    // Squash-and-stretch. Two octaves so it does not read as a single
    // metronomic pulse; clamped well clear of 1 so the reciprocal stays sane.
    var morph = Math.max(0, Math.min(1, this.o.morph == null ? 0.6 : this.o.morph));
    var e = 0;
    if (morph > 0) {
      var sq = this._sq;
      if (sq) {
        e = (Math.sin(TAU * (sq.k * phase) + sq.p) * 0.72 +
             Math.sin(TAU * (sq.k2 * phase) + sq.p2) * 0.28) * 0.42 * morph;
        if (e > 0.45) e = 0.45; else if (e < -0.45) e = -0.45;
      }
    }

    var ang = this._revolveAngle(phase, turns);

    // The anchor. It is a translation of the SAMPLING grid, so the whole
    // composition — gradient axis, blobs, the lot — moves as one rigid thing
    // and keeps its proportions; only the part that still falls inside the
    // frame is drawn. It is also the centre the composition revolves and
    // squashes about, so an anchored composition turns about its own anchor
    // instead of pivoting around a frame centre it no longer occupies.
    var org = this._origin();
    var ox = org.x, oy = org.y;
    var anchored = ox !== 0.5 || oy !== 0.5;

    if (turns || inset > 0 || e !== 0 || anchored) {
      var c = Math.cos(ang) * invShrink, s = Math.sin(ang) * invShrink;

      // Rotate, then scale the two screen axes by reciprocal factors. Folding
      // both into one matrix keeps the per-cell cost at four multiplies —
      // identical to plain rotation.
      var qx = 1 / (1 + e), qy = 1 / (1 - e);
      var a11 = c * qx, a12 = -s * qx;
      var a21 = s * qy, a22 = c * qy;

      // Rotate in an aspect-corrected space, otherwise a non-square grid
      // shears the composition instead of turning it.
      var asp = gw / gh;
      var invAsp = 1 / asp;

      for (y = 0; y < gh; y++) {
        ny = y * invH;
        row = y * gw;
        var dy = ny - oy;
        for (x = 0; x < gw; x++) {
          var dx = (x * invW - ox) * asp;
          var rx = (dx * a11 + dy * a12) * invAsp + 0.5;
          var ry = (dx * a21 + dy * a22) + 0.5;
          work[row + x] = atB
            ? atA(rx, ry) * wA + atB(rx, ry) * wB
            : atA(rx, ry) * wA;
        }
      }
      return;
    }

    for (y = 0; y < gh; y++) {
      ny = y * invH;
      row = y * gw;
      for (x = 0; x < gw; x++) {
        nx = x * invW;
        work[row + x] = atB
          ? atA(nx, ny) * wA + atB(nx, ny) * wB
          : atA(nx, ny) * wA;
      }
    }
  };

  /* ----------------------------------------------------------- transport */

  BitMotionInstance.prototype._loop = function () {
    if (this._raf) return;
    var self = this;
    var minDelta = self.o.fps > 0 ? 1 / self.o.fps : 0;
    var last = performance.now();

    function frame(now) {
      self._raf = null;
      if (!self.running) return;
      // Browsers already throttle rAF to a stop in background tabs, so the
      // only check worth making is whether the canvas is actually on screen.
      if (!self.visible) return; // resumes via the IntersectionObserver

      var dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      self.elapsed += dt;

      if (self.elapsed - self.lastDraw >= minDelta) {
        self.lastDraw = self.elapsed;
        self._render(self.elapsed);
      }
      self._raf = requestAnimationFrame(frame);
    }
    self._raf = requestAnimationFrame(frame);
  };

  BitMotionInstance.prototype.play = function () {
    if (this.running) return this;
    this.running = true;
    this.lastDraw = -1e9;
    // Paint one frame up front. requestAnimationFrame does not fire at all
    // while the document is hidden or the canvas is off-screen, so without
    // this the canvas can sit blank until the first frame happens to run —
    // visible as a flash on a restored tab, or in a screenshot taken before
    // the loop starts.
    this._render(this.elapsed);
    this.lastDraw = this.elapsed;
    this._loop();
    return this;
  };

  BitMotionInstance.prototype.pause = function () {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    return this;
  };

  BitMotionInstance.prototype.seek = function (seconds) {
    this.elapsed = seconds;
    this._render(this.elapsed);
    return this;
  };

  BitMotionInstance.prototype.destroy = function () {
    this.pause();
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVis);
    if (this._io) this._io.disconnect();
    unmount(this); // drops the element registration `init` made, if any
    return this;
  };

  /* ----------------------------------------------------------------- mount */

  // Page-level entry point. `<canvas data-bitmotion></canvas>` is enough to
  // get an animation with no script of your own: the mount pass below runs
  // once the DOM is ready and again whenever you call `init()`.
  //
  // Options come from two places, and the later one wins:
  //   data-bitmotion='{"scene":"waves","cellSize":4}'   JSON, all at once
  //   data-bitmotion-scene="waves" data-bitmotion-cell-size="4"
  // The attribute form exists because CMS fields and template engines make
  // quoting a JSON blob miserable; the two mix freely on one element.
  //
  // `data-bitmotion` on something other than a canvas fills that element with
  // one, so a container you have already sized in CSS needs no extra markup.

  var mounted = []; // [{ el, instance }] — a page has a handful of these at most

  function mountedFor(el) {
    for (var i = 0; i < mounted.length; i++) if (mounted[i].el === el) return mounted[i].instance;
    return null;
  }

  // Called from `destroy` so a torn-down element can be mounted again later.
  function unmount(instance) {
    for (var i = 0; i < mounted.length; i++) {
      if (mounted[i].instance === instance) { mounted.splice(i, 1); return; }
    }
  }

  function warn(msg, detail) {
    if (typeof console !== "undefined" && console.warn) console.warn("BitMotion: " + msg, detail);
  }

  // Attribute values arrive as strings. Numbers and booleans are the common
  // case; anything that parses as JSON (an array of ramp stops, an {x, y}
  // origin) is taken as written, and everything else stays a string.
  function parseValue(raw) {
    var s = String(raw).trim();
    if (s === "") return true; // bare attribute reads as a flag
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (s.charAt(0) === "{" || s.charAt(0) === "[") {
      try { return JSON.parse(s); } catch (err) { return s; }
    }
    return s;
  }

  function camelCase(s) {
    return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  function readOptions(el) {
    var opts = {}, k;
    var json = (el.getAttribute("data-bitmotion") || "").trim();
    if (json) {
      try {
        var parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object") for (k in parsed) opts[k] = parsed[k];
      } catch (err) {
        // A malformed blob is a typo in a template, not a reason to leave the
        // page blank: fall back to the defaults and say so once.
        warn("could not parse the data-bitmotion JSON on", el);
      }
    }
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.indexOf("data-bitmotion-") !== 0) continue;
      k = camelCase(name.slice(15));
      if (k) opts[k] = parseValue(attrs[i].value);
    }
    delete opts.canvas; // the element decides this, not the markup
    return opts;
  }

  // The canvas to draw into: the element itself when it is one, otherwise a
  // child that fills it. The child is tagged so a second mount reuses it
  // rather than stacking canvases.
  function canvasFor(el) {
    if (String(el.tagName).toLowerCase() === "canvas") return el;
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].hasAttribute("data-bitmotion-canvas")) return el.children[i];
    }
    var c = (el.ownerDocument || document).createElement("canvas");
    c.setAttribute("data-bitmotion-canvas", "");
    c.style.display = "block";
    c.style.width = "100%";
    c.style.height = "100%";
    el.appendChild(c);
    return c;
  }

  function toElements(target) {
    if (typeof document === "undefined") return [];
    if (target == null) target = "[data-bitmotion]";
    if (typeof target === "string") return [].slice.call(document.querySelectorAll(target));
    if (target.nodeType === 1) return [target];
    if (typeof target.length === "number") return [].slice.call(target);
    return [];
  }

  // init()                       -> every [data-bitmotion] element on the page
  // init(".hero")                -> a selector, element, NodeList or array
  // init(".hero", { seed: 12 })  -> same, with options that beat the markup
  //
  // Idempotent: an element that is already running is left alone and its
  // existing instance returned, so it is safe to call after injecting markup.
  function init(target, overrides) {
    var els = toElements(target), out = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var existing = mountedFor(el);
      if (existing) { out.push(existing); continue; }

      var opts = readOptions(el), k;
      if (overrides) for (k in overrides) if (overrides[k] !== undefined) opts[k] = overrides[k];
      opts.canvas = canvasFor(el);

      var instance;
      try {
        instance = new BitMotionInstance(opts);
      } catch (err) {
        // One bad element must not take the rest of the page down with it.
        warn("could not start on an element: " + (err && err.message), el);
        continue;
      }
      mounted.push({ el: el, instance: instance });
      out.push(instance);
    }
    return out;
  }

  // Mount whatever is already in the markup. Inert on a page with no
  // `data-bitmotion` attribute, and skipped entirely where there is no DOM at
  // all, so importing this during server-side rendering does nothing.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { init(); });
    } else {
      init();
    }
  }

  /* -------------------------------------------------------------- exports */

  return {
    create: function (opts) { return new BitMotionInstance(opts); },
    init: init,
    get: function (target) {
      var els = toElements(target);
      return els.length ? mountedFor(els[0]) : null;
    },
    destroyAll: function () {
      while (mounted.length) mounted[0].instance.destroy();
    },
    RAMPS: RAMPS,
    // Every option name, so a wrapper can tell an option from a prop of its
    // own without keeping its own copy of the list.
    OPTIONS: Object.keys(DEFAULTS),
    BACKGROUNDS: BACKGROUNDS,
    ORIGINS: ORIGINS,
    SCENES: SCENE_NAMES,
    COLORS: HS,
    hexToRgb: hexToRgb
  };
});
