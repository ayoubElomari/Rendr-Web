/**
 * The sample table, and the GOP arithmetic that goes with it.
 *
 * A compressed video is not randomly addressable. Frames are stored in groups
 * that start with a keyframe, and every other frame in the group is expressed as
 * a difference from its neighbours — so to show frame 47 you must decode from the
 * last keyframe at or before 47, forwards. That single fact drives the whole
 * design of `VideoSource`, and this class is what makes it answerable.
 *
 * Carried over from the original engine's `Samples`, with the lookups turned from
 * linear scans into arithmetic: `getGopStart` ran `findIndex` over every keyframe
 * on **every frame request**, which is fine for a file rendered once and wasteful
 * sixty times a second.
 */
export default class Samples {
  constructor(samples, displayToDecodeIndex) {
    this.samples = samples;
    this.displayToDecodeIndex = displayToDecodeIndex;
    this.length = samples.length;

    /* Indices of the keyframes, and — the actual optimisation — a lookup from
       any frame to its group's start, built once. One array read replaces a
       scan whose cost grew with the length of the clip. */
    this.keyIndices = [];
    this.gopStartFor = new Int32Array(this.length);
    let current = 0;
    for (let i = 0; i < this.length; i++) {
      if (samples[i].is_sync) {
        this.keyIndices.push(i);
        current = i;
      }
      this.gopStartFor[i] = current;
    }
  }

  /** The keyframe index at or before `frame`. */
  gopStart(frame) {
    const clamped = Math.min(Math.max(frame, 0), this.length - 1);
    return this.gopStartFor[clamped] ?? 0;
  }

  /** `[first, last]` display indices of the group containing `frame`. */
  gopRange(frame) {
    const start = this.gopStart(frame);
    const position = this.keyIndices.indexOf(start);
    const next = this.keyIndices[position + 1] ?? this.length;
    return [start, next - 1];
  }

  sample(index) {
    return this.samples[index];
  }

  /**
   * Display order → decode order.
   *
   * B-frames mean a video's frames are not stored in the order they are shown,
   * and a decoder emits them in decode order with the display timestamp attached.
   * This is the map between the two.
   */
  decodeIndex(displayIndex) {
    return this.displayToDecodeIndex.get(displayIndex);
  }
}
