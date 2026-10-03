import Element from "./Element.js";

/**
 * A still.
 *
 * `config.fit` sets `object-fit` and defaults to `contain`. It is config rather
 * than style for the same reason it is on video: the element writes the property
 * itself, so a `"img": { objectFit }` block in the file could never win against
 * it. Without a way to say `cover`, a landscape still can only ever be
 * letterboxed inside a vertical frame.
 */
export default class Image extends Element {
  async build() {
    const source = this.context.assets.get(assetName(this.spec.config.src));
    if (!source) {
      throw new Error(
        `Image element "${this.spec.key}" points at a missing asset (${this.spec.config.src})`,
      );
    }
    this.source = source;

    const img = document.createElement("img");
    img.src = source.src;
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = this.spec.config.fit || "contain";
    if (this.spec.config.position) {
      img.style.objectPosition = this.spec.config.position;
    }

    this.img = img;
    this.node.replaceChildren(img);
    await super.build();
  }

  onConfigChanged() {
    if (!this.img) return;
    this.img.style.objectFit = this.spec.config.fit || "contain";
    if (this.spec.config.position) {
      this.img.style.objectPosition = this.spec.config.position;
    }
  }

  /** Nothing to paint per frame — an image is the same picture at every frame. */
  sources() {
    return this.source ? [this.source] : [];
  }
}

function assetName(ref) {
  const match = /^@assets:(.+)$/.exec(String(ref || ""));
  return match ? match[1] : ref;
}
