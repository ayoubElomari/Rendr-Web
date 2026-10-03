import Element from "./Element.js";

/**
 * How long the highlight takes to travel from one word to the next.
 *
 * An upper bound, not a fixed duration — see `#moveFrames`. Words in real speech
 * are often closer together than this, and a move that outlasts the gap means the
 * highlight is *always* in flight and never at rest, which is most of what reads
 * as unsettled.
 */
const MOVE_SECONDS = 0.2;

/**
 * The most of a word's own time the move may occupy.
 *
 * The rest is the highlight sitting still on the word being spoken, which is the
 * state a caption is actually communicating. Motion is the transition between
 * readings, so it has to finish well before the next one starts.
 */
const MOVE_GAP_FRACTION = 0.55;

/** Stretch along the direction of travel, and thinning across it, at peak speed. */
const SQUASH_X = 0.18;
const SQUASH_Y = 0.12;

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Symmetric ease — slow at both ends, fastest in the middle.
 *
 * Paired deliberately with a `sin(πt)` squash, because that curve *is* this
 * easing's velocity profile: the highlight deforms exactly when it is moving
 * fastest and is undeformed at both ends. The previous pairing was an
 * ease-*out* (fastest at the start) with the same symmetric squash, so it
 * stretched hardest at the midpoint of `t` — by which point an ease-out is
 * already 87% of the way there and visibly slowing. The distortion arrived after
 * the movement, which is the specific thing that looked wrong.
 */
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Word-synced captions.
 *
 * Rebuilt from the `CaptionElement` in Rendr 1.3.1 — the element that carried 225
 * published videos and which the newer rewrite had no equivalent of. Kept close
 * to it in behaviour and deliberately unlike it in cost: that version rebuilt
 * `innerHTML` every frame, for every caption on screen, and called
 * `getComputedStyle` inside that loop to fit overflowing lines. Affordable when
 * rendering offline; not affordable at 60fps in a tab.
 *
 * Here the spans are built once per *card*, and a frame that stays inside its
 * card does two class writes and one custom-property write.
 *
 * ── Authoring ──────────────────────────────────────────────────────────────
 *
 *   "words":      "This frame was never filmed.",
 *   "timestamps": "0 0.28 0.6 0.86 1.3"
 *
 *   "words": "This[0] frame[0.28] was[0.6] never[0.86] filmed.[1.3]"
 *
 * The first is what a forced aligner emits — two parallel lists. The second is
 * for writing by hand, where keeping each time beside its own word is the
 * difference between editing a line and recounting two lists to find the column
 * that drifted. Times are seconds from the element's start, so moving it retimes
 * nothing.
 *
 * ── What it emits ──────────────────────────────────────────────────────────
 *
 * Structure and state, never appearance:
 *
 *   `.cap-line > .cap-word`   the words of the current card
 *   `.cap-marker`             one plate that travels between them
 *   `.is-live`                on the word currently being spoken
 *   `--cap-on`                per word, 0→1: how much of the plate is under it
 *
 * `--cap-on` is the interesting one. It is a number, and the composition decides
 * what a number between two words means — here, a mix between the light ink and
 * the dark. The element knows neither colour. Every decision about how any of
 * this *looks* stays in the file, which is the premise of the format.
 */
export default class Caption extends Element {
  async build() {
    this.line = document.createElement("div");
    this.line.className = "cap-line";

    /**
     * The highlight is one element that travels, not a background that moves
     * from word to word.
     *
     * A per-word background snaps: it vanishes from one box and appears in
     * another, and at reading speed that reads as flicker. A single plate that
     * slides has continuity.
     *
     * The slide is computed every frame from `relative` in `#placeMarker` — a
     * lerp between the previous word's box and the current one, the same way a
     * keyframed style property is evaluated. It is deliberately **not** a CSS
     * transition or a Web Animations call, both of which run on wall-clock time:
     * the marker's position would then depend on when the browser started
     * animating rather than on which frame was asked for, and scrubbing to the
     * same frame twice could show two different pictures. See `#placeMarker`.
     *
     * It squashes along the way, by an amount proportional to how far it is
     * travelling: a jump to the next word barely deforms, a jump back to the
     * start of a line stretches and recovers. That is the oldest trick in
     * animation, and here it is a function of progress `t`, not of elapsed
     * milliseconds — `sin(πt)`, so it is zero at both ends and widest halfway.
     */
    this.marker = document.createElement("div");
    this.marker.className = "cap-marker";
    this.marker.setAttribute("aria-hidden", "true");
    this.line.appendChild(this.marker);

    this.node.replaceChildren(this.line);
    this.#reset();
    await super.build();
  }

