/**
 * A still, decoded once.
 *
 * `decode()` is raced against a timeout rather than awaited. Chromium defers
 * decoding a large raster image while the document is hidden, and that promise
 * then never settles — which, in a runtime that waits for its assets before
 * building a timeline, means a page opened in a background tab hangs at load
 * forever with no error to show for it. Decoding ahead of time is an
 * optimisation, so it is not allowed to be a blocker: on timeout the image is
 * used anyway (it has loaded; it will decode when first drawn). A genuine decode
 * *failure* still rejects, because that image is broken rather than late.
 */
const DECODE_TIMEOUT_MS = 2000;

export default class ImageSource {
  constructor(src, { onLoading } = {}) {
    this.src = src;
    this.type = "image";
    this.image = null;
    this.loaded = false;
    this.properties = {};
    this.onLoading = onLoading || null;
  }

  get framesHeld() {
    return this.loaded ? 1 : 0;
  }

  get bytesHeld() {
    const { width = 0, height = 0 } = this.properties;
    return width * height * 4;
  }

  async load() {
    if (this.loaded) return this;
    this.onLoading?.(true, "Loading image");
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = this.src;

      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () =>
          reject(new Error(`Failed to load image: ${this.src}`));
      });

      await Promise.race([
        image.decode(),
        new Promise((resolve) => setTimeout(resolve, DECODE_TIMEOUT_MS)),
      ]);

      this.image = image;
      this.properties = {
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      this.loaded = true;
    } finally {
      this.onLoading?.(false, null);
    }
    return this;
  }

  /** Same shape as VideoSource, so an element doesn't branch on asset type. */
  async frameAt() {
    return this.image;
  }

  releaseFrames() {
    return 0;
  }

  destroy() {
    this.image = null;
    this.loaded = false;
  }
}
