import { demux } from "./demux.js";
import Samples from "./Samples.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A decoded video, held in a bounded cache the decoder can never be starved by.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This class is the reason the rewrite exists. The original held whole groups of
 * decoded frames as `ImageBitmap`s and built a `VideoDecoder` per group that it
 * never closed. On a desktop that is waste; on a phone it is a crash, and it was.
 *
 * Four decisions:
 *
 * **1. A decoder's frame is copied out and closed in the same breath.**
 * *A decoded `VideoFrame` you are holding is a buffer the decoder cannot decode
 * into.* Hardware decoders own a small, fixed pool of output buffers, so retaining
 * `VideoFrame`s does not use more memory, it stalls the decoder, silently. An
 * earlier version held at most four of them to stay under that pool, which was
 * correct and also meant a blocking decode every fourth frame: visible stutter.
 *
 * Now the output callback draws the frame onto an `OffscreenCanvas`, takes a
 * synchronous `ImageBitmap` from it, and closes the frame. The decoder holds at
 * most one buffer at a time, whatever the group length, so the cache is no longer
 * bounded by the decoder's pool. It is bounded by an explicit memory budget
 * instead (`capabilities.frameBudgetMB`), which is the number to raise if you
 * want a deeper cache.
 *
 * The price is RGBA: 4 bytes a pixel instead of the codec's 1.5. That is the
 * trade, and it is made on purpose, against a budget, rather than by accident
 * against an unbounded group.
 *
 * **2. One decoder, reused for the life of the source.**
 * A `VideoDecoder` is a handle on a hardware pipeline and platforms allow only a
 * handful at once. It is configured once and flushed between groups, which is a
 * state reset, not a teardown. Nothing here constructs a decoder per group.
 *
 * **3. Playback never waits on a decode.**
 * Every `frameAt()` also looks `capabilities.lookahead` frames ahead and, if they
 * are not already cached, decodes the next group in the background. Decoding runs
 * several times faster than real time, so by the time the playhead gets there the
 * frames are waiting. Only a seek that lands outside the cache pays for a decode.
 *
 * **4. Eviction is by group, least recently used.**
 * Plain per-frame LRU is wrong for playback: a decoded group is inserted in order
 * and read in order, so the frame just shown is the newest and the frames about to
 * be shown are the oldest, which is exactly backwards. A group is stamped when any
 * of its frames is requested or inserted and is evicted whole, so the group being
 * played, and the one being prefetched behind it, are the last to go.
 *
 * ── Frame indices ──────────────────────────────────────────────────────────
 *
 * Callers speak display order ("the 47th frame someone sees"). Internally
 * everything is decode order, because that is the order the codec requires
 * frames be fed in. `Samples` owns the map between them.
 */
/** The fewest frames a source may be cut down to, whatever the budget says. */
const MIN_FRAMES = 2;

export default class VideoSource {
  #src;
  #capabilities;
  #onLoading;
  #timeout;

  #samples = null;
  #config = null;
  #decoder = null;
  /** Set by the decoder's own error callback, which fires outside any await. */
  #decoderError = null;

  /** decodeIndex → { bitmap, group }. `group` is the GOP's first decode index. */
  #cache = new Map();
  /** GOP start → the tick it was last requested or filled. Higher is newer. */
  #groupUse = new Map();
  #tick = 0;
  /** The group of the frame most recently asked for. Never evicted. */
  #cursorGroup = -1;
  /** Frame conversion surface: one canvas, reused, sized to the clip. */
  #canvas = null;
  #ctx = null;
  /** GOP start → in-flight decode, so concurrent requests share one pass. */
  #inflight = new Map();
  /** Serialises decodes: one decoder and one sink means one at a time. */
  #chain = Promise.resolve();
  /** Set while a decode is running; collects the decoder's output. */
  #sink = null;

