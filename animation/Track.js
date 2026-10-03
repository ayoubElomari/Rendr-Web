import easings from "./easings.js";
import { lerpValue } from "./interpolate.js";

/**
 * One keyframed property, evaluated at a frame.
 *
 * Authoring rules, all of which are properties of the format rather than of this
 * implementation:
 *
 *   - `at` is a percentage of the **element's own** duration, so a track survives
 *     the element being moved or stretched without retiming.
 *   - Easing sits on the keyframe a segment **leaves**, not the one it arrives at.
 *     (`from.easing`.) The original engine's own examples had this backwards,
 *     which is worth knowing before "fixing" a track that looks wrong.
 *   - `loop` repeats the whole track across the element's life.
 *
 * Keyframes are sorted and their percentages parsed **once**, at construction.
 * The original re-parsed and re-sorted on every property on every frame; at 60fps
 * with a few dozen animated properties that is thousands of string parses a
 * second, all producing the same numbers.
 */
export default class Track {
  constructor(spec) {
    this.loop = Boolean(spec.loop);
    this.keys = (spec.keyframes || [])
      .map((keyframe) => ({
        at: parsePercent(keyframe.at),
        value: keyframe.value,
        easing: easings[keyframe.easing] || null,
      }))
      .sort((a, b) => a.at - b.at);
    /* A cache of one. Playback asks for the same property at the same frame
       more than once (a re-render, a repaint), and consecutive frames of a
       held segment produce the same value. */
    this.lastProgress = -1;
    this.lastValue = undefined;
  }

  get isEmpty() {
    return this.keys.length === 0;
  }

  /**
   * @param {number} progress 0..1 through the element's duration
   * @returns the interpolated value at that point
   */
  valueAt(progress) {
    if (this.isEmpty) return undefined;

    let t = this.loop ? progress % 1 : Math.min(Math.max(progress, 0), 1);
    if (Number.isNaN(t)) t = 0;

    if (t === this.lastProgress) return this.lastValue;

    const keys = this.keys;
    const first = keys[0];
    const last = keys[keys.length - 1];

    let value;
    if (t <= first.at) value = first.value;
    else if (t >= last.at) value = last.value;
    else {
      let i = keys.length - 1;
      while (i > 0 && keys[i].at > t) i--;
      const from = keys[i];
      const to = keys[i + 1] || from;
      const span = to.at - from.at;
      const local = span <= 0 ? 0 : (t - from.at) / span;
      /* The segment's easing belongs to the keyframe it departs. */
      const eased = from.easing ? from.easing(local) : local;
      value = lerpValue(from.value, to.value, eased);
    }

    this.lastProgress = t;
    this.lastValue = value;
    return value;
  }
}

/** `"42%"` → 0.42. Bare numbers are already fractions. */
function parsePercent(at) {
  if (typeof at === "number") return at > 1 ? at / 100 : at;
  const value = parseFloat(String(at));
  if (Number.isNaN(value)) return 0;
  return String(at).includes("%") ? value / 100 : value > 1 ? value / 100 : value;
}
