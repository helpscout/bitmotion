/**
 * Headless smoke test for the engine — `npm test`.
 *
 * It drives the real code against the small DOM in dom.mjs. That covers the
 * mount layer end to end: attribute parsing, precedence, containers,
 * idempotency and teardown. It is not a pixel test — the rendering itself is
 * checked by eye in the playground.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { document, element, test, run } from "./dom.mjs";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The canvas the engine auto-mounts on import, so the DOM-ready path is
// covered too rather than only explicit init() calls.
const auto = element("canvas", {
  "data-bitmotion": "",
  "data-bitmotion-scene": "waves",
  "data-bitmotion-cell-size": "4",
  "data-bitmotion-seed": "42",
  "data-bitmotion-autoplay": "false"
});

/* ------------------------------------------------------------ the tests */

const BitMotion = require(path.join(root, "bitmotion.js"));

test("exports the documented surface", () => {
  for (const key of ["create", "init", "get", "destroyAll", "RAMPS", "BACKGROUNDS", "ORIGINS", "SCENES", "COLORS", "hexToRgb"]) {
    assert.ok(key in BitMotion, "missing export: " + key);
  }
  assert.deepEqual(BitMotion.SCENES, ["drift", "waves", "bloom", "ribbon", "nebula"]);
});

test("mounts [data-bitmotion] elements on load", () => {
  const instance = BitMotion.get(auto);
  assert.ok(instance, "the canvas in the markup was never mounted");
  assert.equal(instance.canvas, auto);
  assert.equal(instance.o.scene, "waves");
  assert.equal(instance.o.cellSize, 4, "a numeric attribute should arrive as a number");
  assert.equal(instance.o.autoplay, false, "\"false\" should arrive as a boolean");
  assert.equal(instance.rndSeed, 42);
  assert.equal(instance.running, false);
});

test("attributes beat the JSON blob, and overrides beat both", () => {
  const el = element("canvas", {
    "data-bitmotion": '{"scene":"bloom","blobs":3,"autoplay":false}',
    "data-bitmotion-blobs": "7"
  });
  const [instance] = BitMotion.init(el, { seed: 99 });
  assert.equal(instance.o.scene, "bloom");
  assert.equal(instance.o.blobs, 7);
  assert.equal(instance.rndSeed, 99);
});

test("a non-canvas element gets a canvas of its own", () => {
  const el = element("div", { "data-bitmotion": '{"autoplay":false}' });
  const [instance] = BitMotion.init(el);
  assert.equal(el.children.length, 1);
  assert.equal(instance.canvas, el.children[0]);
  assert.equal(instance.canvas.style.width, "100%");

  // Mounting again must reuse the element and its canvas, not stack a second.
  const again = BitMotion.init(el);
  assert.equal(again[0], instance);
  assert.equal(el.children.length, 1);
});

