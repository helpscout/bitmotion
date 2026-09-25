/*!
 * BitMotion for React — a canvas that mounts an instance and keeps it in step
 * with its props.
 *
 *   import BitMotionCanvas from "@helpscout/bitmotion/react";
 *
 *   <BitMotionCanvas
 *     scene="drift"
 *     cellSize={3}
 *     maxCells={200000}
 *     seed={1834027461}
 *     style={{ width: "100%", height: 460 }}
 *   />
 *
 * Every BitMotion option is a prop; everything else (className, style, id,
 * aria-*, event handlers) lands on the <canvas> untouched. As with the plain
 * engine the canvas is sized by CSS only — never width/height attributes.
 *
 * `fadeIn` holds the canvas at opacity 0 until there is artwork on it, then
 * transitions it in. The canvas also carries data-state="loading" | "ready"
 * throughout, so a page can do its own thing with CSS instead.
 *
 * React is a peer dependency: this file is the only part of the package that
 * imports it, so a non-React consumer never pays for it.
 */
"use strict";

var React = require("react");

/* ---------------------------------------------------------------- loading */

var engine = null;

// The engine is a module, so the require cache already guarantees one copy per
// page however many canvases mount — this only adds the window check, which
// matters on a page that also loads the UMD build in a <script> tag: without
// it that page would run two independent copies of the engine.
function getBitMotion() {
  if (!engine) {
    engine = (typeof window !== "undefined" && window.BitMotion) || require("./bitmotion.js");
  }
  return engine;
}

/* --------------------------------------------------------------- plumbing */

