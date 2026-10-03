import Element from "./Element.js";

/**
 * Text, and — because a div with a background is the cheapest possible shape —
 * every plate, scrim, vignette and rule in a composition.
 *
 * `config.content` may be empty; that is not a broken element, it is a rectangle.
 */
export default class Text extends Element {
  async build() {
    this.textNode = document.createElement("div");
    this.textNode.className = "rw-text-content";
    this.textNode.textContent = this.spec.config.content ?? "";
    this.node.replaceChildren(this.textNode);
    await super.build();
  }

  onConfigChanged() {
    if (this.textNode) {
      this.textNode.textContent = this.spec.config.content ?? "";
    }
  }
}
