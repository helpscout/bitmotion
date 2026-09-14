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
    purple: "#4B158C",
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
    var blobLed = rnd() < 0.5;
    var ang = rnd() * TAU;
    var gx = Math.cos(ang), gy = Math.sin(ang);
    var gain = blobLed ? (0.30 + rnd() * 0.45) : (1.0 + rnd() * 0.8);
    var sweep = TAU * (1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1);
    var sweepAmt = 0.10 + rnd() * 0.16;

    var want = opts && opts.blobs != null ? opts.blobs : 5;
    var n = Math.max(0, Math.min(12, Math.round(want)));

    var cx = new Float64Array(n), cy = new Float64Array(n);
    var rx = new Float64Array(n), ry = new Float64Array(n);
    var kk = new Float64Array(n), ph = new Float64Array(n);
    var ww = new Float64Array(n), inv = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      cx[i] = 0.08 + rnd() * 0.84;
      cy[i] = 0.08 + rnd() * 0.84;
      rx[i] = 0.08 + rnd() * 0.38;
      ry[i] = 0.08 + rnd() * 0.38;
      // Direction is drawn per blob rather than alternating by index, and
      // speeds run 1-3 turns, so blobs cross each other instead of holding
      // formation. Whole turns keep the loop closed.
      kk[i] = (rnd() < 0.5 ? -1 : 1) * (1 + (rnd() * 3 | 0));
      ph[i] = rnd();
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
          bx[i] = cx[i] + Math.cos(a) * rx[i];
          by[i] = cy[i] + Math.sin(a) * ry[i];
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
  SCENES.waves = function (p, rnd) {
    var n = 3 + (rnd() * 3 | 0);
    var kx = new Float64Array(n), ky = new Float64Array(n);
    var w = new Float64Array(n), ph0 = new Float64Array(n);
    var amp = 0.6 / n;
    for (var i = 0; i < n; i++) {
      var ang = rnd() * TAU;
      var freq = (1.2 + rnd() * 3.4) * TAU;
      kx[i] = Math.cos(ang) * freq;
      ky[i] = Math.sin(ang) * freq;
      w[i] = TAU * (1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1);
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
  SCENES.bloom = function (p, rnd) {
    var cx = 0.3 + rnd() * 0.4, cy = 0.3 + rnd() * 0.4;
    var rings = (0.9 + rnd() * 1.3) * TAU;
    var speed = TAU * (1 + (rnd() * 2 | 0)) * (rnd() < 0.4 ? -1 : 1);
    var squash = 0.7 + rnd() * 0.6;
    var wobK = 2 + (rnd() * 3 | 0);
    var spin = 0, drift = 0;

    return {
      prep: function (phase) {
        spin = phase * TAU;
        drift = phase * speed;
      },
      at: function (x, y) {
        var dx = x - cx, dy = (y - cy) * squash;
        var d = Math.sqrt(dx * dx + dy * dy);
        var wob = Math.sin(Math.atan2(dy, dx) * wobK + spin) * 0.06;
        return 0.5 + Math.sin((d + wob) * rings - drift) * 0.42 * (1 - d * 0.5);
      }
    };
  };

  // Wide diagonal bands warped by a slow sine — sweeping ribbons of colour.
  SCENES.ribbon = function (p, rnd) {
    var ang = rnd() * TAU;
    var gx = Math.cos(ang), gy = Math.sin(ang);
    var bands = (0.5 + rnd() * 0.9) * TAU;
    var warpK = (1 + rnd() * 2.5) * TAU;
    var warpAmt = 0.12 + rnd() * 0.22;
    var drift = TAU * (1 + (rnd() * 2 | 0));
    var wp = 0, dp = 0;

    return {
      prep: function (phase) {
        wp = phase * TAU;
        dp = phase * drift;
      },
      at: function (x, y) {
        var u = x * gx + y * gy;
        var warp = Math.sin((x * 0.6 - y) * warpK + wp) * warpAmt;
        return 0.5 + Math.sin((u + warp) * bands - dp) * 0.45;
      }
    };
  };

  // Layered blobs plus a counter-rotating swirl — the busiest of the four.
  SCENES.nebula = function (p, rnd, opts) {
    var inner = SCENES.drift(p, rnd, opts);
    var swirlK = (1 + rnd() * 2) * TAU;
    var spinRate = TAU * (1 + (rnd() * 2 | 0));
    var spin = 0;

    return {
      prep: function (phase) {
        inner.prep(phase);
        spin = phase * spinRate;
      },
      at: function (x, y) {
        var dx = x - 0.5, dy = y - 0.5;
        var r = Math.sqrt(dx * dx + dy * dy);
        var th = Math.atan2(dy, dx);
        return inner.at(x, y) + Math.sin(th * 2 + r * swirlK - spin) * 0.22 * (1 - r);
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
    falloff: 0.45,         // 0..1 — how far the mask reaches in from the frame
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
    var spec = typeof ramp === "string" ? RAMPS[ramp] : ramp;
    if (!spec) spec = RAMPS.dissolve;
    this.o.ramp = ramp;
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
    if (key === "ramp") return this.setRamp(value);
    this.o[key] = value;
    if (key === "resolution" || key === "cellSize" || key === "maxDpr" ||
        key === "maxCells") this._resize();
    if (key === "morph") this._maskParams();
    if (key === "shape") this._resize(); // radial needs its per-cell tables
    if (key === "shape" || key === "falloff" || key === "inset") {
      this._maskParams();
      this._lo = null;
      this._calibrate();
    }
    if (key === "scene" || key === "scenes" || key === "blobs") this._pickScene(this.elapsed);
    if (key === "mode" || key === "levels" || key === "revolve") {
      this._lo = null;
      this._calibrate();
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

  BitMotionInstance.prototype._pickScene = function () {
    this._fieldCache = {};
    this.current = this._buildField(0);
    this._calibrate();
    return this;
  };

  // In "loop" mode the levels cannot be adapted frame to frame: an
  // exponential average carries history, so the tone at t=0 would not match
  // the tone at t=loopSeconds and the loop would visibly jump at the seam.
  // Instead, sample the whole cycle once up front and fix the range, which
  // makes the render an exact function of phase — and therefore periodic.
  BitMotionInstance.prototype._calibrate = function () {
    this._fixedLo = null;
    if (this.o.mode !== "loop" || !this.o.levels || !this.current) return this;
    if (!this.gw || !this.gh || !this.work) return this;

    // Sampled through _fill rather than by calling the scene directly, so the
    // calibration sees exactly what the renderer will — including `revolve`.
    var work = this.work;
    var lo = Infinity, hi = -Infinity;
    var STEPS = 24;

    for (var s = 0; s < STEPS; s++) {
      this._fill(work, this.current.scene, s / STEPS, 1, null, 0);
      for (var i = 0; i < work.length; i++) {
        var v = work[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
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
    this._warpRow = new Float32Array(gh);
    this._warpCol = new Float32Array(gw);
    this._radWarp = new Float32Array(256);

    // Radial needs per-cell radius and angle, so it pays for two arrays the
    // edges mask does not. Allocated only when that shape is in use.
    if (this.o.shape === "radial") {
      this._rad = new Float32Array(gw * gh);
      this._thetaIdx = new Uint8Array(gw * gh);
      for (var ry = 0; ry < gh; ry++) {
        for (var rx = 0; rx < gw; rx++) {
          var ax = (this._nxs[rx] - 0.5) * 2, ay = (this._nys[ry] - 0.5) * 2;
          var p2 = ry * gw + rx;
          this._rad[p2] = Math.sqrt(ax * ax + ay * ay) / Math.SQRT2;
          this._thetaIdx[p2] = ((Math.atan2(ay, ax) / TAU + 0.5) * 256) & 255;
        }
      }
    } else {
      this._rad = null;
      this._thetaIdx = null;
    }
    // Palette index per cell, kept alongside the RGBA so exporters can encode
    // indexed formats (GIF) straight from the grid without re-quantising.
    this.indices = new Uint8Array(gw * gh);
    this._lo = null; // re-measure levels against the new grid
    this._maskParams();
    this._calibrate();
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

    var band = Math.max(0.001, Math.min(1, this.o.falloff)) * 0.5;
    var minSide = Math.min(gw, gh);
    var sx = minSide / gw, sy = minSide / gh;
    var rnd = makeRandom(this.rndSeed ^ 0x5bf03635);

    // Amplitudes are a fraction of the fade band, and the spatial frequency
    // stays under one cycle across the frame, so the edge undulates instead
    // of scalloping into decoration. Amplitudes scale per axis by that axis'
    // share of the short edge, keeping the wobble the same size in PIXELS on
    // both axes. `m`/`m2` are the TIME frequencies: whole numbers of turns
    // per loop, which is what lets the boundary travel and still close.
    function axis(axisScale) {
      return {
        a: band * (0.18 + rnd() * 0.22) * axisScale,
        k: (0.55 + rnd() * 0.75) * TAU,
        p: rnd() * TAU,
        m: (1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1),
        a2: band * (0.06 + rnd() * 0.10) * axisScale,
        k2: (1.3 + rnd() * 1.2) * TAU,
        p2: rnd() * TAU,
        m2: (1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1)
      };
    }

    this._mp = {
      band: band,
      invBand: 1 / band,
      sx: sx, sy: sy,
      // Envelope bound: the warp is bipolar, so at its positive peaks it
      // pushes the boundary OUTWARD. Measuring the margin from the envelope
      // rather than the average is what makes `inset` a floor instead of an
      // average, and it holds while the warp travels because travelling only
      // shifts phase, never amplitude.
      warpMaxX: band * 0.56 * sx,
      warpMaxY: band * 0.56 * sy,
      warpMaxR: band * 0.56,
      x: axis(sx),
      y: axis(sy),
      r: axis(1),
      // Per-side breathing. Opposite sides run in antiphase, so the window
      // squeezes on one side as it releases on the other — it slides and
      // squashes rather than just pulsing symmetrically.
      kx: (1 + (rnd() * 2 | 0)), px: rnd() * TAU,
      ky: (1 + (rnd() * 2 | 0)), py: rnd() * TAU,
      kr: (1 + (rnd() * 2 | 0)), pr: rnd() * TAU
    };

    // Squash-and-stretch of the composition itself. Breathing the mask alone
    // barely shows, because the mask is not what bounds the silhouette most
    // of the time — the field's own falloff is. Scaling the field
    // anisotropically is what actually changes the overall shape: it widens
    // as it flattens and back, in antiphase, so the area stays roughly
    // constant instead of pulsing bigger and smaller. Whole cycles per loop,
    // so it closes.
    this._sq = {
      k: (1 + (rnd() * 2 | 0)) * (rnd() < 0.5 ? -1 : 1),
      p: rnd() * TAU,
      k2: (1 + (rnd() * 3 | 0)) * (rnd() < 0.5 ? -1 : 1),
      p2: rnd() * TAU
    };
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

    // How far the breathing may pull the boundary in, on top of the
    // guaranteed margin. It only ever ADDS inset, so the floor survives.
    var span = mp.band * 0.55 * morph;
    var tp = TAU * phase;

    if (shape === "radial") {
      var pulse = 0.5 + 0.5 * Math.sin(tp * mp.kr + mp.pr);
      var insetR = inset + mp.warpMaxR + span * pulse;
      var rw = this._radWarp, r = mp.r;
      var offA = r.p + r.m * tp, offB = r.p2 + r.m2 * tp;
      for (var i = 0; i < 256; i++) {
        var t = i / 256 - 0.5;
        rw[i] = Math.sin(t * r.k + offA) * r.a + Math.sin(t * r.k2 + offB) * r.a2;
      }
      this._insetR = insetR;
      return;
    }

    // Antiphase pairs: as sL grows, (1 - sL) shrinks.
    var sL = 0.5 + 0.5 * Math.sin(tp * mp.kx + mp.px);
    var sT = 0.5 + 0.5 * Math.sin(tp * mp.ky + mp.py);
    var iL = inset * mp.sx + mp.warpMaxX + span * mp.sx * sL;
    var iR = inset * mp.sx + mp.warpMaxX + span * mp.sx * (1 - sL);
    var iT = inset * mp.sy + mp.warpMaxY + span * mp.sy * sT;
    var iB = inset * mp.sy + mp.warpMaxY + span * mp.sy * (1 - sT);

    var colDist = this._colDist, rowDist = this._rowDist;
    var warpRow = this._warpRow, warpCol = this._warpCol;
    var wx = mp.x, wy = mp.y;
    var xA = wx.p + wx.m * tp, xB = wx.p2 + wx.m2 * tp;
    var yA = wy.p + wy.m * tp, yB = wy.p2 + wy.m2 * tp;

    for (var x = 0; x < gw; x++) {
      var nx = nxs[x];
      var dl = nx - iL, dr = (1 - nx) - iR;
      colDist[x] = dl < dr ? dl : dr;
      warpCol[x] = Math.sin(nx * wy.k + yA) * wy.a + Math.sin(nx * wy.k2 + yB) * wy.a2;
    }
    for (var y = 0; y < gh; y++) {
      var ny = nys[y];
      var dt = ny - iT, db = (1 - ny) - iB;
      rowDist[y] = dt < db ? dt : db;
      warpRow[y] = Math.sin(ny * wx.k + xA) * wx.a + Math.sin(ny * wx.k2 + xB) * wx.a2;
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
      var span = Math.max(o.crossfade + 0.5, o.sceneSeconds);
      var n = Math.floor(time / span);
      var local = time - n * span;
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
      for (var m = 0; m < work.length; m++) {
        var wv = work[m];
        if (wv < fmin) fmin = wv;
        if (wv > fmax) fmax = wv;
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
    var warpRow = this._warpRow, warpCol = this._warpCol;
    var radArr = this._rad, thetaIdx = this._thetaIdx, radWarp = this._radWarp;
    var invBand = this._mp ? this._mp.invBand : 1;
    var insetR = this._insetR || 0;
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
      var wRow = masked && !radialMask ? warpRow[y] : 0;
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
          // silhouette, with no trigonometry in the per-cell path.
          var mv;
          if (radialMask) {
            var tr = (1 - radArr[p] - insetR - radWarp[thetaIdx[p]]) * invBand;
            if (tr < 0) tr = 0; else if (tr > 1) tr = 1;
            mv = tr * tr * (3 - 2 * tr);
          } else {
            var tx = (colDist[x] + wRow) * invBand;
            if (tx < 0) tx = 0; else if (tx > 1) tx = 1;
            var ty = (rowD + warpCol[x]) * invBand;
            if (ty < 0) ty = 0; else if (ty > 1) ty = 1;
            mv = tx * tx * (3 - 2 * tx) * ty * ty * (3 - 2 * ty);
          }
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

    var turns = Math.round(this.o.revolve || 0);
    var inset = Math.max(0, Math.min(0.45, this.o.inset || 0));

    // Reserving a margin in the mask alone would just clip the composition at
    // the new boundary. Shrinking the field by the same fraction makes it fit
    // inside the margin instead. Sampling a wider area makes features smaller,
    // hence the reciprocal — and because rotation and uniform scale about the
    // same centre commute, the factor folds straight into the rotation matrix
    // and costs nothing extra per cell.
    var shrink = 1 - 2 * inset;
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

    if (turns || inset > 0 || e !== 0) {
      var ang = TAU * turns * phase;
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
        var dy = ny - 0.5;
        for (x = 0; x < gw; x++) {
          var dx = (x * invW - 0.5) * asp;
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
    return this;
  };

  /* -------------------------------------------------------------- exports */

  return {
    create: function (opts) { return new BitMotionInstance(opts); },
    RAMPS: RAMPS,
    SCENES: SCENE_NAMES,
    COLORS: HS,
    hexToRgb: hexToRgb
  };
});
