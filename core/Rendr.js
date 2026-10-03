import { formatTimecode, timecodeFromFrames } from "../util/timecode.js";
import { detectCapabilities } from "../runtime/Capabilities.js";
import AssetStore from "../media/AssetStore.js";
import Clock from "./Clock.js";
import Composition from "./Composition.js";
import Emitter from "./Emitter.js";
import Stage from "./Stage.js";
import { reconcile, styleChanged } from "./Reconciler.js";
import { resolveElementType } from "../elements/registry.js";

let instanceCounter = 0;

/**
 * The runtime.
 *
 * Owns a composition, a stage, a clock and a set of media sources, and exposes
 * the whole of it as one object. A host supplies JSON and buttons; everything
 * between — frame timing, seeking, decoding, memory, sizing, teardown — is here.
 *
 * See `../README.md` for the shape of the API and why it is shaped that way.
 */
export default class Rendr {
  #emitter = new Emitter();
  #elements = [];
  #mounted = new Set();
  #renderToken = 0;
  #renderSeq = 0;
  #destroyed = false;
  #stats = { builds: 0, reconciles: 0, frameCost: 0, samples: [] };

  constructor(host, json, options = {}) {
    if (!host) throw new Error("Rendr needs a host element to draw into.");

    this.instanceId = `r${++instanceCounter}`;
    this.capabilities = detectCapabilities(options.capabilities);
    this.host = host;

    this.#bindHandlers(options);

    this.stage = new Stage(host, {
      instanceId: this.instanceId,
      capabilities: this.capabilities,
    });

    this.assets = new AssetStore({
      capabilities: this.capabilities,
      onLoading: (loading, label) =>
        this.#emitter.emit("loading", { loading, label }),
    });

    this.clock = new Clock({
      onTick: (frame) => this.#onTick(frame),
      onStateChange: () => this.#emitState(),
    });
    if (options.loop !== undefined) this.clock.setLoop(options.loop);
    if (options.rate) this.clock.setRate(options.rate);

    /* The host box changes size on rotation, on a layout shift, on anything.
       Refitting is a transform write, so it is cheap enough to do on every one. */
    this.#observer = new ResizeObserver(() => this.stage.fit());
    this.#observer.observe(host);

    this.ready_ = this.#load(json, { initial: true });
  }

  #observer = null;

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  /** Resolves when the first composition is built and its first frame drawn. */
  ready() {
    return this.ready_;
  }

  /**
   * Swap in a new composition.
   *
   * The normal path is a reconcile — see `Reconciler`. A structural change
   * (different fps, different resolution, an element changing type) is handled
   * within that: only what genuinely cannot be adopted is rebuilt.
   *
   * Returns a promise so a host can await a settled frame, but does not need to
   * be awaited: calls are serialised internally, and a call that is superseded
   * before it finishes abandons its own work rather than fighting the newer one.
   */
  update(json) {
    this.ready_ = this.#load(json, { initial: false });
    return this.ready_;
  }

