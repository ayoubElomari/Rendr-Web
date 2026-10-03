/**
 * Playback.
 *
 * This lives in the runtime rather than in the host, and that placement is the
 * point. The demo this replaced ran its frame loop in React state: every frame of
 * playback re-rendered an editor containing an 800-line JSON view, sixty times a
 * second. A host should be able to draw a play button without owning a clock.
 *
 * ── Time is a debt, not a tick ─────────────────────────────────────────────
 *
 * The loop advances by however many frames of **wall-clock time** have passed,
 * carrying the remainder. Advancing one frame per animation frame silently caps
 * playback at the display's refresh rate, so a 120fps composition plays at 60 and
 * runs at half speed — the higher the frame rate, the slower it goes, which is
 * precisely backwards. A preview that cannot keep up should drop frames and stay
 * on schedule, the way every player does.
 *
 * Two things this must keep doing:
 *
 * - **Carry the remainder.** At 120fps on a 60Hz display the exact ratio is
 *   1.9999999999999998, so flooring gives 1 and the leftover has to be carried or
 *   playback runs slow; rounding instead runs 30% fast. The `1e-9` epsilon is for
 *   exactly that value.
 * - **Clamp the debt.** A tab backgrounded for ten seconds must resume, not
 *   teleport through the composition paying off ten seconds of frames.
 */
export default class Clock {
  #raf = null;
  #last = 0;
  #debt = 0;
  #holdUntil = 0;

  constructor({ onTick, onStateChange }) {
    this.onTick = onTick;
    this.onStateChange = onStateChange;

    this.frame = 0;
    this.totalFrames = 0;
    this.fps = 30;
    this.rate = 1;
    this.loop = true;
    this.holdMs = 600;
    this.playing = false;
  }

  configure({ fps, totalFrames }) {
    if (fps) this.fps = fps;
    if (totalFrames !== undefined) {
      this.totalFrames = totalFrames;
      /* An edit can shorten the composition under a playhead already past the
         new end. Clamping here rather than letting the host notice keeps every
         reader of `frame` honest. */
      if (this.frame > this.lastFrame) this.frame = this.lastFrame;
    }
  }

  get lastFrame() {
    return Math.max(0, this.totalFrames - 1);
  }

  get time() {
    return this.frame / this.fps;
  }

  get duration() {
    return this.totalFrames / this.fps;
  }

  play() {
    if (this.playing || this.totalFrames < 2) return;
    /* Pressing play at the end starts over rather than doing nothing. */
    if (this.frame >= this.lastFrame) this.frame = 0;
    this.playing = true;
    this.#last = now();
    this.#debt = 0;
    this.#holdUntil = 0;
    this.#raf = requestAnimationFrame(this.#step);
    this.onStateChange?.();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.onStateChange?.();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Jump. Out-of-range values clamp rather than throw — a scrubber overshoots. */
  seek(frame, { emit = true } = {}) {
    const next = Math.min(Math.max(Math.round(frame) || 0, 0), this.lastFrame);
    if (next === this.frame) return this.frame;
    this.frame = next;
    this.#debt = 0;
    if (emit) this.onTick?.(this.frame);
    return this.frame;
  }

  seekTime(seconds) {
    return this.seek(Math.round(seconds * this.fps));
  }

  /**
   * Playback speed. Clamped: below ~0.1 the loop stops advancing on most ticks
   * and reads as frozen, and above 4 nothing decodes fast enough to be watched.
   */
  setRate(rate) {
    this.rate = Math.min(Math.max(Number(rate) || 1, 0.1), 4);
    this.#debt = 0;
    this.onStateChange?.();
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
    this.onStateChange?.();
  }

  destroy() {
    this.pause();
    this.onTick = null;
    this.onStateChange = null;
  }

  #step = (timestamp) => {
    if (!this.playing) return;

    const dt = timestamp - this.#last;
    this.#last = timestamp;

    if (timestamp < this.#holdUntil) {
      this.#raf = requestAnimationFrame(this.#step);
      return;
    }

    const perFrame = 1000 / (this.fps * this.rate);
    this.#debt = Math.min(this.#debt + dt, perFrame * Math.ceil(this.fps / 4));

    const steps = Math.floor(this.#debt / perFrame + 1e-9);
    if (steps > 0) {
      this.#debt -= steps * perFrame;

      if (this.frame >= this.lastFrame) {
        if (!this.loop) {
          this.pause();
          return;
        }
        /* Rest on the last frame before starting over, so a loop reads as a
           loop rather than as a jump cut. */
        this.#holdUntil = timestamp + this.holdMs;
        this.frame = 0;
        this.onTick?.(this.frame);
      } else {
        this.frame = Math.min(this.frame + steps, this.lastFrame);
        this.onTick?.(this.frame);
      }
    }

    this.#raf = requestAnimationFrame(this.#step);
  };
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
