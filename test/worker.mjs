/**
 * Tests for the offscreen path.
 *
 * There is no Worker and no OffscreenCanvas in Node, so this file builds both:
 * the "worker" is a fresh `node:vm` context with a worker's globals and none
 * of a page's, and the script it runs is the one the engine generates for a
 * real browser — stringified factory and all. So the protocol, the boot code
 * and the engine's ability to run without a DOM are all genuinely executed;
 * only the thread boundary is simulated.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FakeElement, document, element, test, run } from "./dom.mjs";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BitMotion = require(path.join(root, "bitmotion.js"));

/* ------------------------------------------------- a worker global scope */

class OffscreenCanvas extends FakeElement {
  constructor(width = 1, height = 1) {
    super("canvas");
    this.width = width;
    this.height = height;
    delete this.style;                  // an OffscreenCanvas has none
    delete this.getBoundingClientRect;  // and cannot be measured
  }
}

// Runs the worker script in a context with a worker's globals: no window, no
// document, no requestAnimationFrame. Timers are captured rather than fired,
// so the render loop advances only when a test says so.
function spawnWorker(source) {
  const timers = [];
  const outbox = [];
  // The worker's clock only moves when a scheduled frame is fired, so the
  // loop sees exactly the interval it asked for.
  let clock = 1000;
  const self = {
    postMessage: (msg) => outbox.push(msg),
    close: () => { self.closed = true; },
    closed: false
  };
  const context = vm.createContext({
    self,
    OffscreenCanvas,
    console,
    performance: { now: () => clock },
    setTimeout: (fn, delay) => { timers.push({ fn, delay: delay || 0 }); return timers.length; },
    clearTimeout: () => {}
  });
  vm.runInContext(source, context);
  return {
    self,
    outbox,
    deliver: (msg) => self.onmessage({ data: msg }),
    tick: () => {
      const due = timers.splice(0);
      for (const timer of due) { clock += timer.delay; timer.fn(); }
      return due.length;
    }
  };
}

/* ------------------------------------------ the page side of the bridge */

// Installs Worker/URL stubs that run the real generated script in `spawnWorker`
// and wire the two postMessage channels together. Returns what was built, so a
// test can drive the worker directly.
// The engine builds its blob URL once per page and reuses it, so the script
// is captured here rather than per test.
let capturedSource = null;

function withFakeWorker(fn, { failToStart = false } = {}) {
  const real = { Worker: globalThis.Worker, Blob: globalThis.Blob, createObjectURL: globalThis.URL.createObjectURL };
  const built = { bridge: null, worker: null, terminated: 0 };

  // Capturing the script out of the Blob keeps everything synchronous, which
  // keeps the message ordering in the tests plain to read.
  globalThis.Blob = class { constructor(parts) { capturedSource = parts.join(""); } };
  globalThis.URL.createObjectURL = () => "blob:bitmotion-test";
  globalThis.Worker = class {
    constructor(url) {
      if (failToStart) throw new Error("Refused to create a worker from 'blob:' (CSP)");
      built.url = url;
      built.worker = this;
      built.bridge = spawnWorker(capturedSource);
      this.onmessage = null;
    }
    postMessage(msg) {
      built.bridge.deliver(msg);
      // A real worker answers asynchronously; delivering inline keeps the
      // ordering explicit, and nothing in the protocol waits on a reply.
      for (const out of built.bridge.outbox.splice(0)) {
        if (this.onmessage) this.onmessage({ data: out });
      }
    }
    terminate() { built.terminated++; }
  };

  try {
    return fn(built);
  } finally {
    globalThis.Worker = real.Worker;
    globalThis.Blob = real.Blob;
    globalThis.URL.createObjectURL = real.createObjectURL;
  }
}

// A canvas that can hand its pixels to a worker, as a real one can.
function transferableCanvas() {
  const el = new FakeElement("canvas");
  el.ownerDocument = document;
  el.getBoundingClientRect = () => ({ width: 600, height: 300 });
  el.transferControlToOffscreen = () => {
    if (el.transferred) throw new Error("already transferred");
    el.transferred = new OffscreenCanvas(1, 1);
    return el.transferred;
  };
  return el;
}

/* ------------------------------------------------------------------ tests */

