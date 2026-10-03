import { resolveEasing } from "./easings.js"

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interpolate between sorted keyframes at a given progress value (0–1).
 *
 * @param {Array<{ at: string, value: any, easing?: string }>} sortedKeyframes
 * @param {number} progress  0–1
 * @returns {string|number}  interpolated CSS value
 */
export function interpolate(sortedKeyframes, progress) {
    if (!sortedKeyframes?.length) return null

    const first = sortedKeyframes[0]
    const last  = sortedKeyframes.at(-1)

    const firstP = parsePercent(first.at)
    const lastP  = parsePercent(last.at)

    if (progress <= firstP) return first.value
    if (progress >= lastP)  return last.value

    const toIndex = sortedKeyframes.findIndex(kf => parsePercent(kf.at) > progress)
    const from    = sortedKeyframes[toIndex - 1]
    const to      = sortedKeyframes[toIndex]

    const fromP   = parsePercent(from.at)
    const toP     = parsePercent(to.at)
    const t       = (progress - fromP) / (toP - fromP)
    const eased   = from.easing ? resolveEasing(from.easing)(t) : t

    return lerpValue(from.value, to.value, eased)
}

// ─────────────────────────────────────────────────────────────────────────────
// Core dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PORTFOLIO EDIT: exported. `Track` evaluates one segment at a time and needs
 * the value lerp on its own; the whole-track `interpolate()` above re-parses and
 * re-sorts keyframes on every call, which Track does once at construction instead.
 */
