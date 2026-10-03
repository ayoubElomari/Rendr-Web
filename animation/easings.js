// ─── linear ───────────────────────────────────────────────────────────────────

const linear = t => t

// ─── sine ─────────────────────────────────────────────────────────────────────

const easeInSine     = t => 1 - Math.cos(t * Math.PI / 2)
const easeOutSine    = t => Math.sin(t * Math.PI / 2)
const easeInOutSine  = t => -(Math.cos(Math.PI * t) - 1) / 2

// ─── quad ─────────────────────────────────────────────────────────────────────

const easeInQuad     = t => t * t
const easeOutQuad    = t => 1 - (1 - t) ** 2
const easeInOutQuad  = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2

// ─── cubic ────────────────────────────────────────────────────────────────────

const easeInCubic    = t => t * t * t
const easeOutCubic   = t => 1 - (1 - t) ** 3
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

// ─── quart ────────────────────────────────────────────────────────────────────

const easeInQuart    = t => t * t * t * t
const easeOutQuart   = t => 1 - (1 - t) ** 4
const easeInOutQuart = t => t < 0.5 ? 8 * t * t * t * t : 1 - (-2 * t + 2) ** 4 / 2

// ─── quint ────────────────────────────────────────────────────────────────────

const easeInQuint    = t => t * t * t * t * t
const easeOutQuint   = t => 1 - (1 - t) ** 5
const easeInOutQuint = t => t < 0.5 ? 16 * t * t * t * t * t : 1 - (-2 * t + 2) ** 5 / 2

// ─── expo ─────────────────────────────────────────────────────────────────────

const easeInExpo     = t => t === 0 ? 0 : 2 ** (10 * t - 10)
const easeOutExpo    = t => t === 1 ? 1 : 1 - 2 ** (-10 * t)
const easeInOutExpo  = t => {
    if (t === 0) return 0
    if (t === 1) return 1
    return t < 0.5
        ? 2 ** (20 * t - 10) / 2
        : (2 - 2 ** (-20 * t + 10)) / 2
}

// ─── circ ─────────────────────────────────────────────────────────────────────

const easeInCirc     = t => 1 - Math.sqrt(1 - t * t)
const easeOutCirc    = t => Math.sqrt(1 - (t - 1) ** 2)
const easeInOutCirc  = t => t < 0.5
    ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
    : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2

// ─── back ─────────────────────────────────────────────────────────────────────
// overshoots slightly before settling — good for elements snapping into place

const BACK_C1 = 1.70158
const BACK_C2 = BACK_C1 * 1.525
const BACK_C3 = BACK_C1 + 1

const easeInBack     = t => BACK_C3 * t * t * t - BACK_C1 * t * t
const easeOutBack    = t => 1 + BACK_C3 * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2
const easeInOutBack  = t => t < 0.5
    ? ((2 * t) ** 2 * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
    : ((2 * t - 2) ** 2 * ((BACK_C2 + 1) * (2 * t - 2) + BACK_C2) + 2) / 2

// ─── elastic ──────────────────────────────────────────────────────────────────
// spring-like — oscillates past the target before settling
// produces values outside 0-1, interpolator must not clamp

const ELASTIC_C4 = (2 * Math.PI) / 3
const ELASTIC_C5 = (2 * Math.PI) / 4.5

const easeInElastic  = t => {
    if (t === 0) return 0
    if (t === 1) return 1
    return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ELASTIC_C4)
}

const easeOutElastic = t => {
    if (t === 0) return 0
    if (t === 1) return 1
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1
}

const easeInOutElastic = t => {
    if (t === 0) return 0
    if (t === 1) return 1
    return t < 0.5
        ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2
        :  (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1
}

// ─── bounce ───────────────────────────────────────────────────────────────────
// simulates a bouncing ball — always stays within 0-1

function easeOutBounce(t) {
    const n1 = 7.5625
    const d1 = 2.75
    if (t < 1 / d1)        return n1 * t * t
    if (t < 2 / d1)        return n1 * (t -= 1.5   / d1) * t + 0.75
    if (t < 2.5 / d1)      return n1 * (t -= 2.25  / d1) * t + 0.9375
    return                         n1 * (t -= 2.625 / d1) * t + 0.984375
}

const easeInBounce    = t => 1 - easeOutBounce(1 - t)
const easeInOutBounce = t => t < 0.5
    ? (1 - easeOutBounce(1 - 2 * t)) / 2
    : (1 + easeOutBounce(2 * t - 1)) / 2

// ─── steps ────────────────────────────────────────────────────────────────────
// discrete jumps — useful for sprite sheets, typewriter effects, etc.
// steps(n, 'start') jumps at the beginning of each interval
// steps(n, 'end')   jumps at the end   of each interval (default, matches CSS)

function steps(n, direction = 'end') {
    return t => {
        if (t === 0) return 0
        if (t === 1) return 1
        const step = Math.floor(t * n)
        return direction === 'start'
            ? Math.min(step + 1, n) / n
            : step / n
    }
}

// ─── cubic bezier ─────────────────────────────────────────────────────────────
// matches CSS cubic-bezier(x1, y1, x2, y2) exactly
// use this to match any CSS transition you want to replicate

function cubicBezier(x1, y1, x2, y2) {
    return function (t) {
        if (t === 0 || t === 1) return t
        // newton-raphson to solve for the bezier t that gives us our input t
        let bt = t
        for (let i = 0; i < 8; i++) {
            const slope = bezierSlope(bt, x1, x2)
            if (Math.abs(slope) < 1e-6) break
            bt -= (bezierAxis(bt, x1, x2) - t) / slope
        }
        return bezierAxis(bt, y1, y2)
    }
}

function bezierAxis(t, p1, p2) {
    return 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3
}

function bezierSlope(t, p1, p2) {
    return 3 * (1 - t) ** 2 * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t ** 2 * (1 - p2)
}

// ─── registry ─────────────────────────────────────────────────────────────────

export const easings = {
    linear,

    easeInSine,    easeOutSine,    easeInOutSine,
    easeInQuad,    easeOutQuad,    easeInOutQuad,
    easeInCubic,   easeOutCubic,   easeInOutCubic,
    easeInQuart,   easeOutQuart,   easeInOutQuart,
    easeInQuint,   easeOutQuint,   easeInOutQuint,
    easeInExpo,    easeOutExpo,    easeInOutExpo,
    easeInCirc,    easeOutCirc,    easeInOutCirc,
    easeInBack,    easeOutBack,    easeInOutBack,
    easeInElastic, easeOutElastic, easeInOutElastic,
    easeInBounce,  easeOutBounce,  easeInOutBounce,

    // factory functions — call to produce a configured easing function
    steps,
    cubicBezier
}

// ─── utils ────────────────────────────────────────────────────────────────────

// resolves either a string key ("easeOutCubic") or a factory call descriptor
// { fn: "cubicBezier", args: [0.4, 0, 0.2, 1] }
export function resolveEasing(value) {
    if (!value) return linear

    if (typeof value === 'string') {
        const fn = easings[value]
        if (!fn) throw new Error(`Unknown easing "${value}"`)
        return fn
    }

    if (typeof value === 'object' && value.fn) {
        const factory = easings[value.fn]
        if (typeof factory !== 'function')
            throw new Error(`"${value.fn}" is not a factory easing`)
        return factory(...(value.args ?? []))
    }

    throw new Error(`Invalid easing value: ${JSON.stringify(value)}`)
}

/* PORTFOLIO EDIT: a default export, so `Track` can take the whole table and
   look an easing name up without importing every function by name. */
export default easings;
