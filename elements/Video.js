import Element from "./Element.js";

/**
 * A clip, drawn one frame at a time.
 *
 * There is no `<video>` tag anywhere in this runtime. A composition asks for
 * frame *n*, and frame *n* is decoded and painted — which is the only model that
 * works when the thing driving time is a timeline rather than a playhead, and the
 * reason scrubbing lands exactly rather than approximately.
 *
 * Two pieces of config, both of which had no route through the file before:
 *
 * `offset` is the element's in-point, in composition frames. Without it every
 * element pointed at a clip plays it from its first frame, so a file can use a
 * clip once — and cutting back to a later moment of the same footage is the most
 * ordinary thing an edit does. It belongs to the element, not the asset, because
 * assets are shared: putting it on the source would have two elements of one clip
 * fighting over a single in-point.
 *
 * `fit` sets `object-fit` on the canvas. See `Image` for why it is config.
 */
export default class Video extends Element {
  async build() {
    const source = this.context.assets.get(assetName(this.spec.config.src));
    if (!source) {
      throw new Error(
        `Video element "${this.spec.key}" points at a missing asset (${this.spec.config.src})`,
      );
    }
    this.source = source;

    const canvas = document.createElement("canvas");
    canvas.width = source.properties.width;
    canvas.height = source.properties.height;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.objectFit = this.spec.config.fit || "contain";
    if (this.spec.config.position) {
      canvas.style.objectPosition = this.spec.config.position;
    }

    /* `alpha: false` lets the compositor skip blending a fully opaque surface,
       and `desynchronized` allows it to bypass a compositing step where the
       platform supports it. Both matter most on the device that needs them
       most. */
    this.ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    this.canvas = canvas;
    this.node.replaceChildren(canvas);
    this.lastDrawn = -1;
    await super.build();
  }

  onConfigChanged() {
    if (!this.canvas) return;
    this.canvas.style.objectFit = this.spec.config.fit || "contain";
    if (this.spec.config.position) {
      this.canvas.style.objectPosition = this.spec.config.position;
    }
    /* An in-point change means the frame on screen is now the wrong one. */
    this.lastDrawn = -1;
  }

  async draw(relative) {
    if (!this.source?.loaded) return;

    const index = this.#sourceIndex(relative);
    if (index === this.lastDrawn) return;

    const frame = await this.source.frameAt(index);
    if (!frame) return;

    /* Borrowed, not owned: the source closes it when it ages out of its cache.
       Drawing is a copy, so the frame is free to disappear afterwards. */
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this.lastDrawn = index;
  }

  sources() {
    return this.source ? [this.source] : [];
  }

  /**
   * Composition frame → source frame.
   *
   * The two clocks are not the same. A 25fps clip in a 60fps composition shows
   * each of its frames for a little over two composition frames, and the mapping
   * is a ratio rather than an offset. Wrapping keeps a short clip usable under a
   * longer element instead of freezing on its last frame.
   */
  #sourceIndex(relative) {
    const offset = this.spec.config.offset || 0;
    const compositionFps = this.context.fps;
    const sourceFps = this.source.properties.fps || compositionFps;
    const scaled = Math.round(((relative + offset) * sourceFps) / compositionFps);
    const total = this.source.frameCount;
    if (total <= 0) return 0;
    return ((scaled % total) + total) % total;
  }
}

function assetName(ref) {
  const match = /^@assets:(.+)$/.exec(String(ref || ""));
  return match ? match[1] : ref;
}