  onConfigChanged() {
    this.#reset();
  }

  async draw(relative) {
    /* Word times are authored in **seconds** and cached as frames, so every one
       of them is wrong the moment the composition's frame rate changes. That is
       not a config change — the element's own `config` is untouched — so nothing
       else would notice, and the captions would silently keep 60fps timings on a
       240fps composition: words landing four times too early and cards changing
       at the wrong moments. Rebuilt here because this is the first place that
       knows the new rate. */
    if (this.builtFps !== this.context.fps) this.#reset();
    if (!this.groups?.length) return;

    const groupIndex = this.#groupAt(relative);
    if (groupIndex !== this.liveGroup) {
      this.#renderGroup(groupIndex);
      this.liveGroup = groupIndex;
      this.liveWord = -1;
    }
    if (groupIndex < 0) return;

    const group = this.groups[groupIndex];
    const wordIndex = this.#wordAt(group, relative);

    if (wordIndex !== this.liveWord) {
      this.spans[this.liveWord]?.classList.remove("is-live");
      this.spans[wordIndex]?.classList.add("is-live");
      this.liveWord = wordIndex;
    }

    if (wordIndex >= 0) this.#placeMarker(group, wordIndex, relative);
  }

  /**
   * The highlight's position at this frame, computed from this frame.
   *
   * Everything here is derived from `relative` and nothing is remembered between
   * calls, which is the whole point. The first version used a CSS transition and
   * a Web Animations impulse — both of which run on **wall-clock time**, so the
   * marker's position depended on when the browser happened to start animating
   * rather than on which frame was being drawn. That breaks the one promise this
   * runtime makes: ask for frame N twice and get the same picture. Scrubbing to a
   * frame mid-move gave a different answer every time, and an offline render of
   * the same composition would have caught whatever arbitrary point the
   * transition had reached.
   *
   * So it interpolates like any other animated property: a start frame (the frame
   * the word became live), a duration in frames, an easing, a lerp. The squash is
   * a `sin` over the same progress — 1 at both ends, widest in the middle —
   * which is a function of `t`, not of elapsed milliseconds.
   */
  #placeMarker(group, wordIndex, relative) {
    if (!this.boxes) this.#measureBoxes();
    const to = this.boxes[wordIndex];
    if (!to) return;

    /* The first word of a card has nothing to travel from — the highlight simply
       arrives on it, which is the right read for a cut to a new line. */
    const fromIndex = wordIndex > 0 ? wordIndex - 1 : wordIndex;
    const from = this.boxes[fromIndex] || to;

    const move = this.#moveFrames(group, wordIndex);
    const raw = clamp01((relative - group.words[wordIndex].frame) / move);

    /* Nothing has changed since the last frame — most frames, because the
       highlight spends more of its time resting on a word than moving between
       words. Skipping here keeps a settled caption from dirtying style on every
       frame of playback. */
    const signature = `${fromIndex}:${wordIndex}:${raw.toFixed(4)}`;
    if (signature === this.markerSignature) return;
    this.markerSignature = signature;

    const t = easeInOutCubic(raw);

    /* How far this move is, as a fraction of the line — the amount of squash.
       Capped so a wrap onto the next line doesn't deform it into a sliver. */
    const travel = Math.min(
      1,
      Math.abs(to.x - from.x) / Math.max(1, this.lineWidth || 1),
    );
    /* `sin(πt)` is the velocity profile of the easing above: zero at both ends,
       peak in the middle. So the deformation tracks the speed rather than the
       elapsed fraction. */
    const pulse = Math.sin(Math.PI * raw) * travel;

