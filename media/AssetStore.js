import ImageSource from "./ImageSource.js";

/**
 * The media a composition refers to, shared and ref-counted.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * **Assets must survive an edit.** Changing a colour must not refetch and
 * re-demux an mp4. So the store outlives any single composition and is keyed by
 * `type:src`, not by the asset name a file happens to give it.
 *
 * **Assets must not survive being unused.** A composition that stops referring to
 * a clip should stop paying for it. So each source carries a reference count, and
 * `retain`/`release` bracket a composition's use of it.
 *
 * Between those, `sweepIdle` handles the case that actually crashed phones: a
 * clip still referenced by the composition but not currently *drawn*. It keeps
 * its samples and loses its decoded frames — see `VideoSource.releaseFrames`.
 *
 * ── `VideoSource` is loaded on demand, not imported here ────────────────────
 *
 * `VideoSource` pulls in `demux.js`, which pulls in `mp4box.js` — 352KB of
 * third-party demuxer, unconditionally, for any composition that so much as
 * *could* have video. A text-and-keyframes demo has no video element and no
 * business paying for a demuxer it will never run. `#create` dynamically imports
 * `VideoSource` only when it is about to construct one, so a composition with
 * zero video assets never fetches mp4box at all — not deferred to a click, not
 * deferred to idle, simply never requested. `ImageSource` stays a static import:
 * it has no comparable dependency, so there is nothing to gain by delaying it.
 */
export default class AssetStore {
  #sources = new Map();
  #counts = new Map();
  #capabilities;
  #onLoading;

  constructor({ capabilities, onLoading } = {}) {
    this.#capabilities = capabilities;
    this.#onLoading = onLoading;
  }

  /**
   * Load everything a composition needs, and drop what it no longer does.
   *
   * `declarations` is the file's `assets.media`; `used` is the subset actually
   * referenced somewhere. Loading only what is referenced is not a micro-
   * optimisation: a declared-but-unused video costs a fetch, a demux and a
   * decoder, and the demo composition deliberately declares one so a reader can
   * add a video element — which meant paying for it on every keystroke.
   *
   * Reference counts are bumped for every wanted key **before** anything async
   * runs, and the previous sync's keys are only released **after** the new
   * sources have resolved. That ordering — not just the counting itself — is
   * what guarantees a key present in both the old and new set never touches
   * zero in between and gets torn down and rebuilt for no reason. Creation
   * became async (see the class comment), so this can no longer be one
   * synchronous pass; the ordering has to be enforced explicitly instead of
   * falling out of the loop shape for free.
   */
  async sync(declarations, used) {
    const wanted = new Map();
    for (const [name, spec] of Object.entries(declarations || {})) {
      if (used && !used.has(name)) continue;
      wanted.set(name, `${spec.type}:${spec.src}`);
    }

    for (const key of wanted.values()) {
      this.#counts.set(key, (this.#counts.get(key) || 0) + 1);
    }
    const releasing = this.#retained || [];
    this.#retained = [...wanted.values()];

    const resolved = await Promise.all(
      [...wanted].map(async ([name, key]) => {
        const spec = declarations[name];
        let source = this.#sources.get(key);
        if (!source) {
          source = await this.#create(spec);
          this.#sources.set(key, source);
        }
        if (!source.loaded) await source.load();
        return [name, source];
      }),
    );

    for (const key of releasing) this.#releaseKey(key);

    this.byName = new Map(resolved);
    return this.byName;
  }

  get(name) {
    return this.byName?.get(name) ?? null;
  }

  /**
   * Drop decoded frames for every source not in `inUse`.
   *
   * Called once per rendered frame by the runtime, which is the only thing that
   * knows what is on screen. Cheap to call that often: a source already holding
   * nothing returns zero without doing any work.
   */
  sweepIdle(inUse) {
    let freed = 0;
    for (const source of this.#sources.values()) {
      if (inUse.has(source)) continue;
      freed += source.releaseFrames();
    }
    return freed;
  }

  stats() {
    let frames = 0;
    let bytes = 0;
    for (const source of this.#sources.values()) {
      frames += source.framesHeld;
      bytes += source.bytesHeld;
    }
    return { sources: this.#sources.size, framesHeld: frames, bytesHeld: bytes };
  }

  destroy() {
    for (const source of this.#sources.values()) source.destroy();
    this.#sources.clear();
    this.#counts.clear();
    this.byName = new Map();
    this.#retained = [];
  }

  #retained = [];

  async #create(spec) {
    const options = {
      capabilities: this.#capabilities,
      onLoading: this.#onLoading,
    };
    if (spec.type === "video") {
      const { default: VideoSource } = await import("./VideoSource.js");
      return new VideoSource(spec.src, options);
    }
    if (spec.type === "image") return new ImageSource(spec.src, options);
    throw new Error(`Unknown asset type "${spec.type}"`);
  }

  #releaseKey(key) {
    const count = (this.#counts.get(key) || 1) - 1;
    if (count > 0) {
      this.#counts.set(key, count);
      return;
    }
    this.#counts.delete(key);
    this.#sources.get(key)?.destroy();
    this.#sources.delete(key);
  }
}
