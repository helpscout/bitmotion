/**
 * The smallest DOM the engine actually touches: a canvas, a 2D context stub
 * and the handful of window globals it reads. Shared by the tests so they
 * drive the real code rather than a mock of it.
 */
// One context per canvas, counting the calls the tests care about — the
// engine draws into two canvases and which one it reaches for is the point.
function makeContext() {
  return {
    fillStyle: "",
    imageSmoothingEnabled: true,
    calls: { clearRect: 0, fillRect: 0, drawImage: 0, putImageData: 0 },
    clearRect() { this.calls.clearRect++; },
    fillRect() { this.calls.fillRect++; },
    drawImage() { this.calls.drawImage++; },
    putImageData() { this.calls.putImageData++; },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
  };
}

export class FakeElement {
  constructor(tagName, attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs));
    this.style = {};
    this.children = [];
    this.ownerDocument = null;
    this.ctx = makeContext();
  }
  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  hasAttribute(n) { return this._attrs.has(n); }
  appendChild(child) { child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
  getBoundingClientRect() { return { width: 320, height: 180 }; }
  getContext() { return this.ctx; }
}

/** Elements the fake `querySelectorAll` can find. */
export const page = [];

export const document = {
  readyState: "complete",
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    const el = new FakeElement(tag);
    el.ownerDocument = document;
    return el;
  },
  // Only one selector is ever asked for, so matching is by attribute.
  querySelectorAll(selector) {
    if (selector !== "[data-bitmotion]") throw new Error("unexpected selector: " + selector);
    return page.filter((el) => el.hasAttribute("data-bitmotion"));
  }
};

/** A fake element the engine's mount pass can find. */
export function element(tag, attrs) {
  const el = new FakeElement(tag, attrs);
  el.ownerDocument = document;
  page.push(el);
  return el;
}

globalThis.document = document;
globalThis.window = {
  document,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {}
};
// Frames are queued rather than fired, so a test says when one happens.
const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => { frames.set(nextFrame, fn); return nextFrame++; };
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };

/** Runs the frames queued right now; anything they queue waits for the next call. */
export function flushFrames() {
  const due = [...frames.entries()];
  for (const [id] of due) frames.delete(id);
  for (const [, fn] of due) fn(performance.now());
  return due.length;
}

/* ---------------------------------------------------------------- runner */

const tests = [];
export const test = (name, fn) => tests.push([name, fn]);

export function run(title) {
  let failed = 0;
  console.log(title);
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
}