  constructor(src, { capabilities, onLoading, timeout = 15000 } = {}) {
    this.#src = src;
    this.#capabilities = capabilities;
    this.#onLoading = onLoading || null;
    this.#timeout = timeout;
    this.type = "video";
    this.properties = {};
    this.loaded = false;
  }

  get src() {
    return this.#src;
  }

  /** Frames currently decoded and held. The number to watch on a phone. */
  get framesHeld() {
    return this.#cache.size;
  }

  /** Bytes of decoded frames held. Each is an RGBA bitmap: 4 bytes a pixel. */
  get bytesHeld() {
    const { width = 0, height = 0 } = this.properties;
    return this.#cache.size * width * height * 4;
  }

  /** How many frames the memory budget allows, for this clip's size. */
  get maxFrames() {
    const { width = 0, height = 0 } = this.properties;
    const budget = (this.#capabilities.frameBudgetMB ?? 192) * 1024 * 1024;
    return Math.max(MIN_FRAMES, Math.floor(budget / Math.max(1, width * height * 4)));
  }

  get frameCount() {
    return this.#samples?.length ?? 0;
  }

  async load() {
    if (this.loaded) return this;
    await this.#report("Loading video", async () => {
      const response = await withTimeout(fetch(this.#src), this.#timeout);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${this.#src}: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const { samples, displayToDecodeIndex, config, properties } =
        await demux(buffer);

      if (!this.#capabilities.hasWebCodecs) {
        throw new Error("This browser has no WebCodecs — video cannot decode.");
      }
      if (typeof OffscreenCanvas === "undefined") {
        throw new Error("This browser has no OffscreenCanvas, video cannot be cached.");
      }
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        throw new Error(`Unsupported video codec: ${config.codec}`);
      }

      this.#samples = new Samples(samples, displayToDecodeIndex);
      this.#config = config;
      this.properties = properties;
      this.loaded = true;
    });
    return this;
  }

  /**
   * The frame at a display index, or null.
   *
   * Returned bitmaps are **borrowed**: the source owns them and will close them
   * when their group is evicted. A caller draws and forgets. Closing one yourself
   * will empty somebody else's picture. The group of the frame returned here is
   * never the one evicted next, so drawing it straight away is always safe.
   */
  async frameAt(displayIndex) {
    if (!this.loaded) return null;

    const index = this.#samples.decodeIndex(displayIndex);
    if (index === undefined) return null;

    const [group] = this.#samples.gopRange(index);
    this.#cursorGroup = group;
    this.#touch(group);

    let entry = this.#cache.get(index);
    if (!entry) {
      await this.#decodeGroupFor(index, { background: false });
      /* The source can be destroyed while a decode is in flight. */
      if (!this.loaded) return null;
      entry = this.#cache.get(index);
    }
    if (!entry) {
      /* A decode of this group was already running for a *different* target, so
         it retained a window that doesn't include this frame. Now that it has
         finished, ask again, this time with the window built around what we
         want. One retry only: a second miss means the frame genuinely isn't
         producible. */
      await this.#decodeGroupFor(index, { background: false });
      if (!this.loaded) return null;
      entry = this.#cache.get(index);
    }
    if (!entry) return null;

    this.#prefetchAhead(index);
    return entry.bitmap;
  }

  /**
   * Make sure the next `lookahead` frames are cached, decoding a group in the
   * background if not. Deliberately not awaited: the point is that nobody waits.
   * It wraps past the end to the start, because compositions loop and the seam is
   * where a stall would otherwise land.
   */
  #prefetchAhead(index) {
    const ahead = this.#capabilities.lookahead ?? 0;
    const total = this.#samples.length;
    if (ahead <= 0 || total <= 1) return;

    for (let step = 1; step <= Math.min(ahead, total - 1); step++) {
      const next = (index + step) % total;
      if (this.#cache.has(next)) continue;
      /* A failed background decode is not an error yet: nobody asked for these
         frames. The first foreground request that needs one retries it, and
         surfaces the failure if it is real. */
      this.#decodeGroupFor(next, { background: true }).catch(() => {});
      return;
    }
  }

