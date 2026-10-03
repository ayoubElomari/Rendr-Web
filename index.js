/**
 * Rendr Web — a rendering runtime for the browser.
 *
 * See ./README.md for the architecture and the reasoning behind it.
 *
 *   import { createRendr } from "./rendr-web/index.js";
 *
 *   const rendr = createRendr(hostElement, composition, {
 *     onFrame: ({ frame, timecode }) => …,
 *     onState: ({ playing }) => …,
 *   });
 *   await rendr.ready();
 *   rendr.play();
 *
 * The host element is the box the picture is fitted into. The runtime creates its
 * own stage inside it and owns everything below that — so the host styles a box
 * and nothing else.
 */
import Rendr from "./core/Rendr.js";

export function createRendr(host, composition, options) {
  return new Rendr(host, composition, options);
}

export { default as Rendr } from "./core/Rendr.js";
export {
  elementTypes,
  registerElementType,
  resolveElementType,
} from "./elements/registry.js";
export { detectCapabilities } from "./runtime/Capabilities.js";
export {
  formatTimecode,
  framesFromSeconds,
  parseTimecode,
  secondsFromFrames,
  timecodeFromFrames,
} from "./util/timecode.js";
export { default as Composition } from "./core/Composition.js";

export const VERSION = "1.0.0";