test("malformed JSON falls back to defaults instead of throwing", () => {
  const el = element("canvas", { "data-bitmotion": "{not json", "data-bitmotion-autoplay": "false" });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args[0]);
  try {
    const [instance] = BitMotion.init(el);
    assert.ok(instance, "a typo in the markup should not stop the mount");
    assert.equal(instance.o.scene, "drift");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("destroy releases the element for a later mount", () => {
  const el = element("canvas", { "data-bitmotion": '{"autoplay":false}' });
  const [first] = BitMotion.init(el);
  first.destroy();
  assert.equal(BitMotion.get(el), null);
  const [second] = BitMotion.init(el);
  assert.notEqual(second, first);
  second.destroy();
});

test("play, seek and pause drive the render loop", () => {
  const el = element("canvas", { "data-bitmotion": '{"autoplay":false}' });
  const [instance] = BitMotion.init(el);
  instance.play();
  assert.equal(instance.running, true);
  instance.seek(3);
  assert.equal(instance.elapsed, 3);
  instance.pause();
  assert.equal(instance.running, false);
  assert.ok(instance.canvas.width > 0 && instance.canvas.height > 0);
});

// Drives the loop with a synthetic display clock and counts what it draws.
function measureCadence(options, refreshHz, seconds) {
  const el = element("canvas", {});
  const realRaf = globalThis.requestAnimationFrame;
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  try {
    const instance = BitMotion.create(Object.assign({ canvas: el, autoplay: false }, options));
    let drawn = 0;
    const render = instance._render.bind(instance);
    instance._render = (t) => { drawn++; return render(t); };

    instance.play();
    drawn = 0; // play() paints one frame up front; count the loop only
    const step = 1000 / refreshHz;
    // The loop times its first frame against performance.now(), so the
    // synthetic clock has to start from there rather than from zero.
    let now = performance.now();
    for (let i = 0; i < refreshHz * seconds; i++) {
      now += step + (Math.random() - 0.5) * 0.8; // a real display is not exact
      pending(now);
    }
    instance.destroy();
    return drawn / seconds;
  } finally {
    globalThis.requestAnimationFrame = realRaf;
  }
}

test("the frame cap delivers the rate it was asked for", () => {
  // The gate used to compare against exactly 1/fps and reset its phase on
  // every draw, so a 30fps cap came out at 24fps in an uneven 2, 3, 2, 3
  // pattern. Both the rate and the evenness matter: the drawn frame is the
  // expensive one, so an irregular cadence is what the rest of the page feels.
  for (const [refresh, fps] of [[60, 30], [60, 20], [120, 30], [120, 24]]) {
    const measured = measureCadence({ fps: fps, size: { w: 320, h: 180 }, cellSize: 8 }, refresh, 4);
    assert.ok(
      Math.abs(measured - fps) <= 1,
      `${refresh}Hz at fps ${fps}: drew ${measured.toFixed(1)} frames a second`
    );
  }
});

test("an uncapped instance draws on every display frame", () => {
  const measured = measureCadence({ fps: 0, size: { w: 320, h: 180 }, cellSize: 8 }, 60, 2);
  assert.ok(measured > 59, "drew " + measured.toFixed(1) + " frames a second");
});

test("onFirstFrame fires once, with artwork already on the canvas", () => {
  const el = element("canvas", {});
  const seen = [];
  const instance = BitMotion.create({
    canvas: el, autoplay: false, cellSize: 8,
    onFirstFrame: (bm) => seen.push([bm, el.ctx.calls.drawImage])
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], instance, "it hands over the instance the caller does not have yet");
  assert.ok(seen[0][1] >= 1, "a frame should already have been drawn");

  instance.seek(2);
  assert.equal(seen.length, 1, "later frames are not first frames");
  instance.destroy();
});

test("upscale css draws the grid straight into a grid-sized canvas", () => {
  const el = element("canvas", {});
  const instance = BitMotion.create({ canvas: el, autoplay: false, cellSize: 4, upscale: "css" });
  assert.equal(el.width, instance.gw, "the backing store should be the grid itself");
  assert.equal(el.height, instance.gh);

  el.ctx.calls.putImageData = 0;
  instance.seek(1);
  assert.equal(el.ctx.calls.putImageData, 1, "the frame goes straight into the visible canvas");
  assert.equal(el.ctx.calls.drawImage, 0, "nothing to scale up any more");
  assert.equal(el.ctx.calls.clearRect, 0, "putImageData replaces the alpha, so no clear is needed");
  instance.destroy();
});

test("upscale canvas keeps the full-resolution backing store", () => {
  const el = element("canvas", {});
  const instance = BitMotion.create({ canvas: el, autoplay: false, cellSize: 4 });
  assert.equal(el.width, instance.gw * instance.cell);
  assert.equal(el.height, instance.gh * instance.cell);

  el.ctx.calls.drawImage = 0;
  instance.seek(1);
  assert.equal(el.ctx.calls.drawImage, 1, "the grid is scaled into the canvas every frame");
  instance.destroy();
});

test("switching upscale in place resizes the canvas", () => {
  const el = element("canvas", {});
  const instance = BitMotion.create({ canvas: el, autoplay: false, cellSize: 4 });
  const full = el.width;
  instance.setOption("upscale", "css");
  assert.equal(el.width, instance.gw);
  instance.setOption("upscale", "canvas");
  assert.equal(el.width, full);
  instance.destroy();
});

test("the export module asks for an engine rather than assuming a global", () => {
  const BitMotionExport = require(path.join(root, "bitmotion-export.js"));
  for (const key of ["gif", "video", "pngSequence", "plan", "save"]) {
    assert.equal(typeof BitMotionExport[key], "function", "missing export: " + key);
  }
  assert.throws(
    () => BitMotionExport.plan({ options: {}, width: 640, seconds: 4, fps: 20 }),
    /load bitmotion\.js first/
  );
  // `options` is normally an instance's own `o`, which carries every default.
  const source = BitMotion.create({ canvas: document.createElement("canvas"), autoplay: false });
  const summary = BitMotionExport.plan({
    BitMotion, options: source.o, cellSize: 2, width: 640, height: 360, seconds: 4, fps: 20
  });
  source.destroy();
  assert.equal(summary.width, 640);
  assert.equal(summary.frames, 80);
});

test("every file the package ships is present", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "@helpscout/bitmotion");
  const targets = new Set([...pkg.files, pkg.main, pkg.types, pkg.unpkg, pkg.jsdelivr]);
  for (const entry of Object.values(pkg.exports)) {
    if (typeof entry === "string") targets.add(entry);
    else Object.values(entry).forEach((t) => targets.add(t));
  }
  for (const target of targets) {
    assert.ok(existsSync(path.join(root, target)), "package.json points at a missing file: " + target);
  }
});

run("engine");