    const style = this.marker.style;
    style.opacity = "1";
    style.left = `${lerp(from.x, to.x, t).toFixed(2)}px`;
    style.top = `${lerp(from.y, to.y, t).toFixed(2)}px`;
    style.width = `${lerp(from.w, to.w, t).toFixed(2)}px`;
    style.height = `${lerp(from.h, to.h, t).toFixed(2)}px`;
    style.transform =
      `scaleX(${(1 + SQUASH_X * pulse).toFixed(4)}) ` +
      `scaleY(${(1 - SQUASH_Y * pulse).toFixed(4)})`;

    this.#paintWords(fromIndex, wordIndex, t);
  }

  /**
   * How long this particular move gets, in frames.
   *
   * Bounded by the gap to the next word, not just by `MOVE_SECONDS`. Speech puts
   * words closer together than any fixed duration allows for — several of the
   * lines here have 0.26s gaps — so a fixed 0.26s move meant the highlight was
   * still travelling when the next word took over. It never arrived anywhere, and
   * a highlight that is permanently in motion stops reading as pointing at
   * anything.
   */
  #moveFrames(group, wordIndex) {
    const word = group.words[wordIndex];
    const next = group.words[wordIndex + 1];
    const cap = this.#framesFor(MOVE_SECONDS);
    if (!next) return cap;
    const gap = next.frame - word.frame;
    return Math.max(1, Math.min(cap, Math.round(gap * MOVE_GAP_FRACTION)));
  }

  /**
   * Cross-fade the ink on the two words the highlight is between.
   *
   * `--cap-on` is "how much of the plate is under this word", 0 to 1, and the
   * composition decides what that means — here, a mix between the light ink and
   * the dark. The element does not know either colour, which is the same division
   * as everywhere else in the format.
   *
   * It replaces a straight `.is-live { color: … }`, which flipped the instant a
   * word became current: for the whole length of the move the incoming word was
   * already dark with no plate behind it yet, and the outgoing one had snapped
   * back to light while the plate was still sitting on it. Two words wrong at
   * once, every move — the single biggest reason it read as off.
   */
  #paintWords(fromIndex, toIndex, t) {
    for (const index of this.painted) {
      if (index !== fromIndex && index !== toIndex) {
        this.spans[index]?.style.removeProperty("--cap-on");
      }
    }
    this.painted.clear();

    this.spans[toIndex]?.style.setProperty("--cap-on", t.toFixed(3));
    this.painted.add(toIndex);

    if (fromIndex !== toIndex) {
      this.spans[fromIndex]?.style.setProperty("--cap-on", (1 - t).toFixed(3));
      this.painted.add(fromIndex);
    }
  }

  /**
   * Word boxes, measured once per card.
   *
   * Layout coordinates, not `getBoundingClientRect`: the stage is scaled to fit
   * its container, so rects come back in screen pixels and would need dividing by
   * a scale this element has no business knowing. Offsets are already in the
   * authoring space the marker lives in.
   *
   * Measured once and cached because reading them forces layout, and this runs on
   * every frame. A card's boxes cannot move without the card being rebuilt.
   */
  #measureBoxes() {
    this.lineWidth = this.line.offsetWidth;
    this.boxes = this.spans.map((span) => ({
      x: span.offsetLeft,
      y: span.offsetTop,
      w: span.offsetWidth,
      h: span.offsetHeight,
    }));
  }

  /** Seconds → frames at the composition's rate, so motion keeps its duration. */
  #framesFor(seconds) {
    return Math.max(1, Math.round(seconds * (this.context.fps || 30)));
  }

  #reset() {
    this.builtFps = this.context.fps;
    this.groups = this.#buildGroups();
    this.spans = [];
    this.boxes = null;
    /* Indices whose `--cap-on` is currently set, so it can be cleared off the
       ones that stop being involved. */
    this.painted = new Set();
    this.markerSignature = null;
    this.liveGroup = -1;
    this.liveWord = -1;
    if (this.line) this.line.replaceChildren(this.marker);
    if (this.marker) this.marker.style.opacity = "0";
  }

  /** Swap the visible words. Only runs when the card actually changes. */
  #renderGroup(groupIndex) {
    /* The marker survives the swap — it is chrome, not content. */
    this.line.replaceChildren(this.marker);
    this.spans = [];
    /* Measured lazily, on the frame a word is actually placed — see
       `#placeMarker`. Invalidated here because the spans it would describe
       just got thrown away. */
    this.boxes = null;
    /* The spans these referred to no longer exist, and the signature must not
       match across a card change or the new card's first frame would be skipped
       as "nothing moved". */
    this.painted.clear();
    this.markerSignature = null;

    if (groupIndex < 0) {
      /* Lead-in, before the first word of this element's line: nothing to
         highlight yet. */
      this.marker.style.opacity = "0";
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const word of this.groups[groupIndex].words) {
      const span = document.createElement("span");
      span.className = "cap-word";
      span.textContent = word.w;
      fragment.appendChild(span);
      this.spans.push(span);
    }
    this.line.appendChild(fragment);
  }

  #groupAt(frame) {
    for (let i = this.groups.length - 1; i >= 0; i--) {
      if (frame >= this.groups[i].frame) return i;
    }
    return -1;
  }

  #wordAt(group, frame) {
    for (let i = group.words.length - 1; i >= 0; i--) {
      if (frame >= group.words[i].frame) return i;
    }
    return 0;
  }

  /**
   * Words → cards.
   *
   * Two rules beyond "every N words", both from watching real captions rather
   * than from a spec: a sentence ending forces a break, so a new thought never
   * shares a card with the end of the last one; and a card left holding a single
   * word is merged into a neighbour, because one word alone reads as a mistake.
   *
   * Counted per card, not off each word's absolute index — 1.3.1 used the index,
   * which works until a sentence break lands mid-card and puts every later card
   * out of phase with the modulo.
   */
  #buildGroups() {
    const words = parseWords(this.spec.config);
    if (!words.length) return [];

    const fps = this.context.fps;
    const perGroup =
      this.spec.config.wordsAtOnce === -1
        ? words.length
        : this.spec.config.wordsAtOnce || 3;

    const groups = [];
    for (const word of words) {
      const entry = { w: word.w, frame: Math.round((word.t || 0) * fps) };
      const previous = groups[groups.length - 1];
      const endsSentence =
        previous && /[.?!]$/.test(previous.words[previous.words.length - 1].w);

      if (!previous || previous.words.length >= perGroup || endsSentence) {
        groups.push({ frame: entry.frame, words: [entry] });
      } else {
        previous.words.push(entry);
      }
    }

    for (let i = 0; i < groups.length; i++) {
      if (groups[i].words.length !== 1 || perGroup <= 1) continue;
      const previous = groups[i - 1];
      const next = groups[i + 1];
      const orphan = groups[i].words[0];

      if (previous && !/[.?!]$/.test(previous.words[previous.words.length - 1].w)) {
        previous.words.push(orphan);
      } else if (next && !/[.?!]$/.test(orphan.w)) {
        next.words.unshift(orphan);
        next.frame = orphan.frame;
      } else {
        continue;
      }
      groups.splice(i, 1);
      i--;
    }

    return groups;
  }
}

/**
 * `config` → `[{ w, t }]`, from either accepted shape.
 *
 * Both are strings on purpose. An array of `{word, time}` objects is the same
 * information spread over five lines each, and a caption is the one part of a
 * composition somebody reads as a sentence — it should still look like one.
 */
function parseWords(config) {
  const source = config.words;
  if (!source) return [];
  if (Array.isArray(source)) return source;

  const tokens = String(source).trim().split(/\s+/).filter(Boolean);

  if (config.timestamps) {
    const times = String(config.timestamps).trim().split(/\s+/);
    let last = 0;
    return tokens.map((w, i) => {
      /* `1.20:0.31` — an aligner's "time:confidence" pair. Take the time. */
      const raw = parseFloat(String(times[i] ?? "").split(":")[0]);
      last = Number.isFinite(raw) ? raw : last;
      return { w, t: last };
    });
  }

  let last = 0;
  return tokens.map((token) => {
    const match = /^(.*?)\[([0-9]*\.?[0-9]+)\]$/.exec(token);
    if (!match) return { w: token, t: last };
    last = parseFloat(match[2]);
    return { w: match[1], t: last };
  });
}