test("the generated script boots the engine with no DOM at all", () => {
  withFakeWorker((built) => {
    const canvas = transferableCanvas();
    const instance = BitMotion.create({ canvas, worker: true, autoplay: false, seed: 99, cellSize: 4 });

    assert.equal(instance.usesWorker, true);
    assert.equal(instance.rndSeed, 99, "the page picks the seed so it can report it at once");
    assert.equal(canvas.style.imageRendering, "pixelated");
    assert.ok(capturedSource.includes("bitmotionFactory"), "the script should carry the engine");
    assert.ok(capturedSource.includes("startWorker"), "and boot it");

    // 600x300 CSS at dpr 1, blocks of 4: the worker measured nothing, it was
    // told, and it came to the same grid the page would have.
    assert.equal(instance.gw, 150);
    assert.equal(instance.gh, 75);
    assert.equal(instance.cell, 4);
    instance.destroy();
  });
});

test("the worker paints the canvas the page handed over", () => {
  withFakeWorker((built) => {
    const canvas = transferableCanvas();
    const instance = BitMotion.create({ canvas, worker: true, cellSize: 4 });
    const offscreen = canvas.transferred;

    assert.ok(offscreen.ctx.calls.drawImage >= 1, "the first frame should already be on the canvas");
    assert.equal(instance.running, true, "autoplay is the page's call, and it played");

    // No requestAnimationFrame in a worker: the loop runs on a timer, and
    // nothing renders until that timer fires.
    const before = offscreen.ctx.calls.drawImage;
    assert.equal(built.bridge.tick(), 1, "the loop should have scheduled exactly one frame");
    assert.ok(offscreen.ctx.calls.drawImage > before, "the timer frame should have drawn");

    instance.destroy();
  });
});

test("the page measures and the worker resizes", () => {
  withFakeWorker((built) => {
    const canvas = transferableCanvas();
    const instance = BitMotion.create({ canvas, worker: true, autoplay: false, cellSize: 4 });
    const offscreen = canvas.transferred;
    assert.equal(offscreen.width, 600);

    instance.setSize(1200, 600);
    assert.equal(offscreen.width, 1200, "the worker re-derived the grid from the posted box");
    assert.equal(offscreen.height, 600);
    instance.destroy();
  });
});

test("options and teardown cross the bridge", () => {
  withFakeWorker((built) => {
    const canvas = transferableCanvas();
    const instance = BitMotion.create({ canvas, worker: true, autoplay: false, cellSize: 4 });
    const offscreen = canvas.transferred;

    instance.setOption("upscale", "css");
    assert.equal(offscreen.width, 150, "css mode makes the backing store the grid");
    assert.equal(instance.o.upscale, "css", "and the page's copy of the options keeps up");

    instance.reseed(7);
    assert.equal(instance.rndSeed, 7);

    instance.destroy();
    assert.equal(built.terminated, 1, "the worker should have been terminated");
    assert.equal(built.bridge.self.closed, true, "and asked to close itself");
  });
});

test("markup asks for the worker the same way", () => {
  withFakeWorker((built) => {
    const el = element("canvas", { "data-bitmotion": "", "data-bitmotion-worker": "", "data-bitmotion-cell-size": "4" });
    el.getBoundingClientRect = () => ({ width: 600, height: 300 });
    el.transferControlToOffscreen = () => (el.transferred = new OffscreenCanvas(1, 1));

    const [instance] = BitMotion.init(el);
    assert.equal(instance.usesWorker, true, "data-bitmotion-worker should reach the worker path");
    assert.equal(BitMotion.get(el), instance);
    instance.destroy();
    assert.equal(BitMotion.get(el), null, "destroying the proxy should release the element");
  });
});

test("falls back to the page when the canvas cannot be transferred", () => {
  withFakeWorker((built) => {
    const canvas = new FakeElement("canvas");
    canvas.ownerDocument = document;
    const instance = BitMotion.create({ canvas, worker: true, autoplay: false });
    assert.ok(!instance.usesWorker, "should be an ordinary page-side instance");
    assert.equal(typeof instance._render, "function");
    assert.equal(built.worker, null, "no worker should have been started");
    instance.destroy();
  });
});

test("falls back to the page when a CSP refuses the worker", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    withFakeWorker((built) => {
      const canvas = transferableCanvas();
      const instance = BitMotion.create({ canvas, worker: true, autoplay: false });
      assert.ok(!instance.usesWorker);
      assert.ok(!canvas.transferred, "the canvas must not be transferred before the worker exists");
      assert.match(warnings.join(" "), /falling back to the page/);
      instance.destroy();
    }, { failToStart: true });
  } finally {
    console.warn = realWarn;
  }
});

run("worker");