  destroy() {
    this.#destroyed = true;
    this.#renderToken++;
    this.clock.destroy();
    this.#observer?.disconnect();
    this.#observer = null;
    for (const element of this.#elements) element.destroy();
    this.#elements = [];
    this.#mounted.clear();
    this.assets.destroy();
    this.stage.destroy();
    this.#emitter.clear();
  }

  /* ── transport ──────────────────────────────────────────────────────────── */

  play() {
    this.clock.play();
  }
  pause() {
    this.clock.pause();
  }
  toggle() {
    this.clock.toggle();
  }
  seek(frame) {
    this.clock.seek(frame);
    return this.frame;
  }
  seekTime(seconds) {
    this.clock.seekTime(seconds);
    return this.frame;
  }
  setRate(rate) {
    this.clock.setRate(rate);
  }
  setLoop(loop) {
    this.clock.setLoop(loop);
  }
  step(delta = 1) {
    this.clock.pause();
    return this.seek(this.frame + delta);
  }

  /* ── reading it ─────────────────────────────────────────────────────────── */

  get frame() {
    return this.clock.frame;
  }
  get totalFrames() {
    return this.clock.totalFrames;
  }
  get time() {
    return this.clock.time;
  }
  get duration() {
    return this.clock.duration;
  }
  get fps() {
    return this.clock.fps;
  }
  get rate() {
    return this.clock.rate;
  }
  get playing() {
    return this.clock.playing;
  }
  get looping() {
    return this.clock.loop;
  }
  get resolution() {
    return this.composition ? [...this.composition.resolution] : [0, 0];
  }
  get aspect() {
    return this.composition?.aspect ?? 16 / 9;
  }
  get isReady() {
    return Boolean(this.composition) && !this.#destroyed;
  }

  /** The current frame as the timecode a file would carry. */
  timecode(frame = this.frame) {
    return timecodeFromFrames(frame, this.fps);
  }

  /** `"0:04 / 0:16"` — the readout shape, without a host formatting seconds. */
  clockText(frame = this.frame) {
    return `${shortTime(frame / this.fps)} / ${shortTime(this.duration)}`;
  }

  /** Which elements are on screen at a frame, as their specs. */
  activeAt(frame = this.frame) {
    return this.composition ? this.composition.activeAt(frame) : [];
  }

  /**
   * What it is costing.
   *
   * `frameCost` is one render pass in this browser — not the engine's end-to-end
   * figure, which also covers a compositor frame, a shared-memory copy and a
   * write into an encoder, none of which exist in a tab. It must never be
   * presented as the benchmark number.
   */
  stats() {
    return {
      ...this.assets.stats(),
      builds: this.#stats.builds,
      reconciles: this.#stats.reconciles,
      frameCost: this.#stats.frameCost,
      mounted: this.#mounted.size,
      elements: this.#elements.length,
      tier: this.capabilities.tier,
    };
  }

  /* ── events ─────────────────────────────────────────────────────────────── */

  on(event, handler) {
    return this.#emitter.on(event, handler);
  }
  off(event, handler) {
    this.#emitter.off(event, handler);
  }

  #bindHandlers(options) {
    if (options.onFrame) this.#emitter.on("frame", options.onFrame);
    if (options.onState) this.#emitter.on("state", options.onState);
    if (options.onLoading) this.#emitter.on("loading", options.onLoading);
    if (options.onError) this.#emitter.on("error", options.onError);
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  async #load(json, { initial }) {
    const token = ++this.#renderToken;
    try {
      const composition = new Composition(json);
      await this.assets.sync(composition.assets, composition.usedAssets);
      if (token !== this.#renderToken || this.#destroyed) return;

      const context = {
        instanceId: this.instanceId,
        assets: this.assets,
        fps: composition.fps,
      };

      const previous = this.#elements;
      const { kept, added, replaced, removed } = reconcile(
        previous,
        composition.elements,
      );

      for (const element of removed) {
        this.stage.removeRules(element.id);
        this.#mounted.delete(element);
        element.destroy();
      }

      for (const { element, spec } of kept) {
        if (styleChanged(element.spec, spec)) {
          element.adopt(spec);
          this.stage.setRules(element.id, spec.style);
        } else {
          element.adopt(spec);
        }
        element.context = context;
      }

      const rebuilt = [];
      for (const { element, spec } of replaced) {
        this.stage.removeRules(element.id);
        this.#mounted.delete(element);
        element.destroy();
        rebuilt.push(this.#create(spec, context));
      }
      for (const spec of added) rebuilt.push(this.#create(spec, context));

      /* Ordered by the file, so stacking is the file's business — z-index in the
         composition, not mount order, which changes as you scrub. */
      const byKey = new Map(
        [...kept.map((k) => k.element), ...rebuilt].map((el) => [el.key, el]),
      );
      this.#elements = composition.elements
        .map((spec) => byKey.get(spec.key))
        .filter(Boolean);

      this.composition = composition;
      this.stage.resize(composition.stageSize);
      this.clock.configure({
        fps: composition.fps,
        totalFrames: composition.totalFrames,
      });

      this.#stats[initial ? "builds" : "reconciles"]++;
      if (initial) this.#stats.builds = 1;

      await this.#render(this.clock.frame, token);
      this.#emitState();
    } catch (err) {
      if (token === this.#renderToken) this.#emitter.emit("error", err);
      throw err;
    }
  }

  #create(spec, context) {
    const ElementClass = resolveElementType(spec.type);
    const element = new ElementClass(spec, context);
    this.stage.setRules(element.id, spec.style);
    return element;
  }

  #onTick(frame) {
    this.#render(frame, this.#renderToken);
  }

  /**
   * Draw one frame.
   *
   * Mount/unmount by visibility, update what is mounted, then release decoded
   * frames for any source not on screen. That last step is the one that keeps a
   * phone alive: a composition holds several clips and draws one at a time, and
   * this is the only place that knows which.
   */
  async #render(frame, token) {
    if (this.#destroyed || !this.composition) return;
    const started = now();

    /**
     * Which render this is, so a stale one can't announce itself.
     *
     * `#render` awaits — element builds, a decode — so two of them overlap
     * whenever a frame is asked for before the last one finished, which during
     * playback is most of the time. Nothing guarantees they *finish* in the order
     * they started, and the `frame` event was emitted at the end of each. So
     * subscribers saw frames arrive out of order: the playhead jumped back a few
     * times a second, which reads as jitter and, while dragging, as the scrubber
     * fighting the pointer. Only the newest render gets to speak.
     */
    const seq = ++this.#renderSeq;

    const pending = [];
    for (const element of this.#elements) {
      const visible = element.visibleAt(frame);
      if (!visible) {
        if (this.#mounted.has(element)) {
          element.unmount();
          this.#mounted.delete(element);
        }
        continue;
      }
      if (!element.built) pending.push(element.build());
      if (!this.#mounted.has(element)) {
        this.stage.mount(element.node);
        this.#mounted.add(element);
      }
    }
    if (pending.length) await Promise.all(pending);
    if (token !== this.#renderToken || this.#destroyed) return;

    const inUse = new Set();
    const updates = [];
    for (const element of this.#mounted) {
      updates.push(element.update(frame));
      for (const source of element.sources?.() || []) inUse.add(source);
    }
    await Promise.all(updates);
    if (token !== this.#renderToken || this.#destroyed) return;

    this.assets.sweepIdle(inUse);

    const cost = now() - started;
    const samples = this.#stats.samples;
    samples.push(cost);
    if (samples.length > 40) samples.shift();
    this.#stats.frameCost =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;

    /* A newer render has already finished and reported — this one's frame is
       history, and announcing it now would move every subscriber backwards. */
    if (seq !== this.#renderSeq) return;

    this.#emitter.emit("frame", {
      frame,
      time: frame / this.fps,
      timecode: timecodeFromFrames(frame, this.fps),
      totalFrames: this.totalFrames,
    });
  }

  #emitState() {
    this.#emitter.emit("state", {
      playing: this.playing,
      ready: this.isReady,
      rate: this.rate,
      loop: this.looping,
      frame: this.frame,
      totalFrames: this.totalFrames,
      fps: this.fps,
      resolution: this.resolution,
    });
  }
}

/** `65` → `"1:05"`. The readout form, distinct from a file's timecode. */
function shortTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export { formatTimecode };
