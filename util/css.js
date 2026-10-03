/**
 * Style declarations → CSS text.
 *
 * The runtime writes one stylesheet per instance and rewrites individual rules in
 * place (see `core/Stage.js`). The original engine appended one `<style>` node per
 * element to `document.head` and left them there, which is how a page ended up
 * with thirty of them per composition and more on every reboot.
 */

/** `backgroundImage` → `background-image`; `--custom` is passed through. */
export function toCssProperty(key) {
  if (key.startsWith("--")) return key;
  return key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/**
 * A declaration block, skipping animated properties.
 *
 * A value that is an object is a keyframe track, not a value — it belongs to the
 * animation layer, which writes it to the node's inline style per frame. Emitting
 * it here would put `[object Object]` in the sheet.
 */
export function declarations(styles) {
  let out = "";
  for (const [key, value] of Object.entries(styles || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    out += `${toCssProperty(key)}:${value};`;
  }
  return out;
}

/**
 * An element's style block → CSS rules scoped to its own id.
 *
 * `&` is the element itself; anything else is a descendant selector, which is how
 * a composition styles the parts an element builds (`.cap-word`, `img`, `canvas`).
 * Selectors are authored, not user input, but they are still scoped to one id so
 * one element's styling can never reach another's subtree.
 */
export function rulesFor(elementId, styleDef) {
  const scope = `#${elementId}`;
  let css = "";
  for (const [rawSelector, styles] of Object.entries(styleDef || {})) {
    const body = declarations(styles);
    if (!body) continue;
    const selector = rawSelector.includes("&")
      ? rawSelector.replace(/&/g, scope)
      : `${scope} ${rawSelector}`;
    css += `${selector}{${body}}`;
  }
  return css;
}

/** Every animated property in a style block, as `[selector, property, track]`. */
export function animatedTracks(styleDef) {
  const found = [];
  for (const [selector, styles] of Object.entries(styleDef || {})) {
    for (const [property, value] of Object.entries(styles || {})) {
      if (value && typeof value === "object" && Array.isArray(value.keyframes)) {
        found.push([selector, property, value]);
      }
    }
  }
  return found;
}