  /**
   * Drop every decoded frame, keeping the samples and the decoder.
   *
   * For a clip that has left the screen. Coming back costs one group's decode
   * rather than a refetch and a re-demux, which is what makes it safe to do this
   * the moment a clip is no longer drawn instead of guessing whether it will be
   * wanted again.
   */
  releaseFrames() {
    const freed = this.bytesHeld;
    for (const { bitmap } of this.#cache.values()) bitmap.close();
    this.#cache.clear();
    this.#groupUse.clear();
    return freed;
  }

  /** Everything: frames, decoder, samples. The source is unusable after this. */
  destroy() {
    this.releaseFrames();
    this.#closeDecoder();
    this.#inflight.clear();
    this.#canvas = null;
    this.#ctx = null;
    this.#samples = null;
    this.#config = null;
    this.loaded = false;
  }

  /* ── decoding ───────────────────────────────────────────────────────────── */

  /**
   * Decode the group containing `index`.
   *
   * A group is the unit because it is the unit the codec allows: every frame
   * except the keyframe is a difference from its neighbours, so the only way to
   * reach frame 47 is to decode forward from the keyframe at or before it.
   *
   * Concurrent callers wanting the same group share one pass — during playback
   * several elements and a re-render can all land on the same group in the same
   * tick, and decoding it three times would be three times the work and three
   * times the frames alive at once.
   */
  #decodeGroupFor(index, { background }) {
    const [start, end] = this.#samples.gopRange(index);
    const existing = this.#inflight.get(start);
    if (existing) return existing;

    /**
     * Decodes are serialised per source.
     *
     * There is **one** decoder and **one** `#sink` here, so two decodes running
     * at once would feed the same pipeline from two places and route each other's
     * output into the wrong collection. That is not hypothetical: this
     * composition has two elements pointing at the same clip at different
     * in-points, and a scrub across them asks for two groups in the same tick.
     * Chaining costs a little latency and removes the whole class of problem.
     */
    const run = this.#chain
      .catch(() => {})
      .then(() => this.#decodeGroupNow(index, start, end, background));
    this.#chain = run.catch(() => {});
    this.#inflight.set(start, run);
    return run.finally(() => {
      if (this.#inflight.get(start) === run) this.#inflight.delete(start);
    });
  }

  #decodeGroupNow(index, start, end, background) {
    /**
     * The window of this group worth keeping.
     *
     * The whole group when it fits the budget, which is the usual case and is
     * what makes backward scrubbing inside a group free. A group longer than the
     * budget keeps a window starting at the frame asked for and running forward,
     * the direction playback goes.
     */
    /* Destroyed while this was queued behind another decode. Nothing wants it. */
    if (!this.loaded) return Promise.resolve();

    const length = end - start + 1;
    const max = this.maxFrames;
    const from = length <= max ? start : index;
    const to = length <= max ? end + 1 : Math.min(end + 1, index + max);

    const work = async () => {
      const decoder = this.#ensureDecoder();
      const produced = [];
      this.#sink = (frame) => {
        const t = frame.timestamp;
        /* Copy out and close immediately. Nothing the decoder emitted is ever
           held, so its output pool cannot run dry however long the group is. */
        if (t >= from && t < to) {
          try {
            produced.push([t, this.#toBitmap(frame)]);
          } catch (err) {
            this.#decoderError = err;
          }
        }
        frame.close();
      };

      try {
        for (let i = start; i <= end; i++) {
          if (!this.loaded) return;
          const sample = this.#samples.sample(i);
          decoder.decode(
            new EncodedVideoChunk({
              type: sample.is_sync ? "key" : "delta",
              /* The decode index travels as the timestamp and comes back
                 attached to the frame, which is how output is matched to
                 input without tracking order. */
              timestamp: i,
              duration: (sample.duration * 1e6) / sample.timescale,
              data: sample.data,
            }),
          );
        }
        /* Flush rather than close: it drains the pipeline and leaves the decoder
           configured and ready for the next group's keyframe. */
        await decoder.flush();
        /* The decoder's `error` callback fires out of band, so a failure can
           land without `flush()` rejecting. Checked here so a broken pipeline
           is torn down instead of being fed forever. */
        if (this.#decoderError) throw this.#decoderError;
      } catch (err) {
        /* A decoder that errored is not reusable. Drop it; the next request
           builds a fresh one rather than feeding a dead pipeline forever. */
        for (const [, bitmap] of produced) bitmap.close();
        this.#closeDecoder();
        /* Closing the decoder under a destroy makes flush() reject. That is the
           expected way for an in-flight decode to end, not a failure. */
        if (!this.loaded) return;
        throw err;
      } finally {
        this.#sink = null;
      }

      /* Destroyed or released while this was in flight: these bitmaps belong to
         nobody now, and storing them would put them into a cache that is meant
         to be empty. */
      if (!this.loaded) {
        for (const [, bitmap] of produced) bitmap.close();
        return;
      }
      this.#store(produced, start);
    };

    /* Background decodes are not "loading": nothing is waiting on them, and
       reporting each one would flash a spinner every few frames of playback. */
    return background ? work() : this.#report(`Decoding frames ${start}–${end}`, work);
  }

  /** One decoded frame to a bitmap the decoder has no claim on. Synchronous. */
  #toBitmap(frame) {
    const { width, height } = this.properties;
    if (!this.#canvas) {
      this.#canvas = new OffscreenCanvas(width, height);
      this.#ctx = this.#canvas.getContext("2d", { alpha: false });
    }
    this.#ctx.drawImage(frame, 0, 0, width, height);
    return this.#canvas.transferToImageBitmap();
  }

  #touch(group) {
    this.#groupUse.set(group, ++this.#tick);
  }

  /**
   * Put a decoded group into the cache, then evict whole older groups until the
   * budget is met. The group being stored and the group of the frame most
   * recently asked for are exempt, so a draw that is about to happen can never
   * find its bitmap closed.
   */
  #store(entries, group) {
    this.#touch(group);
    for (const [t, bitmap] of entries) {
      /* An existing entry for a timestamp must be closed before it is replaced:
         a `Map.set` over an occupied key drops the old value silently, and the
         old value here is a bitmap only `close()` releases. Looping playback
         decodes the same group again on every pass with the same timestamps. */
      this.#cache.get(t)?.bitmap.close();
      this.#cache.set(t, { bitmap, group });
    }

    const max = this.maxFrames;
    while (this.#cache.size > max) {
      let victim;
      let oldest = Infinity;
      for (const [g, tick] of this.#groupUse) {
        if (g === group || g === this.#cursorGroup) continue;
        if (tick < oldest) {
          oldest = tick;
          victim = g;
        }
      }
      if (victim === undefined) break;
      this.#dropGroup(victim);
    }
  }

  #dropGroup(group) {
    for (const [t, entry] of this.#cache) {
      if (entry.group !== group) continue;
      entry.bitmap.close();
      this.#cache.delete(t);
    }
    this.#groupUse.delete(group);
  }

  #ensureDecoder() {
    if (this.#decoder && this.#decoder.state !== "closed") return this.#decoder;
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        if (this.#sink) this.#sink(frame);
        /* No sink means the decode that asked for this was abandoned (a
           destroy, or an error). The frame still has to be closed or it
           leaks exactly like the ones this class exists to stop leaking. */
        else frame.close();
      },
      error: (err) => {
        this.#decoderError = err;
      },
    });
    this.#decoderError = null;
    this.#decoder.configure(this.#config);
    return this.#decoder;
  }

  #closeDecoder() {
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    this.#decoder = null;
  }

  async #report(label, work) {
    this.#onLoading?.(true, label);
    try {
      return await work();
    } finally {
      this.#onLoading?.(false, null);
    }
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
