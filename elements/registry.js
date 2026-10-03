import Caption from "./Caption.js";
import Image from "./Image.js";
import Text from "./Text.js";
import Video from "./Video.js";

/**
 * Type name → class.
 *
 * Lower-cased on lookup, because a composition is written by a person and
 * `"Video"` and `"video"` should not be different element types.
 *
 * Registering is the whole extension point: a new element is a class with
 * `build`/`draw` and a line here. Nothing else in the runtime knows the list.
 */
const registry = new Map([
  ["text", Text],
  ["image", Image],
  ["video", Video],
  ["caption", Caption],
]);

export function resolveElementType(type) {
  const ElementClass = registry.get(String(type).toLowerCase());
  if (!ElementClass) {
    throw new Error(
      `Unknown element type "${type}". Known types: ${[...registry.keys()].join(", ")}`,
    );
  }
  return ElementClass;
}

/** For a host that wants to offer "add an element" without hardcoding a list. */
export function elementTypes() {
  return [...registry.keys()];
}

export function registerElementType(name, ElementClass) {
  registry.set(String(name).toLowerCase(), ElementClass);
}
