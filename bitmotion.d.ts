// Type declarations for @helpscout/bitmotion.
//
// The runtime is a single UMD file, so this is written as `export =`: it types
// `import BitMotion from "@helpscout/bitmotion"`, `require(...)` and the
// `BitMotion` global from a <script> tag alike.

export as namespace BitMotion;
export = BitMotion;

declare const BitMotion: BitMotion.BitMotionStatic;

declare namespace BitMotion {
  type SceneName = "drift" | "waves" | "bloom" | "ribbon" | "nebula";

  type RampName = "dissolve" | "bleed" | "warm" | "cool" | "duo" | "ink";

  type BackgroundName = "clay" | "blue" | "red" | "lilac" | "yellow";

  type OriginName =
    | "top-left" | "top" | "top-right"
    | "left" | "center" | "right"
    | "bottom-left" | "bottom" | "bottom-right";

  /** Gradient stops as [position 0..1, "#rrggbb"] pairs. */
  type RampStops = Array<[number, string]>;

  interface Options {
    /** The canvas to draw into: an element or a selector. Required by `create`; `init` fills it in. */
    canvas: HTMLCanvasElement | string;
    /** CSS pixels to use instead of measuring the element. */
    size?: { w: number; h: number } | null;
    /** Exact cell counts, bypassing `cellSize` and `resolution`. */
    grid?: { w: number; h: number } | null;
    /** Cap on cell size in device pixels (0 = uncapped). */
    maxCell?: number;
    /** Block size in output pixels — the primary sizing control. 0 sizes by `resolution` instead. */
    cellSize?: number;
    /**
     * How the grid becomes blocks. "canvas" renders the finished artwork into
     * the backing store and scales the grid up with drawImage; "css" makes
     * the backing store the grid and leaves the scaling to the compositor,
     * which uploads far less per frame.
     */
    upscale?: "canvas" | "css";
    /** Device-pixel-ratio ceiling. 1 quarters the cell count. */
    maxDpr?: number;
    /** Hard ceiling on grid cells; blocks coarsen to fit. Keep this set in production. */
    maxCells?: number;
    /** Cells along the long edge — only consulted when `cellSize` is 0. */
    resolution?: number;
    ramp?: RampName | RampStops;
    /** Palette entries matching this colour render transparent. */
    background?: string;
    /** false paints `background` instead of leaving it transparent. */
    transparent?: boolean;
    /** "loop" for a perfect cycle, "flow" for endless variation. */
    mode?: "loop" | "flow";
    loopSeconds?: number;
    sceneSeconds?: number;
    crossfade?: number;
    /** How many orbiting blobs the composition drifts with (0-12). */
    blobs?: number;
    /** Whole turns of the composition per loop. */
    revolve?: number;
    /** Pin one scene, or null to cycle. */
    scene?: SceneName | null;
    /** Restrict the rotation to these scenes. */
    scenes?: SceneName[] | null;
    /** Render cap in frames per second; 0 is uncapped. */
    fps?: number;
    dither?: "atkinson" | "bayer" | "none";
    /** Auto-normalise each field to the full ramp range. */
    levels?: boolean;
    /** -1..1 after normalising; negative shows more paper. */
    exposure?: number;
    /** >1 widens the flat areas, <1 widens the stipple. */
    contrast?: number;
    shape?: "edges" | "radial" | "none";
    origin?: OriginName | { x: number; y: number };
    /** 0..1 — how far the edge blurs outward. */
    falloff?: number;
    /** 0..1 — how much the outline breathes. 0 freezes the silhouette. */
    morph?: number;
    /** Guaranteed margin, as a fraction of the short edge. */
    inset?: number;
    /** Integer for a reproducible composition. */
    seed?: number | null;
    /**
     * Called once, as soon as there is artwork on the canvas: inside
     * `create()` on the page, a message later in worker mode. This is what
     * anything fading the canvas in should wait for.
     */
    onFirstFrame?: ((instance: Instance) => void) | null;
    /**
     * Render in a worker, off the main thread, via OffscreenCanvas. Falls
     * back to rendering on the page where that is unavailable.
     */
    worker?: boolean;
    /**
     * A worker script to use instead of the built-in blob — for pages whose
     * Content-Security-Policy refuses `blob:` workers. The file needs two
     * lines: `importScripts(".../bitmotion.js")` then `BitMotion.startWorker()`.
     */
    workerUrl?: string | null;
    autoplay?: boolean;
    /** Hold a single static frame under prefers-reduced-motion. */
    respectReducedMotion?: boolean;
  }

  /** Options as `init` accepts them — the canvas comes from the element. */
  type InitOptions = Omit<Options, "canvas">;

  interface Instance {
    readonly canvas: HTMLCanvasElement;
    /** The resolved options this instance is running with. */
    readonly o: Required<Options>;
    /** The seed driving this composition, whether given or generated. */
    readonly rndSeed: number;
    readonly running: boolean;
    /** True when this instance is a handle on one rendering in a worker. */
    readonly usesWorker?: boolean;
    /** Seconds of animation played so far. */
    readonly elapsed: number;

    play(): Instance;
    pause(): Instance;
    /** Jump to a time in seconds and render that frame. */
    seek(seconds: number): Instance;
    /** Resize to a box given in device pixels, instead of measuring the element. */
    setSize(width: number, height: number): Instance;
    setRamp(ramp: RampName | RampStops): Instance;
    /** Change one option in place, rebuilding only what it affects. */
    setOption<K extends keyof Options>(key: K, value: Options[K]): Instance;
    /** Recompose from a new seed, or a random one when omitted. */
    reseed(seed?: number | null): Instance;
    /** Stop, release listeners and observers, and unregister from `init`. */
    destroy(): Instance;
  }

  /** Anything `init` and `get` accept as a target. */
  type Target = string | Element | ArrayLike<Element> | null;

  interface BitMotionStatic {
    /** Start an animation on one canvas. */
    create(options: Options): Instance;

    /**
     * Mount `[data-bitmotion]` elements, or whatever `target` selects. Runs
     * once automatically when the DOM is ready; call it again after injecting
     * markup. Already-mounted elements are returned untouched.
     */
    init(target?: Target, overrides?: Partial<InitOptions>): Instance[];

    /** The instance mounted on an element, if there is one. */
    get(target: string | Element): Instance | null;

    /** Destroy every instance `init` mounted. */
    destroyAll(): void;

    /**
     * Called by a worker script, never by a page:
     * `importScripts(".../bitmotion.js"); BitMotion.startWorker();`
     */
    startWorker(): void;

    /** Every option name, in declaration order. */
    readonly OPTIONS: Array<keyof Options>;
    readonly RAMPS: Record<RampName, RampStops>;
    readonly BACKGROUNDS: Record<BackgroundName, string>;
    readonly ORIGINS: Record<OriginName, [number, number]>;
    readonly SCENES: SceneName[];
    readonly COLORS: Record<"paper" | "cream" | "yellow" | "coral" | "blue" | "purple" | "ink", string>;
    hexToRgb(hex: string): { r: number; g: number; b: number };
  }
}
