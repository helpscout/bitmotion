/*!
 * ESM view of the React wrapper. The implementation lives in react.cjs so
 * there is one copy of it: Node's CommonJS detection cannot be relied on for
 * named exports, so they are taken off the default import by hand.
 */
import BitMotionCanvas from "./react.cjs";

export default BitMotionCanvas;
export const getBitMotion = BitMotionCanvas.getBitMotion;
export { BitMotionCanvas };
