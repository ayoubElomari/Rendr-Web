/**
 * Time, in the two forms a composition uses.
 *
 * A composition stores placements as timecodes and derives frames from them. That
 * is the whole reason changing the frame rate leaves a file untouched: the same
 * `00:00:05.200` is frame 156 at 30fps and frame 312 at 60. Frames are the
 * runtime's currency; timecodes are the file's.
 */

/** The only shape the format accepts. Anything else is a authoring error. */
const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

const pad = (n, width = 2) => String(Math.trunc(n)).padStart(width, "0");

/** `"00:00:05.200"` → seconds. Throws on anything that isn't the exact shape. */
export function parseTimecode(value) {
  if (typeof value === "number") return value;
  const match = TIMECODE.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error(`Invalid timecode "${value}", expected HH:MM:SS.mmm`);
  }
  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

/** Seconds → `"HH:MM:SS.mmm"`. */
export function formatTimecode(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  return (
    `${pad(total / 3600000)}:` +
    `${pad((total / 60000) % 60)}:` +
    `${pad((total / 1000) % 60)}.` +
    `${pad(total % 1000, 3)}`
  );
}

/**
 * Seconds → frames.
 *
 * Rounded, not floored. A placement authored as `00:00:05.200` at 30fps is
 * exactly 156 frames, but 5.2 × 30 evaluates to 155.99999999999997 in binary
 * floating point, and flooring that puts the element on screen one frame late —
 * a bug that only shows on some timecodes at some frame rates, which is the worst
 * kind to go looking for.
 */
export const framesFromSeconds = (seconds, fps) => Math.round(seconds * fps);

export const secondsFromFrames = (frames, fps) => frames / fps;

/** Frames → the timecode string a file would carry. */
export const timecodeFromFrames = (frames, fps) =>
  formatTimecode(secondsFromFrames(frames, fps));
