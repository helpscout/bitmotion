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
