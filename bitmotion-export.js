/*!
 * BitMotion export — turns a loop into an animated GIF, a video, or a PNG
 * frame sequence. Dependency-free.
 *
 * Loop mode renders each frame as a pure function of phase, so exports are
 * deterministic: frame i is rendered at phase i/N and frame N would equal
 * frame 0, which is what makes the exported loop close exactly.
 *
 *   var blob = await BitMotionExport.gif({ options: bm.o, seed: bm.rndSeed,
 *                                          width: 1920, seconds: 12, fps: 20 });
 *   await BitMotionExport.save("loop.gif", blob);
 *
 * The GIF path is adapted from Help Scout Bitmaker's own gifExport.js so the
 * two produce byte-compatible files, with two changes: the LZW dictionary is
 * keyed by integer instead of by string (the string version is far too slow at
 * full frame resolution), and frames are written to a streaming sink one at a
 * time instead of being buffered as whole expanded grids.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BitMotionExport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------ byte sink */

  // Collects bytes into 64KB chunks. A multi-megabyte GIF built by pushing
  // onto a plain JS array costs ~8 bytes per byte; chunked Uint8Arrays hand
  // straight to a Blob with no final concatenation.
  function ByteSink() {
    this.chunks = [];
    this.buf = new Uint8Array(65536);
    this.pos = 0;
  }
  ByteSink.prototype._room = function (n) {
    if (this.pos + n <= this.buf.length) return;
    this.chunks.push(this.buf.subarray(0, this.pos));
    this.buf = new Uint8Array(Math.max(65536, n));
    this.pos = 0;
  };
  ByteSink.prototype.u8 = function (v) {
    this._room(1);
    this.buf[this.pos++] = v & 0xff;
  };
  ByteSink.prototype.u16 = function (v) {
    this._room(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >> 8) & 0xff;
  };
  ByteSink.prototype.raw = function (arr, len) {
    len = len === undefined ? arr.length : len;
    this._room(len);
    this.buf.set(arr.subarray ? arr.subarray(0, len) : arr.slice(0, len), this.pos);
    this.pos += len;
  };
  ByteSink.prototype.str = function (s) {
    this._room(s.length);
    for (var i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i) & 0xff;
  };
  ByteSink.prototype.blob = function (type) {
    var all = this.chunks.slice();
    if (this.pos) all.push(this.buf.subarray(0, this.pos));
    return new Blob(all, { type: type });
  };

  /* ------------------------------------------------------------ GIF / LZW */

  function BitWriter(hint) {
    this.out = new Uint8Array(Math.max(1024, hint | 0));
    this.len = 0;
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
  BitWriter.prototype._push = function (b) {
    if (this.len === this.out.length) {
      var bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.len++] = b;
  };
  BitWriter.prototype.writeCode = function (code, size) {
    this.bitBuffer |= (code << this.bitCount);
    this.bitCount += size;
    while (this.bitCount >= 8) {
      this._push(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
    }
  };
  BitWriter.prototype.finish = function () {
    if (this.bitCount > 0) {
      this._push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
    return this.out.subarray(0, this.len);
  };

  // Standard GIF LZW. The code-size bump is deliberately delayed by one
  // emission: a decoder cannot complete a new dictionary entry until it has
  // read the *following* code, so its own codeSize growth lags the encoder's
  // bookkeeping by exactly one code. This mirrors Bitmaker's implementation,
  // which was verified against independent GIF decoders — don't "simplify" it.
  //
  // The dictionary is an Int32Array keyed by (prefixCode << minCodeSize) | symbol.
  // 0 is a safe empty sentinel because assigned codes always start above eoiCode.
  function lzwEncode(minCodeSize, indices) {
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var dict = new Int32Array(4096 * clearCode);
    var writer = new BitWriter(indices.length >> 1);

    var codeSize, nextCode;
    function reset() {
      dict.fill(0);
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    }
    reset();
    writer.writeCode(clearCode, codeSize);

    if (indices.length === 0) {
      writer.writeCode(eoiCode, codeSize);
      return writer.finish();
    }

    var wCode = indices[0]; // a lone symbol's code is the symbol itself
    var emissionCount = 0;
    var pendingBumpAt = -1;

    for (var i = 1; i < indices.length; i++) {
      var k = indices[i];
      var key = (wCode << minCodeSize) | k;
      var found = dict[key];
      if (found !== 0) {
        wCode = found;
        continue;
      }

      writer.writeCode(wCode, codeSize);
      emissionCount++;

      var assignedCode = nextCode;
      dict[key] = assignedCode;
      nextCode++;

      if (assignedCode === (1 << codeSize) - 1) pendingBumpAt = emissionCount + 1;
      if (pendingBumpAt !== -1 && emissionCount >= pendingBumpAt) {
        pendingBumpAt = -1;
        if (codeSize < 12) {
          codeSize++;
        } else {
          writer.writeCode(clearCode, codeSize);
          reset();
        }
      }
      wCode = k;
    }

    writer.writeCode(wCode, codeSize);
    writer.writeCode(eoiCode, codeSize);
    return writer.finish();
  }

  function writeSubBlocks(sink, bytes) {
    var i = 0;
    while (i < bytes.length) {
      var n = Math.min(255, bytes.length - i);
      sink.u8(n);
      sink.raw(bytes.subarray(i, i + n));
      i += n;
    }
    sink.u8(0);
  }

  // Streaming GIF89a writer: header up front, then one frame at a time.
  function GifWriter(width, height, palette, delayCs, transparentIndex) {
    var numColors = Math.max(2, palette.length);
    var bitsPerPixel = Math.max(1, Math.ceil(Math.log2(numColors)));
    var tableSizeExp = bitsPerPixel - 1;
    var tableEntries = 1 << (tableSizeExp + 1);

    this.w = width;
    this.h = height;
    this.delayCs = delayCs;
    this.transparentIndex = transparentIndex == null ? -1 : transparentIndex;
    this.minCodeSize = Math.max(bitsPerPixel, 2);
    this.frames = 0;
    this.sink = new ByteSink();

    var s = this.sink;
    s.str("GIF89a");
    s.u16(width);
    s.u16(height);
    s.u8(0x80 | (tableSizeExp << 4) | tableSizeExp);
    s.u8(this.transparentIndex >= 0 ? this.transparentIndex : 0); // background index
    s.u8(0); // pixel aspect ratio
    for (var i = 0; i < tableEntries; i++) {
      var c = palette[i] || { r: 0, g: 0, b: 0 };
      s.u8(c.r); s.u8(c.g); s.u8(c.b);
    }

    // Netscape extension: loop forever.
    s.u8(0x21); s.u8(0xff); s.u8(0x0b);
    s.str("NETSCAPE2.0");
    s.u8(0x03); s.u8(0x01); s.u8(0x00); s.u8(0x00); s.u8(0x00);
  }

  GifWriter.prototype.addFrame = function (indices) {
    var s = this.sink;
    var hasAlpha = this.transparentIndex >= 0;

    // Graphic Control Extension. The packed byte is bit 0 = transparency
    // flag, bits 2-4 = disposal method. Disposal 2 (restore to background)
    // matters when frames carry transparency: without it a transparent cell
    // shows the previous frame through instead of the page, and the animation
    // smears into a palimpsest of every frame before it.
    s.u8(0x21); s.u8(0xf9); s.u8(0x04);
    s.u8(hasAlpha ? (0x01 | (2 << 2)) : 0x00);
    s.u16(this.delayCs);
    s.u8(hasAlpha ? this.transparentIndex : 0);
    s.u8(0x00);

    s.u8(0x2c);
    s.u16(0); s.u16(0);
    s.u16(this.w); s.u16(this.h);
    s.u8(0x00);

    s.u8(this.minCodeSize);
    writeSubBlocks(s, lzwEncode(this.minCodeSize, indices));
    this.frames++;
  };

  GifWriter.prototype.finish = function () {
    this.sink.u8(0x3b);
    return this.sink.blob("image/gif");
  };

  /* --------------------------------------------------------- frame source */

  // Nearest-neighbour expansion of the cell grid to full pixel resolution,
  // matching how the engine blits to screen so the export is pixel-identical.
  // `cell` is an exact integer, so this is a straight block fill.
  function expandIndices(src, gw, gh, cell, dst) {
    var outW = gw * cell;
    for (var y = 0; y < gh; y++) {
      var rowStart = y * cell * outW;
      // Build one expanded row, then copy it for the remaining cell-1 rows.
      for (var x = 0; x < gw; x++) {
        var v = src[y * gw + x];
        var base = rowStart + x * cell;
        for (var i = 0; i < cell; i++) dst[base + i] = v;
      }
      var row = dst.subarray(rowStart, rowStart + outW);
      for (var r = 1; r < cell; r++) dst.set(row, rowStart + r * outW);
    }
    return dst;
  }

  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

  // Cells must be whole pixels to stay crisp, so the output is only exactly
  // the requested size when the cell size divides both dimensions. Nudging
  // the cell to the nearest common divisor buys exact 1920×1080 (or 1080×1920)
  // for a cell or two of difference nobody can see. If nothing suitable is
  // near the request, keep the requested cell — `plan()` reports the real
  // dimensions either way rather than pretending.
  function snapCell(desired, w, h) {
    var g = gcd(w, h);
    if (g < 2) return desired;
    var best = desired, bestDist = Infinity;
    for (var d = 1; d <= g; d++) {
      if (g % d !== 0) continue;
      var dist = Math.abs(d - desired);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    return bestDist <= Math.max(1, desired * 0.4) ? best : desired;
  }

  // Builds an offscreen engine locked to the exact output size and to loop
  // mode, seeded identically to the live instance so the export is the loop
  // the user is actually watching.
  function makeRenderer(opts) {
    // A <script> tag leaves BitMotion on the global; a bundled import does
    // not, so `options.BitMotion` is how an import hands the engine over.
    var engine = opts.BitMotion ||
      (typeof BitMotion !== "undefined" ? BitMotion : null) ||
      (typeof self !== "undefined" ? self.BitMotion : null);
    if (!engine) throw new Error("BitMotionExport: load bitmotion.js first, or pass it as the `BitMotion` option");

    var base = opts.options || {};
    var conf = {};
    for (var k in base) {
      if (k === "canvas" || k === "size" || k === "grid" || k === "cellSize" || k === "maxDpr") continue;
      conf[k] = base[k];
    }

    var canvas = document.createElement("canvas");
    conf.canvas = canvas;
    conf.mode = "loop";
    conf.loopSeconds = opts.seconds;
    conf.autoplay = false;
    conf.respectReducedMotion = false;
    conf.fps = 0;
    if (opts.resolution) conf.resolution = opts.resolution;
    if (opts.seed != null) conf.seed = opts.seed;
    if (opts.transparent !== undefined) conf.transparent = opts.transparent;

    // Derive the cell size from the requested resolution, then take the grid
    // straight from the target dimensions. Going in this order means the
    // output is exactly the requested size whenever the cell size divides it
    // — which is why the size presets pair with cell-friendly resolutions.
    var targetW = opts.width;
    var targetH = opts.height || Math.round(targetW * 9 / 16);

    // `cellSize` is the direct control: a block is exactly that many pixels
    // in the exported frame, so 2 really means 2×2. Falling back to
    // `resolution` keeps the older call style working.
    var cell;
    if (opts.cellSize > 0) {
      cell = Math.max(1, Math.round(opts.cellSize));
    } else {
      var res = Math.max(8, Math.round(conf.resolution));
      cell = snapCell(Math.max(1, Math.round(targetW / res)), targetW, targetH);
    }
    var gw = Math.max(1, Math.round(targetW / cell));
    var gh = Math.max(1, Math.round(targetH / cell));

    conf.grid = { w: gw, h: gh };
    conf.size = { w: gw * cell, h: gh * cell };
    conf.maxCell = cell;

    var bm = engine.create(conf);
    return { bm: bm, canvas: canvas, cell: bm.cell, outW: bm.canvas.width, outH: bm.canvas.height };
  }

  // What an export will actually produce, without doing the work — so the UI
  // can show true dimensions rather than the requested ones.
  function plan(opts) {
    // Only the geometry is wanted here, so switch auto-levels off: that skips
    // _calibrate's 24 full-grid passes, which is pure waste when the caller is
    // a UI refresh and not a render.
    var lite = {};
    for (var k in opts) lite[k] = opts[k];
    var baseOpts = {};
    for (var j in (opts.options || {})) baseOpts[j] = opts.options[j];
    baseOpts.levels = false;
    lite.options = baseOpts;

    var r = makeRenderer(lite);
    var out = {
      width: r.outW,
      height: r.outH,
      grid: r.bm.gw + "×" + r.bm.gh,
      gridW: r.bm.gw,
      gridH: r.bm.gh,
      cell: r.cell,
      frames: Math.max(1, Math.round(opts.seconds * opts.fps)),
      colors: r.bm.palette.length
    };
    r.bm.destroy();
    return out;
  }

  function nextTick() {
    return new Promise(function (res) { setTimeout(res, 0); });
  }

  /* ------------------------------------------------------------ GIF export */

  async function gif(opts) {
    var onProgress = opts.onProgress || function () {};
    var r = makeRenderer(opts);
    var bm = r.bm;
    var frames = Math.max(1, Math.round(opts.seconds * opts.fps));
    var delayCs = Math.max(2, Math.round(100 / opts.fps));

    // GIF transparency is a single fully-transparent palette index, and this
    // art's alpha is already binary (a cell is paper or it is not), so it maps
    // exactly with no loss.
    var transparent = opts.transparent !== false && bm.bgIndex >= 0;
    var writer = new GifWriter(r.outW, r.outH, bm.palette, delayCs,
                               transparent ? bm.bgIndex : -1);

    var expanded = new Uint8Array(r.outW * r.outH);

    for (var i = 0; i < frames; i++) {
      bm._render(i / frames * opts.seconds);
      expandIndices(bm.indices, bm.gw, bm.gh, r.cell, expanded);
      writer.addFrame(expanded);
      onProgress((i + 1) / frames, i + 1, frames);
      if (i % 3 === 2) await nextTick(); // keep the page responsive
    }

    bm.destroy();
    return writer.finish();
  }

  /* ---------------------------------------------------------- video export */

  // MediaRecorder timestamps frames by wall clock, so a deterministic capture
  // has to be paced in real time — a video export takes about as long as the
  // loop itself. captureStream(0) plus requestFrame() means we still control
  // exactly which frames land, rather than sampling whatever is on screen.
  // Codec choice dominates quality here, and by a wide margin — this content
  // is the worst case for a video codec: hard-edged blocks, flat saturated
  // fields, and a fifth of the cells changing every frame.
  //
  // Measured against the engine's own render of the same frame (960x540,
  // worst-channel error per pixel):
  //
  //   H.264 High @40Mbps   mean 3.15   4.5% of pixels off by >16, worst 99
  //   VP9         @20Mbps  mean 1.55   0%  of pixels off by >16, worst 19
  //
  // Both encoders self-limit well below the requested bitrate, so raising it
  // does almost nothing — H.264's ceiling is structural, not budgetary. VP9
  // is the crisp option; H.264 exists only for tools that demand .mp4.
  //
  // Nothing here is lossless: every one of these codecs subsamples chroma,
  // which is what rounds off the edges of saturated colour blocks. For an
  // exact result use the GIF (indexed, lossless) or the PNG sequence.
  var VIDEO_CRISP = [
    { mime: "video/webm;codecs=vp9", ext: "webm", label: "WebM / VP9" },
    { mime: "video/webm;codecs=vp8", ext: "webm", label: "WebM / VP8" },
    { mime: "video/webm", ext: "webm", label: "WebM" }
  ];
  var VIDEO_COMPATIBLE = [
    // High profile, level 4.0. The old default asked for avc1.42E01E —
    // Baseline level 3.0, which is specified for 720x576 and lacks CABAC.
    { mime: "video/mp4;codecs=avc1.640028", ext: "mp4", label: "MP4 / H.264 High" },
    { mime: "video/mp4;codecs=avc1.4D0028", ext: "mp4", label: "MP4 / H.264 Main" },
    { mime: "video/mp4", ext: "mp4", label: "MP4" }
  ];

  function pickVideoType(pref) {
    if (typeof MediaRecorder === "undefined") return null;
    var lists = pref === "compatible"
      ? [VIDEO_COMPATIBLE, VIDEO_CRISP]
      : [VIDEO_CRISP, VIDEO_COMPATIBLE];
    for (var l = 0; l < lists.length; l++) {
      for (var i = 0; i < lists[l].length; i++) {
        if (MediaRecorder.isTypeSupported(lists[l][i].mime)) return lists[l][i];
      }
    }
    return null;
  }

  function video(opts) {
    var type = pickVideoType(opts.codec);
    if (!type) return Promise.reject(new Error("MediaRecorder is not available in this browser"));

    var onProgress = opts.onProgress || function () {};
    // Video codecs here carry no alpha channel, so the frame must be
    // composited onto the paper colour rather than left transparent.
    var r = makeRenderer(Object.assign({}, opts, { transparent: false }));
    var bm = r.bm;
    var frames = Math.max(1, Math.round(opts.seconds * opts.fps));
    var interval = 1000 / opts.fps;

    var stream = bm.canvas.captureStream(0);
    var track = stream.getVideoTracks()[0];
    var pixels = r.outW * r.outH;
    // Asked for generously on purpose: both encoders settle well below this,
    // so a high ceiling costs nothing in file size and removes any chance of
    // the bitrate — rather than the codec — being what limits quality.
    var recorder = new MediaRecorder(stream, {
      mimeType: type.mime,
      videoBitsPerSecond: Math.min(120e6, Math.max(16e6, Math.round(pixels * opts.fps * 2)))
    });

    var parts = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };

    return new Promise(function (resolve, reject) {
      recorder.onerror = function (e) { reject(e.error || new Error("recording failed")); };
      recorder.onstop = function () {
        bm.destroy();
        track.stop();
        resolve({ blob: new Blob(parts, { type: type.mime }), ext: type.ext, mime: type.mime });
      };

      recorder.start();

      var i = 0;
      var startedAt = performance.now();
      function step() {
        if (i >= frames) {
          // Let the encoder drain the final frame before closing the stream.
          setTimeout(function () { recorder.stop(); }, Math.max(120, interval * 2));
          return;
        }
        bm._render(i / frames * opts.seconds);
        if (track.requestFrame) track.requestFrame();
        else if (stream.requestFrame) stream.requestFrame();
        i++;
        onProgress(i / frames, i, frames);
        var due = startedAt + i * interval;
        setTimeout(step, Math.max(0, due - performance.now()));
      }
      step();
    });
  }

  /* ------------------------------------------------- PNG sequence (as zip) */

  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function canvasToPngBytes(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error("toBlob failed"));
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, "image/png");
    });
  }

  // Minimal ZIP (STORE only — PNG is already deflated, so re-compressing it
  // would cost time for nothing). Alpha survives, which is why this is the
  // format to hand an editor when the artwork has to sit on paper.
  async function pngSequence(opts) {
    var onProgress = opts.onProgress || function () {};
    var r = makeRenderer(opts);
    var bm = r.bm;
    var frames = Math.max(1, Math.round(opts.seconds * opts.fps));
    var prefix = opts.prefix || "bitmotion";

    var sink = new ByteSink();
    var entries = [];
    var offset = 0;

    function u32(s, v) { s.u8(v & 0xff); s.u8((v >>> 8) & 0xff); s.u8((v >>> 16) & 0xff); s.u8((v >>> 24) & 0xff); }

    for (var i = 0; i < frames; i++) {
      bm._render(i / frames * opts.seconds);
      var png = await canvasToPngBytes(bm.canvas);
      var name = prefix + "_" + String(i).padStart(4, "0") + ".png";
      var nameBytes = new Uint8Array(name.length);
      for (var c = 0; c < name.length; c++) nameBytes[c] = name.charCodeAt(c) & 0xff;
      var crc = crc32(png);

      entries.push({ name: nameBytes, crc: crc, size: png.length, offset: offset });

      u32(sink, 0x04034b50);
      sink.u16(20); sink.u16(0); sink.u16(0);  // version, flags, method=STORE
      sink.u16(0); sink.u16(0);                // time, date
      u32(sink, crc);
      u32(sink, png.length);
      u32(sink, png.length);
      sink.u16(nameBytes.length); sink.u16(0);
      sink.raw(nameBytes);
      sink.raw(png);
      offset += 30 + nameBytes.length + png.length;

      onProgress((i + 1) / frames, i + 1, frames);
      await nextTick();
    }

    var dirStart = offset;
    var dirSize = 0;
    entries.forEach(function (e) {
      u32(sink, 0x02014b50);
      sink.u16(20); sink.u16(20); sink.u16(0); sink.u16(0);
      sink.u16(0); sink.u16(0);
      u32(sink, e.crc);
      u32(sink, e.size);
      u32(sink, e.size);
      sink.u16(e.name.length);
      sink.u16(0); sink.u16(0); sink.u16(0); sink.u16(0);
      u32(sink, 0);
      u32(sink, e.offset);
      sink.raw(e.name);
      dirSize += 46 + e.name.length;
    });

    u32(sink, 0x06054b50);
    sink.u16(0); sink.u16(0);
    sink.u16(entries.length); sink.u16(entries.length);
    u32(sink, dirSize);
    u32(sink, dirStart);
    sink.u16(0);

    bm.destroy();
    return sink.blob("application/zip");
  }

  /* ------------------------------------------------------------ delivering */

  // Inside a published artifact the viewer sandbox blocks a page from starting
  // its own download, so the `downloads` capability is the only route there.
  // Served as a plain file it is the reverse. Try the capability, fall back.
  async function save(filename, blob) {
    if (typeof window !== "undefined" && window.claude && window.claude.use) {
      try {
        var downloads = await window.claude.use("downloads");
        if (downloads) {
          await downloads.save({ filename: filename, data: blob });
          return "saved";
        }
      } catch (err) {
        if (err && err.code === "declined") return "declined";
        // Any other capability failure falls through to the anchor route.
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    return "saved";
  }

  return {
    gif: gif,
    video: video,
    pngSequence: pngSequence,
    plan: plan,
    save: save,
    videoFormat: function (pref) { var t = pickVideoType(pref); return t ? t.ext : null; },
    videoLabel: function (pref) { var t = pickVideoType(pref); return t ? t.label : null; }
  };
});