export function lerpValue(a, b, t) {
    // Plain numbers
    if (typeof a === "number" && typeof b === "number")
        return lerpNumber(a, b, t)

    // Coerce to strings for everything else
    const sa = String(a).trim()
    const sb = String(b).trim()

    // Keywords / discrete values — snap at midpoint
    if (isKeyword(sa) || isKeyword(sb)) return snap(sa, sb, t)

    // Named colors  →  convert then interpolate
    const ra = resolveColor(sa)
    const rb = resolveColor(sb)
    if (ra && rb) return lerpColor(ra, rb, t)

    // Bare numbers (as strings, e.g. "1.5")
    if (isNumericString(sa) && isNumericString(sb))
        return String(lerpNumber(parseFloat(sa), parseFloat(sb), t))

    // Single value with unit  "12px", "1.5rem", "45deg" …
    const ua = parseUnit(sa)
    const ub = parseUnit(sb)
    if (ua && ub) return lerpUnit(ua, ub, t)

    // CSS functions  translate(…), scale(…), rgb(…), hsl(…) …
    if (isCssFunction(sa) && isCssFunction(sb)) return lerpFunction(sa, sb, t)

    // Transform lists — must be checked BEFORE generic token split because
    // "translate(-50%, -50%) scale(1)" contains spaces but is not a token list
    if (isTransformList(sa) && isTransformList(sb)) return lerpTransformList(sa, sb, t)

    // Multi-token values  "1px solid red", "0px 4px 8px rgba(0,0,0,.5)"
    // Handles shorthand backgrounds, borders, box-shadow, text-shadow, etc.
    if (sa.includes(" ") && sb.includes(" ")) return lerpTokenList(sa, sb, t)

    // Last resort — snap
    return snap(sa, sb, t)
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

function lerpNumber(a, b, t) {
    return a + (b - a) * t
}

function snap(a, b, t) {
    return t < 0.5 ? a : b
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit values  — "12px", "50%", "1.5rem", "360deg", "1fr" …
// ─────────────────────────────────────────────────────────────────────────────

const UNIT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|em|rem|vh|vw|vmin|vmax|dvh|dvw|svh|svw|lvh|lvw|%|deg|rad|turn|grad|s|ms|fr|ch|ex|lh|rlh|vb|vi|cqw|cqh|cqi|cqb|cqmin|cqmax|dpi|dpcm|dppx|Q|mm|cm|in|pt|pc|cap|ic|rcap|rex|rch|ric|rlh|x)$/i

function parseUnit(str) {
    const m = str.match(UNIT_RE)
    if (!m) return null
    return { value: parseFloat(m[1]), unit: m[2].toLowerCase() }
}

function lerpUnit(a, b, t) {
    if (a.unit !== b.unit) {
        // Incompatible units — try px conversion, else snap
        const av = toPx(a)
        const bv = toPx(b)
        if (av !== null && bv !== null)
            return `${lerpNumber(av, bv, t)}px`
        return snap(`${a.value}${a.unit}`, `${b.value}${b.unit}`, t)
    }
    return `${lerpNumber(a.value, b.value, t)}${a.unit}`
}

/** Best-effort absolute-px conversion for common units. */
function toPx({ value, unit }) {
    const map = {
        px: 1, pt: 96 / 72, pc: 16, Q: 96 / 101.6,
        cm: 96 / 2.54, mm: 96 / 25.4, "in": 96,
    }
    return map[unit] != null ? value * map[unit] : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Color
// ─────────────────────────────────────────────────────────────────────────────

/** Returns { r, g, b, a } (0–255 / 0–1) or null. */
function resolveColor(str) {
    // #rgb  #rgba  #rrggbb  #rrggbbaa
    const hex = str.match(/^#([0-9a-f]{3,8})$/i)
    if (hex) return hexToRgba(hex[1])

    // rgb() / rgba()
    const rgb = str.match(/^rgba?\(\s*([\d.%]+)\s*,\s*([\d.%]+)\s*,\s*([\d.%]+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
        || str.match(/^rgba?\(\s*([\d.%]+)\s+([\d.%]+)\s+([\d.%]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/i)
    if (rgb) return {
        r: cssColorChannel(rgb[1], 255),
        g: cssColorChannel(rgb[2], 255),
        b: cssColorChannel(rgb[3], 255),
        a: rgb[4] != null ? parseCssAlpha(rgb[4]) : 1,
    }

    // hsl() / hsla()
    const hsl = str.match(/^hsla?\(\s*([\d.]+(?:deg|rad|turn|grad)?)\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i)
    if (hsl) {
        const h = parseHue(hsl[1])
        const s = parseFloat(hsl[2]) / 100
        const l = parseFloat(hsl[3]) / 100
        const { r, g, b } = hslToRgb(h, s, l)
        return { r, g, b, a: hsl[4] != null ? parseCssAlpha(hsl[4]) : 1 }
    }

    // hwb()
    const hwb = str.match(/^hwb\(\s*([\d.]+(?:deg|rad|turn|grad)?)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.%]+))?\s*\)$/i)
    if (hwb) {
        const { r, g, b } = hwbToRgb(parseHue(hwb[1]), parseFloat(hwb[2]) / 100, parseFloat(hwb[3]) / 100)
        return { r, g, b, a: hwb[4] != null ? parseCssAlpha(hwb[4]) : 1 }
    }

    // oklch() / lch()
    const oklch = str.match(/^oklch\(\s*([\d.%]+)\s+([\d.]+)\s+([\d.]+(?:deg|rad|turn|grad)?)(?:\s*\/\s*([\d.%]+))?\s*\)$/i)
    if (oklch) {
        const { r, g, b } = oklchToRgb(
            parseCssAlpha(oklch[1]), parseFloat(oklch[2]), parseHue(oklch[3]))
        return { r, g, b, a: oklch[4] != null ? parseCssAlpha(oklch[4]) : 1 }
    }

    // Named colors
    const named = NAMED_COLORS[str.toLowerCase()]
    if (named) return hexToRgba(named.slice(1))

    return null
}

function cssColorChannel(str, max) {
    if (str.endsWith("%")) return parseFloat(str) / 100 * max
    return parseFloat(str)
}

function parseCssAlpha(str) {
    if (str == null) return 1
    if (str.endsWith("%")) return parseFloat(str) / 100
    return parseFloat(str)
}

function parseHue(str) {
    str = String(str)
    if (str.endsWith("rad"))  return parseFloat(str) * 180 / Math.PI
    if (str.endsWith("turn")) return parseFloat(str) * 360
    if (str.endsWith("grad")) return parseFloat(str) * 0.9
    return parseFloat(str)
}

function hexToRgba(hex) {
    let r, g, b, a = 255
    if (hex.length === 3 || hex.length === 4) {
        r = parseInt(hex[0] + hex[0], 16)
        g = parseInt(hex[1] + hex[1], 16)
        b = parseInt(hex[2] + hex[2], 16)
        if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16)
    } else if (hex.length === 6 || hex.length === 8) {
        r = parseInt(hex.slice(0, 2), 16)
        g = parseInt(hex.slice(2, 4), 16)
        b = parseInt(hex.slice(4, 6), 16)
        if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16)
    } else return null
    return { r, g, b, a: a / 255 }
}

function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs((h / 60) % 2 - 1))
    const m = l - c / 2
    let r = 0, g = 0, b = 0
    if      (h < 60)  { r = c; g = x }
    else if (h < 120) { r = x; g = c }
    else if (h < 180) { g = c; b = x }
    else if (h < 240) { g = x; b = c }
    else if (h < 300) { r = x; b = c }
    else              { r = c; b = x }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

function hwbToRgb(h, w, bk) {
    const sum = w + bk
    if (sum > 1) { w /= sum; bk /= sum }
    const base = hslToRgb(h, 1, 0.5)
    return {
        r: Math.round(base.r / 255 * (1 - w - bk) * 255 + w * 255),
        g: Math.round(base.g / 255 * (1 - w - bk) * 255 + w * 255),
        b: Math.round(base.b / 255 * (1 - w - bk) * 255 + w * 255),
    }
}

// oklch → linear sRGB → gamma sRGB (simplified but correct for most values)
function oklchToRgb(L, C, h) {
    const a = C * Math.cos(h * Math.PI / 180)
    const bv = C * Math.sin(h * Math.PI / 180)
    // OKLab → XYZ → linear sRGB
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * bv) ** 3
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * bv) ** 3
    const s_ = (L - 0.0894841775 * a - 1.2914855480 * bv) ** 3
    const lr =  4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
    const lg = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
    const lb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
    const gamma = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return {
        r: Math.round(clamp01(gamma(lr)) * 255),
        g: Math.round(clamp01(gamma(lg)) * 255),
        b: Math.round(clamp01(gamma(lb)) * 255),
    }
}

function lerpColor(a, b, t) {
    const r = Math.round(lerpNumber(a.r, b.r, t))
    const g = Math.round(lerpNumber(a.g, b.g, t))
    const bCh = Math.round(lerpNumber(a.b, b.b, t))
    const al  = lerpNumber(a.a, b.a, t)
    if (al >= 1 - 1e-4) return `rgb(${r},${g},${bCh})`
    return `rgba(${r},${g},${bCh},${+al.toFixed(4)})`
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS function values  — rgb(), hsl(), translate(), rotate(), …
// ─────────────────────────────────────────────────────────────────────────────

const CSS_FN_RE = /^([\w-]+)\((.+)\)$/s

function isCssFunction(str) { return CSS_FN_RE.test(str) }

function lerpFunction(sa, sb, t) {
    const ma = sa.match(CSS_FN_RE)
    const mb = sb.match(CSS_FN_RE)
    if (!ma || !mb) return snap(sa, sb, t)

    const fnA = ma[1].toLowerCase()
    const fnB = mb[1].toLowerCase()

    // Color functions — already handled via resolveColor, but just in case
    if (fnA === fnB && (fnA === "rgb" || fnA === "rgba" || fnA === "hsl"
            || fnA === "hsla" || fnA === "hwb" || fnA === "oklch" || fnA === "lch"
            || fnA === "lab" || fnA === "oklab" || fnA === "color")) {
        const ca = resolveColor(sa)
        const cb = resolveColor(sb)
        if (ca && cb) return lerpColor(ca, cb, t)
    }

    // Same function — interpolate args
    if (fnA === fnB) {
        const argsA = splitFunctionArgs(ma[2])
        const argsB = splitFunctionArgs(mb[2])
        if (argsA.length !== argsB.length) return snap(sa, sb, t)
        const args = argsA.map((a, i) => lerpValue(a.trim(), argsB[i].trim(), t))
        return `${fnA}(${args.join(", ")})`
    }

    // Different functions — try color conversion, else snap
    const ca = resolveColor(sa)
    const cb = resolveColor(sb)
    if (ca && cb) return lerpColor(ca, cb, t)
    return snap(sa, sb, t)
}

/**
 * Split CSS function arguments respecting nested parens.
 * "translate(10px, calc(100% - 5px))" → ["10px", " calc(100% - 5px)"]
 */
function splitFunctionArgs(str) {
    const parts = []
    let depth = 0, start = 0
    for (let i = 0; i < str.length; i++) {
        if (str[i] === "(") depth++
        else if (str[i] === ")") depth--
        else if (str[i] === "," && depth === 0) {
            parts.push(str.slice(start, i))
            start = i + 1
        }
    }
    parts.push(str.slice(start))
    return parts
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-token / space-separated values
// Covers: transform lists, box-shadow, text-shadow, background shorthand,
//         border shorthand, grid-template, transition, filter, etc.
// ─────────────────────────────────────────────────────────────────────────────

function lerpTokenList(sa, sb, t) {
    // Special-case: shadow list  "0 2px 4px rgba(0,0,0,.2), 0 4px 8px …"
    if (isShadowList(sa) && isShadowList(sb))
        return lerpShadowList(sa, sb, t)

    // Generic: tokenise and pair up — use lerpLeaf to prevent re-entering
    // lerpTokenList (avoids stack overflow on non-transform space-separated values)
    const tokA = tokenizeValue(sa)
    const tokB = tokenizeValue(sb)

    if (tokA.length !== tokB.length) return snap(sa, sb, t)
    return tokA.map((a, i) => lerpLeaf(a, tokB[i], t)).join(" ")
}

/**
 * Like lerpValue but never recurses into lerpTokenList.
 * Used for individual tokens inside a space-separated list so we don't
 * accidentally re-enter the list path on a bare token.
 */
function lerpLeaf(a, b, t) {
    if (typeof a === "number" && typeof b === "number") return lerpNumber(a, b, t)
    const sa = String(a).trim()
    const sb = String(b).trim()
    if (isKeyword(sa) || isKeyword(sb)) return snap(sa, sb, t)
    const ra = resolveColor(sa)
    const rb = resolveColor(sb)
    if (ra && rb) return lerpColor(ra, rb, t)
    if (isNumericString(sa) && isNumericString(sb))
        return String(lerpNumber(parseFloat(sa), parseFloat(sb), t))
    const ua = parseUnit(sa)
    const ub = parseUnit(sb)
    if (ua && ub) return lerpUnit(ua, ub, t)
    if (isCssFunction(sa) && isCssFunction(sb)) return lerpFunction(sa, sb, t)
    return snap(sa, sb, t)
}

// ── Transforms ───────────────────────────────────────────────────────────────

const TRANSFORM_FN_RE = /^(matrix|matrix3d|perspective|rotate|rotateX|rotateY|rotateZ|rotate3d|scale|scaleX|scaleY|scaleZ|scale3d|skew|skewX|skewY|translate|translateX|translateY|translateZ|translate3d)\s*\(/i

function isTransformList(str) {
    if (str === "none") return true
    // Must start with a known transform fn — the key fix is we test the
    // raw string, NOT after tokenising on spaces, because args can contain spaces
    if (!TRANSFORM_FN_RE.test(str.trim())) return false
    // Verify every top-level token (split by space outside parens) is a transform fn
    const fns = parseTransformList(str)
    return fns.length > 0
}

function lerpTransformList(sa, sb, t) {
    if (sa === "none" && sb === "none") return "none"

    const listA = parseTransformList(sa === "none" ? "" : sa)
    const listB = parseTransformList(sb === "none" ? "" : sb)

    // Merge: add identity transforms for missing fns so lists align
    const merged = mergeTransformLists(listA, listB)

    return merged.map(({ fn, argsA, argsB }) => {
        const args = argsA.map((a, i) => lerpValue(a.trim(), argsB[i].trim(), t))
        return `${fn}(${args.join(", ")})`
    }).join(" ")
}

function parseTransformList(str) {
    const result = []
    const fnRe = /([\w]+)\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g  // allow nested
    let m
    while ((m = fnRe.exec(str)) !== null) {
        result.push({ fn: m[1], args: splitFunctionArgs(m[2]).map(s => s.trim()) })
    }
    return result
}

/** Merge two transform lists; fill missing transforms with identity values. */
function mergeTransformLists(listA, listB) {
    // Build maps keyed by fn name (first occurrence wins)
    const build = list => {
        const map = new Map()
        list.forEach(item => {
            if (!map.has(item.fn)) map.set(item.fn, item.args)
        })
        return map
    }
    const mapA = build(listA)
    const mapB = build(listB)

    const allFns = [...new Set([...mapA.keys(), ...mapB.keys()])]
    return allFns.map(fn => {
        const argsA = mapA.get(fn) ?? identityArgs(fn, (mapB.get(fn) ?? []).length)
        const argsB = mapB.get(fn) ?? identityArgs(fn, argsA.length)
        return { fn, argsA, argsB }
    })
}

function identityArgs(fn, count) {
    const name = fn.toLowerCase()
    const scaleIdentity = () => Array(count).fill("1")
    const zeroIdentity  = () => Array(count).fill("0")
    if (name.startsWith("scale"))      return scaleIdentity()
    if (name.startsWith("translate"))  return zeroIdentity()
    if (name.startsWith("rotate"))     return zeroIdentity()
    if (name.startsWith("skew"))       return zeroIdentity()
    if (name === "perspective")        return ["0px"]
    if (name === "matrix")             return ["1","0","0","1","0","0"]
    if (name === "matrix3d")
        return ["1","0","0","0","0","1","0","0","0","0","1","0","0","0","0","1"]
    return zeroIdentity()
}

// ── Shadows ───────────────────────────────────────────────────────────────────

function isShadowList(str) {
    // Crude check: contains px and not a transform
    return /\d+px/.test(str) && !TRANSFORM_FN_RE.test(str.trim())
}

function lerpShadowList(sa, sb, t) {
    const a = parseShadowList(sa)
    const b = parseShadowList(sb)
    const len = Math.max(a.length, b.length)
    const result = []
    for (let i = 0; i < len; i++) {
        const ai = a[i] ?? nullShadow()
        const bi = b[i] ?? nullShadow()
        result.push(lerpSingleShadow(ai, bi, t))
    }
    return result.join(", ")
}

/**
 * Parse a comma-separated shadow list, respecting nested parens (for rgba/etc).
 */
function parseShadowList(str) {
    const shadows = []
    let depth = 0, start = 0
    for (let i = 0; i < str.length; i++) {
        if (str[i] === "(") depth++
        else if (str[i] === ")") depth--
        else if (str[i] === "," && depth === 0) {
            shadows.push(str.slice(start, i).trim())
            start = i + 1
        }
    }
    shadows.push(str.slice(start).trim())
    return shadows.map(parseSingleShadow)
}

/**
 * Parse a single shadow token into structured parts.
 * format: [inset] <x> <y> [blur] [spread] [color]
 */
function parseSingleShadow(str) {
    const tokens = tokenizeValue(str)
    let inset = false
    const lengths = []
    let color = null

    for (const tok of tokens) {
        if (tok.toLowerCase() === "inset") { inset = true; continue }
        const c = resolveColor(tok)
        if (c) { color = c; continue }
        if (parseUnit(tok) || isNumericString(tok)) lengths.push(tok)
    }

    return { inset, x: lengths[0] ?? "0px", y: lengths[1] ?? "0px",
             blur: lengths[2] ?? "0px", spread: lengths[3] ?? "0px",
             color: color ?? { r: 0, g: 0, b: 0, a: 0 } }
}

function nullShadow() {
    return { inset: false, x: "0px", y: "0px", blur: "0px", spread: "0px",
             color: { r: 0, g: 0, b: 0, a: 0 } }
}

function lerpSingleShadow(a, b, t) {
    const inset  = t < 0.5 ? a.inset : b.inset
    const x      = lerpValue(a.x,      b.x,      t)
    const y      = lerpValue(a.y,      b.y,      t)
    const blur   = lerpValue(a.blur,   b.blur,   t)
    const spread = lerpValue(a.spread, b.spread, t)
    const color  = lerpColor(a.color,  b.color,  t)
    const parts  = [inset ? "inset" : null, x, y, blur, spread, color].filter(Boolean)
    return parts.join(" ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokeniser — splits a CSS value into tokens, respecting nested parens
// ─────────────────────────────────────────────────────────────────────────────

function tokenizeValue(str) {
    const tokens = []
    let depth = 0, cur = ""
    for (let i = 0; i < str.length; i++) {
        const ch = str[i]
        if (ch === "(") { depth++; cur += ch }
        else if (ch === ")") { depth--; cur += ch }
        else if (ch === " " && depth === 0) {
            if (cur) { tokens.push(cur); cur = "" }
        } else {
            cur += ch
        }
    }
    if (cur) tokens.push(cur)
    return tokens
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parsePercent(str) { return parseFloat(str) / 100 }

function isNumericString(str) { return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(str) }

const DISCRETE_KEYWORDS = new Set([
    "auto", "none", "inherit", "initial", "unset", "revert", "normal",
    "bold", "italic", "oblique", "underline", "overline", "line-through",
    "left", "right", "center", "top", "bottom", "middle",
    "absolute", "relative", "fixed", "sticky", "static",
    "block", "inline", "flex", "grid", "inline-flex", "inline-grid",
    "row", "column", "row-reverse", "column-reverse",
    "wrap", "nowrap", "wrap-reverse",
    "visible", "hidden", "scroll", "clip",
    "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset",
    "ease", "linear", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end",
    "start", "end", "stretch", "baseline",
    "uppercase", "lowercase", "capitalize", "normal",
    "pointer", "default", "crosshair", "move", "text", "wait", "not-allowed",
    "currentcolor", "transparent",
])

function isKeyword(str) {
    return DISCRETE_KEYWORDS.has(str.toLowerCase())
        || !/\d/.test(str) && /^[a-z-]+$/i.test(str)
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }

// ─────────────────────────────────────────────────────────────────────────────
// Named colors (CSS Level 4 full list)
// ─────────────────────────────────────────────────────────────────────────────

const NAMED_COLORS = {
    aliceblue:"#f0f8ff",antiquewhite:"#faebd7",aqua:"#00ffff",aquamarine:"#7fffd4",
    azure:"#f0ffff",beige:"#f5f5dc",bisque:"#ffe4c4",black:"#000000",
    blanchedalmond:"#ffebcd",blue:"#0000ff",blueviolet:"#8a2be2",brown:"#a52a2a",
    burlywood:"#deb887",cadetblue:"#5f9ea0",chartreuse:"#7fff00",chocolate:"#d2691e",
    coral:"#ff7f50",cornflowerblue:"#6495ed",cornsilk:"#fff8dc",crimson:"#dc143c",
    cyan:"#00ffff",darkblue:"#00008b",darkcyan:"#008b8b",darkgoldenrod:"#b8860b",
    darkgray:"#a9a9a9",darkgreen:"#006400",darkgrey:"#a9a9a9",darkkhaki:"#bdb76b",
    darkmagenta:"#8b008b",darkolivegreen:"#556b2f",darkorange:"#ff8c00",
    darkorchid:"#9932cc",darkred:"#8b0000",darksalmon:"#e9967a",darkseagreen:"#8fbc8f",
    darkslateblue:"#483d8b",darkslategray:"#2f4f4f",darkslategrey:"#2f4f4f",
    darkturquoise:"#00ced1",darkviolet:"#9400d3",deeppink:"#ff1493",
    deepskyblue:"#00bfff",dimgray:"#696969",dimgrey:"#696969",dodgerblue:"#1e90ff",
    firebrick:"#b22222",floralwhite:"#fffaf0",forestgreen:"#228b22",fuchsia:"#ff00ff",
    gainsboro:"#dcdcdc",ghostwhite:"#f8f8ff",gold:"#ffd700",goldenrod:"#daa520",
    gray:"#808080",green:"#008000",greenyellow:"#adff2f",grey:"#808080",
    honeydew:"#f0fff0",hotpink:"#ff69b4",indianred:"#cd5c5c",indigo:"#4b0082",
    ivory:"#fffff0",khaki:"#f0e68c",lavender:"#e6e6fa",lavenderblush:"#fff0f5",
    lawngreen:"#7cfc00",lemonchiffon:"#fffacd",lightblue:"#add8e6",lightcoral:"#f08080",
    lightcyan:"#e0ffff",lightgoldenrodyellow:"#fafad2",lightgray:"#d3d3d3",
    lightgreen:"#90ee90",lightgrey:"#d3d3d3",lightpink:"#ffb6c1",lightsalmon:"#ffa07a",
    lightseagreen:"#20b2aa",lightskyblue:"#87cefa",lightslategray:"#778899",
    lightslategrey:"#778899",lightsteelblue:"#b0c4de",lightyellow:"#ffffe0",
    lime:"#00ff00",limegreen:"#32cd32",linen:"#faf0e6",magenta:"#ff00ff",
    maroon:"#800000",mediumaquamarine:"#66cdaa",mediumblue:"#0000cd",
    mediumorchid:"#ba55d3",mediumpurple:"#9370db",mediumseagreen:"#3cb371",
    mediumslateblue:"#7b68ee",mediumspringgreen:"#00fa9a",mediumturquoise:"#48d1cc",
    mediumvioletred:"#c71585",midnightblue:"#191970",mintcream:"#f5fffa",
    mistyrose:"#ffe4e1",moccasin:"#ffe4b5",navajowhite:"#ffdead",navy:"#000080",
    oldlace:"#fdf5e6",olive:"#808000",olivedrab:"#6b8e23",orange:"#ffa500",
    orangered:"#ff4500",orchid:"#da70d6",palegoldenrod:"#eee8aa",palegreen:"#98fb98",
    paleturquoise:"#afeeee",palevioletred:"#db7093",papayawhip:"#ffefd5",
    peachpuff:"#ffdab9",peru:"#cd853f",pink:"#ffc0cb",plum:"#dda0dd",
    powderblue:"#b0e0e6",purple:"#800080",rebeccapurple:"#663399",red:"#ff0000",
    rosybrown:"#bc8f8f",royalblue:"#4169e1",saddlebrown:"#8b4513",salmon:"#fa8072",
    sandybrown:"#f4a460",seagreen:"#2e8b57",seashell:"#fff5ee",sienna:"#a0522d",
    silver:"#c0c0c0",skyblue:"#87ceeb",slateblue:"#6a5acd",slategray:"#708090",
    slategrey:"#708090",snow:"#fffafa",springgreen:"#00ff7f",steelblue:"#4682b4",
    tan:"#d2b48c",teal:"#008080",thistle:"#d8bfd8",tomato:"#ff6347",
    turquoise:"#40e0d0",violet:"#ee82ee",wheat:"#f5deb3",white:"#ffffff",
    whitesmoke:"#f5f5f5",yellow:"#ffff00",yellowgreen:"#9acd32",
    transparent:"#00000000",
}