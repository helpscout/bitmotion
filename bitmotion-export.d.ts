// Type declarations for @helpscout/bitmotion/export — the GIF, video and PNG
// tooling. It is a build-time/editor companion to the engine and has no place
// on a live page.

export as namespace BitMotionExport;
export = BitMotionExport;

declare const BitMotionExport: BitMotionExport.BitMotionExportStatic;

declare namespace BitMotionExport {
  interface ExportOptions {
    /** The engine, when it is not on the global — e.g. `import BitMotion from "@helpscout/bitmotion"`. */
    BitMotion?: unknown;
    /** The instance options to render with, normally `instance.o`. */
    options: Record<string, unknown>;
    /** Pin the composition, normally `instance.rndSeed`. */
    seed?: number | null;
    /** Target width in pixels. Height defaults to 16:9. */
    width: number;
    height?: number;
    seconds: number;
    fps: number;
    /** Block size in exported pixels; falls back to `resolution`. */
    cellSize?: number;
    resolution?: number;
    /** GIF and PNG only — video is always composited onto the background. */
    transparent?: boolean;
    onProgress?: (fraction: number, frame: number, frames: number) => void;
  }

  interface VideoOptions extends ExportOptions {
    /** Preferred container/codec; the best available one is used otherwise. */
    codec?: string;
  }

  interface PngSequenceOptions extends ExportOptions {
    /** Filename prefix inside the zip. Defaults to "bitmotion". */
    prefix?: string;
  }

  interface Plan {
    width: number;
    height: number;
    /** Human-readable "W×H". */
    grid: string;
    gridW: number;
    gridH: number;
    cell: number;
    frames: number;
    colors: number;
  }

  interface BitMotionExportStatic {
    /** What an export would produce, without rendering it. */
    plan(options: ExportOptions): Plan;
    /** An animated GIF. */
    gif(options: ExportOptions): Promise<Blob>;
    /** A recorded video, in the best container this browser can encode. */
    video(options: VideoOptions): Promise<Blob>;
    /** A zip of numbered PNG frames. */
    pngSequence(options: PngSequenceOptions): Promise<Blob>;
    /** Hand a blob to the user as a download. */
    save(filename: string, blob: Blob): Promise<"saved" | "declined">;
    /** File extension for the video format that would be used, or null. */
    videoFormat(preference?: string): string | null;
    /** Human-readable label for that format, or null. */
    videoLabel(preference?: string): string | null;
  }
}
