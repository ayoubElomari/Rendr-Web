/**
 * What this device can be asked for.
 *
 * Every cache in the runtime takes its ceiling from here rather than from a
 * constant that happened to work on the machine it was written on. The original
 * engine sized its frame cache at ~30% of device memory, which is a reasonable
 * instinct for a renderer that owns the machine and a fatal one for a tab: on a
 * phone reporting 4GB that authorises 1.2GB of decoded frames, and the browser's
 * answer to a tab asking for that is to kill it.
 *
 * The numbers below are deliberately small. A preview needs the frame it is
 * showing and a little runway — not a library of frames it might show later.
 */

/**
 * `navigator.deviceMemory` is coarse (2/4/8, capped at 8) and absent in Safari,
 * where `undefined` lands on the cautious branch. That is the right default: the
 * cost of being conservative is a decode we could have skipped, and the cost of
 * being wrong the other way is the tab dying.
 */
function deviceMemoryGB() {
  if (typeof navigator === "undefined") return 4;
  return navigator.deviceMemory || 4;
}

function hardwareThreads() {
  if (typeof navigator === "undefined") return 4;
  return navigator.hardwareConcurrency || 4;
}

/** Coarse tiers. Everything else is derived from these, so tuning is one place. */
function tierFor(memory, threads) {
  if (memory >= 8 && threads >= 8) return "high";
  if (memory >= 4 && threads >= 4) return "mid";
  return "low";
}

const PROFILES = {
  /* `frameBudgetMB` is the memory one video source may spend on decoded frames
     (RGBA bitmaps, 4 bytes a pixel). The cache holds as many frames as fit:
     about 100 at 720p and 45 at 1080p on `high`. It is the knob to turn for a
     deeper cache, and it is safe to turn, because frames are copied out of the
     decoder and closed at once, so a bigger cache can no longer starve it.

     `lookahead` is how many frames past the one being shown must already be
     cached. Whenever fewer are, the next group is decoded in the background, so
     playback never waits for a decode. The decode is several times faster than
     real time, so this is a head start measured in tenths of a second. */
  high: { lookahead: 16, frameBudgetMB: 384, maxVideoSources: 4, maxCanvasPixels: 4096 * 2304 },
  mid: { lookahead: 8, frameBudgetMB: 192, maxVideoSources: 3, maxCanvasPixels: 2560 * 1440 },
  low: { lookahead: 4, frameBudgetMB: 64, maxVideoSources: 2, maxCanvasPixels: 1920 * 1080 },
};

export function detectCapabilities(overrides = {}) {
  const memory = deviceMemoryGB();
  const threads = hardwareThreads();
  const tier = tierFor(memory, threads);

  return {
    tier,
    memory,
    threads,
    /* WebCodecs is the whole video path. Without it, video elements report a
       clear error rather than the page half-working with no explanation. */
    hasWebCodecs:
      typeof window !== "undefined" &&
      typeof window.VideoDecoder !== "undefined",
    /* A constructable stylesheet lets the runtime own one sheet and rewrite
       rules in it, instead of appending <style> nodes to document.head. */
    hasAdoptedStyleSheets:
      typeof document !== "undefined" &&
      "adoptedStyleSheets" in Document.prototype &&
      typeof CSSStyleSheet !== "undefined" &&
      (() => {
        try {
          new CSSStyleSheet();
          return true;
        } catch {
          return false;
        }
      })(),
    ...PROFILES[tier],
    ...overrides,
  };
}
