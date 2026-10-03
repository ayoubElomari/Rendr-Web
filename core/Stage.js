import { rulesFor } from "../util/css.js";

/**
 * The surface a composition is drawn onto, and the one stylesheet behind it.
 *
 * ── One sheet, not thirty ──────────────────────────────────────────────────
 *
 * The original created a `<style>` node in `document.head` per element and never
 * removed it: thirty per composition, and thirty more on every reboot. Here there
 * is one sheet per runtime instance, rules are keyed by element, and updating an
 * element's styling replaces its rule in place. That is what makes a style edit
 * cost a rule rewrite instead of a remount, and it is what makes teardown
 * complete — one sheet to drop.
 *
 * A constructable `CSSStyleSheet` is used where available (no DOM node at all);
 * otherwise a single `<style>` element, still one, still owned.
 *
 * ── The stage scales; the composition does not ─────────────────────────────
 *
 * A composition is authored in a space that is always 1280 wide, whatever the
 * output resolution — coordinates cannot be in output pixels if one file is to
 * render at 480p and 8K. The stage is that authoring box, transformed to fit
 * whatever the page gives it. `fit` **contains**: filling by width is fine at
 * 16:9 and absurd at 9:16, where it wants twice the viewport's height.
 */
export default class Stage {
  #rules = new Map();
  #sheet = null;
  #styleNode = null;

  constructor(host, { instanceId, capabilities }) {
    this.host = host;
    this.instanceId = instanceId;
    this.capabilities = capabilities;

    this.root = document.createElement("div");
    this.root.className = "rw-stage";
    this.root.style.position = "absolute";
    this.root.style.transformOrigin = "top left";
    /* The frame edge is real: an element placed past the composition's bounds is
       cropped by it, the way the encoder would crop it. */
    this.root.style.overflow = "hidden";
    /**
     * Bound what the stage can cost the compositor.
     *
     * `contain: strict` tells the browser this subtree's layout, style, paint and
     * size never affect anything outside it — so it can be rasterised as a unit
     * and clipped, rather than each layer inside being considered against the
     * whole page. `isolation` keeps blending inside the stage. Both matter most
     * in the tall-frame case, where the authoring box is 1280×2276 and every
     * full-frame element inside it is three times the surface of the same element
     * in a 16:9 cut.
     */
    this.root.style.contain = "strict";
    this.root.style.isolation = "isolate";
    host.appendChild(this.root);

    if (capabilities.hasAdoptedStyleSheets) {
      this.#sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.#sheet];
    } else {
      this.#styleNode = document.createElement("style");
      this.#styleNode.dataset.rendrWeb = instanceId;
      document.head.appendChild(this.#styleNode);
    }
  }

  /** Set the authoring box. Returns `[width, height]` in authoring pixels. */
  resize([width, height]) {
    this.size = [width, height];
    this.root.style.width = `${width}px`;
    this.root.style.height = `${height}px`;
    this.fit();
    return this.size;
  }

  /**
   * Scale the stage to fit its host box, centred, contained.
   *
   * Called on every resize and after every composition change. Leftover space
   * reads as letterboxing, which is what it is.
   */
  fit() {
    if (!this.size) return;
    const [width, height] = this.size;
    const boxWidth = this.host.clientWidth;
    const boxHeight = this.host.clientHeight;

    /**
     * An unmeasurable box must not leave the stage unscaled.
     *
     * This used to return early, which sounds harmless and is not: with no
     * transform written, the stage sits at **1:1**. A 9:16 composition is
     * 1280×2276, so on a phone at 3× device pixels that is a subtree being
     * rasterised at roughly 26 million pixels per layer instead of the ~114,000
     * it is actually shown at — the difference between a picture and a dead tab.
     * The box legitimately measures zero (a hidden ancestor, a layout that has
     * not settled, an element mid-mount), so this is a state that gets reached.
     *
     * Hidden instead: nothing to see until there is somewhere to put it, and the
     * ResizeObserver will call back the moment there is.
     */
    if (!boxWidth || !boxHeight) {
      this.root.style.transform = "scale(0)";
      this.root.style.visibility = "hidden";
      this.scale = 0;
      return;
    }

    const scale = Math.min(boxWidth / width, boxHeight / height);
    const x = (boxWidth - width * scale) / 2;
    const y = (boxHeight - height * scale) / 2;
    this.root.style.visibility = "";
    this.root.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.scale = scale;
  }

  /** Replace one element's rules. Absent or empty removes them. */
  setRules(elementId, styleDef) {
    const css = styleDef ? rulesFor(elementId, styleDef) : "";
    if (this.#rules.get(elementId) === css) return false;
    if (css) this.#rules.set(elementId, css);
    else this.#rules.delete(elementId);
    this.#flush();
    return true;
  }

  removeRules(elementId) {
    if (!this.#rules.delete(elementId)) return;
    this.#flush();
  }

  mount(node) {
    this.root.appendChild(node);
  }

  clear() {
    this.root.replaceChildren();
  }

  destroy() {
    this.#rules.clear();
    this.root.remove();
    if (this.#sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== this.#sheet,
      );
      this.#sheet = null;
    }
    this.#styleNode?.remove();
    this.#styleNode = null;
  }

  /**
   * Rewrite the sheet.
   *
   * Whole-text replacement rather than per-rule CSSOM surgery: the sheets here
   * are a few dozen rules, the browser parses that in well under a millisecond,
   * and index-based rule editing is a class of bug (indices shift under you) that
   * buys nothing at this size. It is only ever called when a rule actually
   * changed — `setRules` compares first.
   */
  #flush() {
    const css = [...this.#rules.values()].join("\n");
    if (this.#sheet) this.#sheet.replaceSync(css);
    else if (this.#styleNode) this.#styleNode.textContent = css;
  }
}
