/**
 * The composition's reference system.
 *
 * Four kinds, and the differences between them are load-bearing:
 *
 *   `@variables:accent`   a value defined once and used in many places
 *   `@presets:panel`      a style block merged underneath an element's own
 *   `@assets:hook`        media, resolved to a loaded source at build time
 *   `{{param}}`           a component parameter
 *
 * A `@ref` only substitutes when it is the **whole** string. `"2px solid @variables:accent"`
 * passes through untouched and the CSS parser then discards the entire declaration —
 * which is silent, and cost a real debugging round the first time. It is not an
 * oversight to fix here: a `@ref` can resolve to a non-string (an asset object, a
 * number), so substituting it into the middle of a string is not always meaningful.
 * Split shorthands instead.
 *
 * `{{param}}` is the opposite and *does* substitute inline, because a parameter is
 * always scalar. `"calc({{y}}px + 26px)"` is a legitimate and useful thing to write.
 */

const REF = /^@([a-zA-Z][\w-]*):(.+)$/;
const PARAM = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const WHOLE_PARAM = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

/** `"@variables:accent"` → `["variables", "accent"]`, or null. */
export function parseRef(value) {
  if (typeof value !== "string") return null;
  const match = REF.exec(value.trim());
  return match ? [match[1], match[2]] : null;
}

/**
 * Walk any structure, replacing strings.
 *
 * `fn` may return a non-string (an asset object), so this cannot be a string
 * replace — it rebuilds the structure.
 */
export function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

/** Resolve `@<namespace>:<key>` against a table of namespaces. */
export function resolveRefs(value, namespaces) {
  return mapStrings(value, (str) => {
    const ref = parseRef(str);
    if (!ref) return str;
    const [namespace, key] = ref;
    const table = namespaces[namespace];
    if (!table) return str;
    if (!(key in table)) {
      throw new Error(`Unknown ${namespace} reference "@${namespace}:${key}"`);
    }
    return table[key];
  });
}

/** Substitute `{{param}}`, whole-string or inline. */
export function substituteParams(value, params) {
  return mapStrings(value, (str) => {
    const whole = WHOLE_PARAM.exec(str);
    if (whole) {
      const key = whole[1];
      if (!(key in params)) throw new Error(`Missing parameter "${key}"`);
      return params[key];
    }
    if (!PARAM.test(str)) return str;
    PARAM.lastIndex = 0;
    return str.replace(PARAM, (_, key) => {
      if (!(key in params)) throw new Error(`Missing parameter "${key}"`);
      return String(params[key]);
    });
  });
}

/**
 * Merge a preset underneath an element's own styling, per selector.
 *
 * Shallow per selector rather than deep: within one selector the element wins
 * property by property, which is what "the preset is the default" means.
 */
export function mergeStyles(preset, own) {
  const out = { ...preset };
  for (const [selector, styles] of Object.entries(own || {})) {
    out[selector] = { ...(preset?.[selector] || {}), ...styles };
  }
  return out;
}

/** Every `@assets:<key>` a document refers to. */
export function referencedAssets(json) {
  const keys = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      const ref = parseRef(value);
      if (ref && ref[0] === "assets") keys.add(ref[1]);
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(json);
  return keys;
}
