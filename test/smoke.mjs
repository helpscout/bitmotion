/**
 * Headless smoke test — `npm test`.
 *
 * BitMotion is browser-only, so the test stands up the smallest DOM the engine
 * actually touches (a canvas, a 2D context, a few window globals) and drives
 * the real code against it. That is enough to cover the mount layer end to
 * end: attribute parsing, precedence, containers, idempotency and teardown.
 * It is not a pixel test — the rendering itself is checked by eye in the
 * playground.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------- fake DOM */

const ctx = {
  fillStyle: "",
  imageSmoothingEnabled: true,
  clearRect() {},
  fillRect() {},
  drawImage() {},
  putImageData() {},
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
};

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs));
    this.style = {};
    this.children = [];
    this.ownerDocument = null;
  }
  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  hasAttribute(n) { return this._attrs.has(n); }
  appendChild(child) { child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
  getBoundingClientRect() { return { width: 320, height: 180 }; }
  getContext() { return ctx; }
}

const page = [];
const document = {
  readyState: "complete",
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    const el = new FakeElement(tag);
    el.ownerDocument = document;
    return el;
  },
  // Only one selector is ever asked for here, so matching is by attribute.
  querySelectorAll(selector) {
    assert.equal(selector, "[data-bitmotion]", "unexpected selector: " + selector);
    return page.filter((el) => el.hasAttribute("data-bitmotion"));
  }
};

function element(tag, attrs) {
  const el = new FakeElement(tag, attrs);
  el.ownerDocument = document;
  page.push(el);
  return el;
}

// The canvas the engine auto-mounts on import, so the DOM-ready path is
// covered too rather than only explicit init() calls.
const auto = element("canvas", {
  "data-bitmotion": "",
  "data-bitmotion-scene": "waves",
  "data-bitmotion-cell-size": "4",
  "data-bitmotion-seed": "42",
  "data-bitmotion-autoplay": "false"
});

globalThis.document = document;
globalThis.window = {
  document,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

/* ------------------------------------------------------------ the tests */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

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

/* ---------------------------------------------------------------- runner */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL " + name + "\n       " + (err && err.message));
  }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\n${tests.length} passed`);
process.exit(failed ? 1 : 0);
