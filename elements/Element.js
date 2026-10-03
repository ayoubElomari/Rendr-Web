import Track from "../animation/Track.js";
import { animatedTracks, toCssProperty } from "../util/css.js";

/**
 * One thing on the stage.
 *
 * An element owns a DOM node and knows how to put itself in a given state. It
 * does **not** own its static styling: that lives in the runtime's single
 * stylesheet, keyed by the element's id (see `core/Stage.js`). Only animated
 * properties are written to the node, because only they change per frame.
 *
 * ── Why animated properties are inline and static ones are not ─────────────
 *
 * A stylesheet rule is parsed once and applies for the element's life. An inline
 * style is a per-node write. Putting the static half in the sheet means a frame
 * change touches only the handful of properties that actually move, and an edit
 * to a static property rewrites one rule instead of remounting anything.
 *
 * ── Animated properties must be on the element's own selector ──────────────
 *
 * A track under a descendant selector (`"img": { opacity: {...} }`) is not
 * supported, and this is a property of the format rather than an oversight here:
 * an element's children are built by the element and may not exist yet, may be
 * several, or may be replaced. The original resolved such selectors once at
 * construction with `querySelector` and silently animated nothing. This one says
 * so out loud instead.
 */
export default class Element {
  constructor(spec, context) {
    this.spec = spec;
    this.context = context;
    this.key = spec.key;
    this.id = `rw-${context.instanceId}-${cssSafe(spec.key)}`;
    this.type = spec.type;

    this.node = document.createElement("div");
    this.node.id = this.id;
    this.node.className = `rw-el rw-${spec.type}`;

    this.tracks = [];
    this.mounted = false;
    this.built = false;
    this.#collectTracks(spec.style);
  }

  /** Frames this element covers. */
  get at() {
    return this.spec.at;
  }
  get duration() {
    return this.spec.duration;
  }
  get end() {
    return this.spec.at + this.spec.duration;
  }

  visibleAt(frame) {
    return frame >= this.at && frame < this.end;
  }

  /**
   * Build whatever DOM/media this element needs. Called once, lazily, the first
   * time the element is about to be shown — so a composition with fifty elements
   * doesn't pay for the forty that this frame doesn't include.
   */
  async build() {
    this.built = true;
  }

  /**
   * Put the element into the state it should be in at `frame`.
   *
   * `frame` is absolute; `progress` is where that falls inside this element's own
   * duration, which is what tracks are authored against.
   */
  async update(frame) {
    const progress =
      this.duration <= 1 ? 0 : (frame - this.at) / (this.duration - 1);
    this.applyTracks(progress);
    await this.draw(frame - this.at, progress);
  }

  /** Subclass hook: paint content. `relative` is frames since the element began. */
  async draw() {}

  /** Write every animated property for this progress. */
  applyTracks(progress) {
    for (const entry of this.tracks) {
      const value = entry.track.valueAt(progress);
      if (value === undefined || value === entry.last) continue;
      entry.last = value;
      this.node.style.setProperty(entry.property, value);
    }
  }

  /**
   * True when this element can be updated in place to match a new spec.
   *
   * Type and identity have to match. Everything else — styling, timing, content —
   * is patchable, which is the whole point: an edit should move an element, not
   * replace it.
   */
  canAdopt(spec) {
    return spec.type === this.type && spec.key === this.key;
  }

  /** Take on a new spec without rebuilding. */
  adopt(spec) {
    const contentChanged =
      JSON.stringify(spec.config) !== JSON.stringify(this.spec.config);
    this.spec = spec;
    this.#collectTracks(spec.style);
    if (contentChanged) this.onConfigChanged();
    return contentChanged;
  }

  /** Subclass hook: the element's `config` changed under it. */
  onConfigChanged() {}

  /** Leaving the screen. Content stays built; only presence is released. */
  unmount() {
    this.node.remove();
    this.mounted = false;
  }

  destroy() {
    this.unmount();
    this.tracks = [];
    this.built = false;
  }

  /**
   * Animated properties, flattened.
   *
   * `last` caches the written value so a held segment writes nothing — during a
   * fade's plateau, and on every frame of a static element, this loop does
   * comparisons and no DOM work at all.
   */
  #collectTracks(styleDef) {
    /* Clear inline values from a previous spec, or a property that stopped being
       animated would keep whatever it was last set to. */
    for (const entry of this.tracks) {
      this.node.style.removeProperty(entry.property);
    }
    this.tracks = animatedTracks(styleDef)
      .filter(([selector]) => selector.includes("&"))
      .map(([, property, spec]) => ({
        property: toCssProperty(property),
        track: new Track(spec),
        last: undefined,
      }));
  }
}

/** An id has to survive being put in a CSS selector. */
function cssSafe(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "_");
}
