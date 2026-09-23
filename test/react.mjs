/**
 * Tests for @helpscout/bitmotion/react.
 *
 * React is a peer dependency and this repo installs nothing, so the file below
 * carries a ~90-line React: enough hooks and enough of a commit phase to run
 * the real component — render, re-render with new props, unmount — against the
 * real engine and the fake DOM. It is not React, but every behaviour asserted
 * here (effects after refs, cleanup on unmount, a state update re-rendering)
 * is one React guarantees.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FakeElement, document, test, run } from "./dom.mjs";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------- mini React */

let active = null; // the root currently rendering

function hook(init) {
  const slots = active.slots;
  if (slots.length <= active.index) slots.push(init());
  return slots[active.index++];
}

function setRef(ref, value) {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") ref.current = value;
}

function changed(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

const React = {
  createElement(type, props) {
    const { ref, ...rest } = props || {};
    return { type, props: rest, ref: ref || null };
  },
  forwardRef(render) {
    return { __forwardRef: true, render, displayName: "" };
  },
  useRef(initial) {
    return hook(() => ({ current: initial }));
  },
  useState(initial) {
    const root = active;
    const slot = hook(() => ({ value: initial }));
    return [slot.value, (next) => {
      const value = typeof next === "function" ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      root.dirty = true;
    }];
  },
  useEffect(fn, deps) {
    const slot = hook(() => ({ deps: null, cleanup: null, first: true }));
    if (slot.first || !deps || changed(deps, slot.deps)) {
      slot.first = false;
      active.pending.push(slot);
      slot.next = fn;
    }
    slot.deps = deps || null;
  },
  useImperativeHandle(ref, create, deps) {
    React.useEffect(() => {
      setRef(ref, create());
      return () => setRef(ref, null);
    }, deps);
  }
};

class Root {
  constructor(component) {
    this.component = component;
    this.slots = [];
    this.node = null;
  }
  render(props) {
    this.props = props;
    let guard = 0;
    do {
      this.dirty = false;
      this.index = 0;
      this.pending = [];
      active = this;
      const element = this.component.render(props, props.ref || null);
      active = null;

      // Commit: the DOM node exists and refs are attached before any effect
      // runs, which is what the component relies on.
      if (!this.node) {
        this.node = new FakeElement(element.type);
        this.node.ownerDocument = document;
      }
      this.node.props = element.props;
      if (element.ref) setRef(element.ref, this.node);

      for (const slot of this.pending) {
        if (slot.cleanup) slot.cleanup();
        slot.cleanup = slot.next() || null;
      }
      if (++guard > 10) throw new Error("render loop did not settle");
    } while (this.dirty);
    return this;
  }
  unmount() {
    for (const slot of this.slots) if (slot.cleanup) slot.cleanup();
  }
}

function mount(component, props) {
  return new Root(component).render(props || {});
}

// The component imports "react" — hand it the one above.
const load = Module._load;
Module._load = function (request) {
  if (request === "react") return React;
  return load.apply(this, arguments);
};

/* ------------------------------------------------------------------ setup */

const BitMotion = require(path.join(root, "bitmotion.js"));

// A page that already has the UMD build should be reused rather than run
// twice. Delegates to the real engine, so it is a different object with
// identical behaviour.
const onPage = Object.create(BitMotion);
globalThis.window.BitMotion = onPage;

const BitMotionCanvas = require(path.join(root, "react.cjs"));
const { getBitMotion } = BitMotionCanvas;

// Captures the instance the way a consumer would, and counts teardowns.
function tracker() {
  const seen = [];
  let destroyed = 0;
  return {
    seen,
    get destroyed() { return destroyed; },
    onReady(instance) {
      seen.push(instance);
      const inner = instance.destroy.bind(instance);
      instance.destroy = () => { destroyed++; return inner(); };
    }
  };
}

/* ------------------------------------------------------------------ tests */

test("resolves the engine once, preferring one already on the page", () => {
  assert.equal(getBitMotion(), onPage);
  assert.equal(getBitMotion(), getBitMotion());
  assert.equal(typeof BitMotionCanvas.BitMotionCanvas, "object");
  assert.equal(BitMotionCanvas.default, BitMotionCanvas);
});

test("mounts an instance configured from the props", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, {
    scene: "waves", cellSize: 4, seed: 42, autoplay: false, onReady: t.onReady
  });
  const [instance] = t.seen;
  assert.ok(instance, "onReady was never called");
  assert.equal(instance.canvas, root.node);
  assert.equal(instance.o.scene, "waves");
  assert.equal(instance.o.cellSize, 4);
  assert.equal(instance.rndSeed, 42);
  root.unmount();
});

test("option props stay off the canvas, everything else lands on it", () => {
  const root = mount(BitMotionCanvas, {
    scene: "bloom", autoplay: false, className: "hero", id: "art", "aria-hidden": "true"
  });
  assert.deepEqual(root.node.props, { className: "hero", id: "art", "aria-hidden": "true" });
  root.unmount();
});

test("changed options are applied in place, without a new instance", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { cellSize: 3, blobs: 5, autoplay: false, onReady: t.onReady });
  const [instance] = t.seen;
  root.render({ cellSize: 6, blobs: 2, autoplay: false, onReady: t.onReady });
  assert.equal(t.seen.length, 1, "the instance should have been kept");
  assert.equal(instance.o.cellSize, 6);
  assert.equal(instance.o.blobs, 2);
  root.unmount();
});

test("a new seed recomposes rather than remounting", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { seed: 1, autoplay: false, onReady: t.onReady });
  const [instance] = t.seen;
  root.render({ seed: 2, autoplay: false, onReady: t.onReady });
  assert.equal(t.seen.length, 1);
  assert.equal(instance.rndSeed, 2);
  root.unmount();
});

test("an option that cannot be applied in place rebuilds the instance", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { size: { w: 320, h: 180 }, autoplay: false, onReady: t.onReady });
  root.render({ size: { w: 640, h: 360 }, autoplay: false, onReady: t.onReady });
  assert.equal(t.seen.length, 2, "a new instance should have been built");
  assert.equal(t.destroyed, 1, "the old instance should have been destroyed");
  assert.equal(t.seen[1].o.size.w, 640);
  root.unmount();
});

test("an equal object prop is not a change", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { origin: { x: 0, y: 1 }, autoplay: false, onReady: t.onReady });
  const before = t.seen[0].rndSeed;
  root.render({ origin: { x: 0, y: 1 }, autoplay: false, onReady: t.onReady });
  assert.equal(t.seen.length, 1);
  assert.equal(t.seen[0].rndSeed, before);
  root.unmount();
});

test("paused drives play and pause", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { autoplay: false, paused: true, onReady: t.onReady });
  const [instance] = t.seen;
  assert.equal(instance.running, false);
  root.render({ autoplay: false, paused: false, onReady: t.onReady });
  assert.equal(instance.running, true);
  root.render({ autoplay: false, paused: true, onReady: t.onReady });
  assert.equal(instance.running, false);
  root.unmount();
});

test("unmounting destroys the instance", () => {
  const t = tracker();
  const root = mount(BitMotionCanvas, { autoplay: true, onReady: t.onReady });
  const [instance] = t.seen;
  assert.equal(instance.running, true);
  root.unmount();
  assert.equal(t.destroyed, 1);
  assert.equal(instance.running, false);
});

run("react");
