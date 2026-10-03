import {
  framesFromSeconds,
  parseTimecode,
  secondsFromFrames,
} from "../util/timecode.js";
import {
  mergeStyles,
  referencedAssets,
  resolveRefs,
  substituteParams,
} from "../util/refs.js";

/**
 * A composition document, normalised into something the runtime can query.
 *
 * Parsing happens once, here, and produces a flat list of **element specs** with
 * everything already resolved: components expanded, variables and presets
 * substituted, timecodes converted to frames. Nothing downstream re-reads the
 * raw JSON, and nothing downstream parses a timecode.
 *
 * The one thing deliberately *not* resolved here is assets. An element spec keeps
 * its `@assets:key` reference and the runtime hands it the loaded source at build
 * time — because assets are shared, ref-counted and outlive any one composition,
 * so baking a loaded object into the spec would make two compositions that use the
 * same clip incomparable. That matters: `Reconciler` compares specs to decide what
 * changed, and it can only do that if a spec is plain data.
 *
 * ── Stable identity ────────────────────────────────────────────────────────
 *
 * Every spec gets a `key` that survives an edit, because reconciliation is only
 * possible if "the same element" is answerable. The file's own `id` is used when
 * it has one (the engine overwrites `id` internally, so it is otherwise free),
 * falling back to position. A component expands to several elements, so those get
 * `parentId/childIndex` — which keeps them stable even as the parent moves.
 */
export default class Composition {
  constructor(json) {
    this.source = json;
    this.settings = { ...(json.settings || {}) };
    this.fps = Number(this.settings.fps) || 30;
    this.resolution = this.settings.resolution || [1280, 720];

    this.variables = json.variables || {};
    this.presets = json.presets || {};
    this.components = json.components || {};

    this.assets = json.assets?.media || {};
    this.usedAssets = referencedAssets(json);

    this.elements = this.#buildElements(json.timeline || []);

    /* Total duration is the furthest any element reaches. `settings.duration` is
       ignored — it always was, and a field that silently does nothing is worse
       than no field, so it is not read here either. */
    this.totalFrames = this.elements.reduce(
      (max, spec) => Math.max(max, spec.at + spec.duration),
      0,
    );
  }

  get duration() {
    return secondsFromFrames(this.totalFrames, this.fps);
  }

  get width() {
    return this.resolution[0];
  }

  get height() {
    return this.resolution[1];
  }

  get aspect() {
    return this.width / this.height;
  }

  /**
   * The authoring space is always 1280 wide; height falls out of the ratio.
   *
   * This is the single most surprising property of the format and it is not an
   * accident: a composition is authored once and rendered at any resolution, so
   * coordinates cannot be in output pixels. `settings.resolution` is an output
   * setting, and the stage is scaled to hit it.
   */
  get stageSize() {
    const width = 1280;
    return [width, Math.round(width / this.aspect)];
  }

  /** Specs live at this frame. */
  activeAt(frame) {
    return this.elements.filter(
      (spec) => frame >= spec.at && frame < spec.at + spec.duration,
    );
  }

  #buildElements(timeline) {
    const specs = [];
    timeline.forEach((entry, index) => {
      const id = entry.id || `el-${index}`;
      for (const resolved of this.#expand(entry, id)) {
        specs.push(this.#normalise(resolved.entry, resolved.key, index));
      }
    });
    return specs;
  }

  /**
   * A component invocation → the elements it stands for.
   *
   * The component's own timeline is the template; the invocation supplies the
   * parameters and the timing. This is the mechanism that makes one design serve
   * a thousand videos, so it is worth being strict: a missing required parameter
   * throws here, at parse time, rather than producing an element that renders
   * `{{value}}` as literal text.
   */
  *#expand(entry, id) {
    const ref = /^@components:(.+)$/.exec(entry.type || "");
    if (!ref) {
      yield { entry, key: id };
      return;
    }

    const def = this.components[ref[1]];
    if (!def) throw new Error(`Unknown component "@components:${ref[1]}"`);

    const params = {};
    for (const [name, schema] of Object.entries(def.parameters || {})) {
      const supplied = entry.config?.[name];
      if (schema.required && supplied === undefined) {
        throw new Error(
          `Component "@components:${ref[1]}" needs parameter "${name}" (element "${id}")`,
        );
      }
      params[name] = supplied ?? schema.default;
    }

    const template = substituteParams(def.timeline || [], params);
    for (const [childIndex, child] of template.entries()) {
      yield {
        /* Timing comes from the invocation, not the template — the template
           describes a shape, the invocation places it. */
        entry: { ...child, at: entry.at, duration: entry.duration },
        key: `${id}/${childIndex}`,
      };
    }
  }

  /** One entry → a fully-resolved, frame-based spec. */
  #normalise(entry, key, order) {
    let style = entry.style || {};
    if (entry.stylePreset) {
      const presetRef = /^@presets:(.+)$/.exec(entry.stylePreset);
      const preset = presetRef && this.presets[presetRef[1]];
      if (!preset) throw new Error(`Unknown style "${entry.stylePreset}"`);
      style = mergeStyles(preset, style);
    }

    /* Variables only. Assets stay as references — see the class comment. */
    const namespaces = { variables: this.variables };
    style = resolveRefs(style, namespaces);
    const config = resolveRefs(entry.config || {}, namespaces);

    const at = framesFromSeconds(parseTimecode(entry.at ?? "00:00:00.000"), this.fps);
    const duration = Math.max(
      1,
      framesFromSeconds(parseTimecode(entry.duration ?? "00:00:01.000"), this.fps),
    );

    return {
      key,
      order,
      id: entry.id || key,
      type: String(entry.type || "Text").toLowerCase(),
      at,
      duration,
      config,
      style,
    };
  }
}
