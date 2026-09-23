// Type declarations for @helpscout/bitmotion/react.

import type { ComponentType, CanvasHTMLAttributes, Ref } from "react";
import type BitMotion = require("./bitmotion.js");

declare namespace BitMotionReact {
  /** Every engine option, as props. `canvas` is owned by the component. */
  type OptionProps = Partial<Omit<BitMotion.Options, "canvas">>;

  interface BitMotionCanvasProps
    extends OptionProps,
      Omit<CanvasHTMLAttributes<HTMLCanvasElement>, keyof OptionProps | "ref"> {
    /**
     * Play state after mount. Leave it off to let `autoplay` decide and drive
     * the instance yourself.
     */
    paused?: boolean;
    /** Called once with the instance, for imperative work like `seek`. */
    onReady?: (instance: BitMotion.Instance) => void;
    ref?: Ref<HTMLCanvasElement>;
  }

  type BitMotionCanvasComponent = ComponentType<BitMotionCanvasProps>;
}

declare const BitMotionCanvas: BitMotionReact.BitMotionCanvasComponent;

export default BitMotionCanvas;
export { BitMotionCanvas };
export type BitMotionCanvasProps = BitMotionReact.BitMotionCanvasProps;

/** The engine the components use: the page's `window.BitMotion` if there is one. */
export declare function getBitMotion(): typeof BitMotion;