// Options are compared by value: a caller writing `origin={{ x: 0, y: 1 }}`
// inline hands over a new object every render, and re-seeding the composition
// on every parent render would be a bug with no visible cause.
function same(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

// `seed` recomposes rather than being assigned, and these three are read while
// the grid is being laid out, which `setOption` has no path to redo — cheap
// enough to remount for, and all three are rare to animate.
var REMOUNT = { size: true, grid: true, maxCell: true, worker: true, workerUrl: true };

var DEFAULT_FADE_MS = 400;

// `fadeIn` takes a boolean or a duration. Anything that is not a positive
// number of milliseconds means no fade.
function fadeMs(fadeIn) {
  if (fadeIn === true) return DEFAULT_FADE_MS;
  if (typeof fadeIn === "number" && fadeIn > 0) return fadeIn;
  return 0;
}

// The animation the engine itself sits still for is the one a fade should sit
// still for too. Read per render rather than cached, since it can change while
// the page is open.
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function splitProps(props) {
  var names = getBitMotion().OPTIONS;
  var options = {}, rest = {}, key;
  var isOption = {};
  for (var i = 0; i < names.length; i++) isOption[names[i]] = true;
  for (key in props) {
    // Ours, not the canvas's.
    if (key === "onReady" || key === "paused" || key === "fadeIn") continue;
    // `canvas` is an option on the engine but not a prop here: the component
    // owns the element.
    if (isOption[key] && key !== "canvas") {
      if (props[key] !== undefined) options[key] = props[key];
    } else {
      rest[key] = props[key];
    }
  }
  return { options: options, rest: rest };
}

// Returns false when the change cannot be applied in place, so the caller
// knows to rebuild the instance instead.
function applyChanges(instance, next, previous) {
  var key, changed = [];
  for (key in next) if (!same(next[key], previous[key])) changed.push(key);
  for (key in previous) if (!(key in next) && !same(undefined, previous[key])) changed.push(key);

  for (var i = 0; i < changed.length; i++) {
    key = changed[i];
    if (REMOUNT[key]) return false;
    // A prop that disappears leaves its last value in place: React cannot say
    // what it should revert to, and guessing at the default would silently
    // undo a `setOption` the caller made through the instance itself.
    if (!(key in next)) continue;
    if (key === "seed") instance.reseed(next.seed);
    else instance.setOption(key, next[key]);
  }
  return true;
}

/* -------------------------------------------------------------- component */

var BitMotionCanvas = React.forwardRef(function BitMotionCanvas(props, forwardedRef) {
  var canvasRef = React.useRef(null);
  var instanceRef = React.useRef(null);
  var appliedRef = React.useRef(null);
  var split = splitProps(props);

  // Read by effects that must not re-run when these change.
  var optionsRef = React.useRef(split.options);
  optionsRef.current = split.options;
  var onReadyRef = React.useRef(props.onReady);
  onReadyRef.current = props.onReady;

  // Whether there is artwork on the canvas yet. On the page that is true by
  // the time create() returns; in worker mode it is a message later, which is
  // exactly the wait a fade exists to cover. Once true it stays true, so a
  // prop that rebuilds the instance does not fade the canvas in again over
  // pixels that never went away.
  var readyState = React.useState(false);
  var ready = readyState[0];
  var setReady = readyState[1];
  // The callback below fires before the state has settled, so it reads its
  // own flag rather than `ready`.
  var readyRef = React.useRef(false);

  // The forwarded ref is the canvas, as it would be on any DOM component. The
  // instance arrives through `onReady`, since it does not exist until mount.
  React.useImperativeHandle(forwardedRef, function () { return canvasRef.current; }, []);

  // `generation` exists only so a prop that cannot be applied in place can
  // force the mount effect to run again and build a fresh instance.
  var generationState = React.useState(0);
  var generation = generationState[0];
  var remount = generationState[1];

  React.useEffect(function () {
    var options = {}, key;
    for (key in optionsRef.current) options[key] = optionsRef.current[key];
    options.canvas = canvasRef.current;

    var live = true;
    var frame = null;
    var given = options.onFirstFrame;
    options.onFirstFrame = function (instance) {
      if (typeof given === "function") given(instance);
      if (!live || readyRef.current) return;
      // A frame's grace before the opacity changes: the browser has to have
      // rendered the canvas at opacity 0 for there to be anything to
      // transition from, and on the page this callback arrives during
      // create(), before that has happened.
      frame = requestAnimationFrame(function () {
        frame = null;
        if (live) { readyRef.current = true; setReady(true); }
      });
    };

    var instance = getBitMotion().create(options);
    instanceRef.current = instance;
    appliedRef.current = optionsRef.current;
    if (onReadyRef.current) onReadyRef.current(instance);

    return function () {
      live = false;
      if (frame !== null) cancelAnimationFrame(frame);
      instance.destroy();
      instanceRef.current = null;
      appliedRef.current = null;
    };
  }, [generation]);

  // No dependency array on purpose: the comparison below is the dependency
  // check, and it has to see every option, not a list fixed at build time.
  React.useEffect(function () {
    var instance = instanceRef.current;
    if (!instance) return;
    if (applyChanges(instance, split.options, appliedRef.current || {})) {
      appliedRef.current = split.options;
    } else {
      remount(function (n) { return n + 1; });
    }
  });

  React.useEffect(function () {
    var instance = instanceRef.current;
    if (!instance || props.paused === undefined) return;
    if (props.paused) instance.pause();
    else instance.play();
  }, [props.paused, generation]);

  var attrs = {};
  for (var key in split.rest) attrs[key] = split.rest[key];
  attrs.ref = canvasRef;
  // Something for a page to hang its own CSS on, whether or not `fadeIn` is
  // doing the work.
  attrs["data-state"] = ready ? "ready" : "loading";

  var ms = fadeMs(props.fadeIn);
  if (ms > 0) {
    var style = {};
    for (var s in props.style) style[s] = props.style[s];
    style.opacity = ready ? 1 : 0;
    // Reduced motion gets the end state without the journey — the canvas
    // still appears, it just does not fade.
    if (ready && !prefersReducedMotion()) style.transition = "opacity " + ms + "ms ease-out";
    attrs.style = style;
  }
  return React.createElement("canvas", attrs);
});

BitMotionCanvas.displayName = "BitMotionCanvas";

module.exports = BitMotionCanvas;
module.exports.BitMotionCanvas = BitMotionCanvas;
module.exports.getBitMotion = getBitMotion;
module.exports.default = BitMotionCanvas;
