/**
 * A small playground shell shared by the examples: player, transport, editable
 * fields, a live JSON panel, and a stats strip, all wired to a rendr-web
 * instance. Plain DOM, no framework. It exists so each example file can stay
 * about the composition rather than about the page around it.
 *
 *   mountPlayground(root, {
 *     eyebrow, title, lede,        // header copy (lede may contain markup)
 *     page,                        // which nav link is current
 *     composition,                 // the JSON handed to createRendr()
 *     fields: [{ id, label, type, path, ... }],
 *     filename,                    // shown over the JSON panel
 *     note,                        // optional footer line (may contain markup)
 *   })
 */
import { createRendr } from "../../index.js";

/* ── icons: 16x16, drawn with currentColor, same set the Rendr page uses ─── */

const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const ICON = {
  play: svg('<path d="M4.5 2.8 12.8 8l-8.3 5.2Z" fill="currentColor" stroke-width="1.4"/>'),
  pause: svg('<path d="M5.6 3v10M10.4 3v10" stroke-width="2"/>'),
  back: svg('<path d="M11.5 3.4 6 8l5.5 4.6ZM4.2 3.2v9.6"/>'),
  forward: svg('<path d="M4.5 3.4 10 8l-5.5 4.6ZM11.8 3.2v9.6"/>'),
  loop: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.3 2.4v3.1h-3.1"/>'),
  sliders: svg('<path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>'),
  braces: svg('<path d="M6 3C4.6 3 4.2 3.8 4.2 5v1.2c0 .9-.5 1.6-1.4 1.8.9.2 1.4.9 1.4 1.8V11c0 1.2.4 2 1.8 2M10 3c1.4 0 1.8.8 1.8 2v1.2c0 .9.5 1.6 1.4 1.8-.9.2-1.4.9-1.4 1.8V11c0 1.2-.4 2-1.8 2"/>'),
};

/* ── tiny helpers ───────────────────────────────────────────────────────── */

const clone = (v) => structuredClone(v);

function getIn(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setIn(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* A field value as the control shows it, and back again. A `unit` lets a
   number slider edit a "1080px" string in the composition. */
const toControl = (f, v) => (f.unit && typeof v === "string" ? parseFloat(v) : v);
const fromControl = (f, v) => (f.unit ? `${v}${f.unit}` : f.type === "range" || f.number ? Number(v) : v);

function fieldHtml(f) {
  const id = `f-${f.id}`;
  let control;
  if (f.type === "select") {
    control = `<select id="${id}">${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;
  } else if (f.type === "range") {
    control = `<input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" />`;
  } else {
    control = `<input id="${id}" type="${f.type}" ${f.type === "text" ? 'autocomplete="off" spellcheck="false"' : ""} />`;
  }
  const out = f.type === "range" ? `<output id="${id}-out"></output>` : "";
  return `<div class="field"><label for="${id}"><span>${esc(f.label)}</span>${out}</label>${control}</div>`;
}

/* ── the shell ──────────────────────────────────────────────────────────── */

export function mountPlayground(root, opts) {
  const { eyebrow, title, lede, page, fields = [], filename = "composition.rendr.json", note } = opts;
  let comp = clone(opts.composition);

  root.classList.add("demo");
  root.innerHTML = `
    <header class="demo-head">
      <p class="demo-eyebrow">${esc(eyebrow)}</p>
      <h1>${esc(title)}</h1>
      <p>${lede}</p>
      <nav class="demo-nav" aria-label="Examples">
        <a href="basic.html" ${page === "basic" ? 'aria-current="page"' : ""}>Basic</a>
        <a href="video.html" ${page === "video" ? 'aria-current="page"' : ""}>Video</a>
      </nav>
    </header>

    <section class="player" aria-label="Player">
      <div class="player-viewport" id="viewport" tabindex="0" role="button" aria-label="Play or pause" data-playing="false" data-ready="false" data-started="false">
        <div class="player-stage" id="stage"></div>
        <div class="player-bigplay"><span>${ICON.play}</span></div>
        <div class="player-overlay" id="overlay"><div class="spinner"></div><span id="overlay-label">Starting</span></div>
      </div>
      <div class="transport">
        <button class="btn" id="back" type="button" aria-label="Previous frame" title="Previous frame (left arrow)">${ICON.back}</button>
        <button class="btn btn-primary" id="toggle" type="button" aria-label="Play" title="Play / pause (space)">${ICON.play}</button>
        <button class="btn" id="forward" type="button" aria-label="Next frame" title="Next frame (right arrow)">${ICON.forward}</button>
        <input class="scrub" id="scrub" type="range" min="0" max="0" value="0" aria-label="Scrub" />
        <select class="rate" id="rate" aria-label="Playback rate">
          <option value="0.25">0.25x</option><option value="0.5">0.5x</option>
          <option value="1" selected>1x</option><option value="2">2x</option>
        </select>
        <button class="btn" id="loop" type="button" aria-pressed="true" aria-label="Loop" title="Loop">${ICON.loop}</button>
        <span class="readout"><strong id="tc">00:00.000</strong><span>frame <strong id="fr">0</strong> / <span id="tot">0</span></span></span>
      </div>
      <dl class="stats" id="stats"></dl>
    </section>

    <div class="panels">
      <section class="panel" aria-label="Edit">
        <div class="panel-head">${ICON.sliders}<span>EDIT</span><span class="spacer"></span><span class="panel-badge">calls update()</span></div>
        <div class="fields">${fields.map(fieldHtml).join("")}</div>
      </section>
      <section class="panel" aria-label="Composition JSON">
        <div class="panel-head">${ICON.braces}<span>${esc(filename)}</span><span class="spacer"></span><span class="panel-badge" id="json-badge">live</span></div>
        <textarea class="json" id="json" spellcheck="false" aria-label="Composition JSON"></textarea>
        <p class="json-error" id="json-error" hidden></p>
      </section>
    </div>
    ${note ? `<p class="demo-note">${note}</p>` : ""}
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const viewport = $("viewport"), scrub = $("scrub"), toggleBtn = $("toggle");
  const jsonEl = $("json"), jsonErr = $("json-error"), jsonBadge = $("json-badge");

  /* ── rendr ── */
  let rendr = null;
  let dragging = false;

  const pad = () => String(Math.max((rendr?.totalFrames ?? 1) - 1, 0)).length;
  const showFrame = (frame, tc) => {
    $("fr").textContent = String(frame).padStart(pad(), "0");
    $("tc").textContent = tc ?? rendr.timecode();
    if (!dragging) scrub.value = String(frame);
  };
  const syncTotals = () => {
    scrub.max = String(Math.max(rendr.totalFrames - 1, 0));
    $("tot").textContent = String(rendr.totalFrames);
  };
  const setPlaying = (playing) => {
    viewport.dataset.playing = String(playing);
    if (playing) viewport.dataset.started = "true";
    toggleBtn.innerHTML = playing ? ICON.pause : ICON.play;
    toggleBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  };
  const setOverlay = (label) => {
    $("overlay").hidden = !label;
    if (label) $("overlay-label").textContent = label;
  };

  rendr = createRendr($("stage"), clone(comp), {
    onFrame: ({ frame, timecode }) => showFrame(frame, timecode),
    onState: ({ playing }) => setPlaying(Boolean(playing)),
    /* Only the first load gets a full-picture overlay. Every later "loading"
       event is a group being decoded mid-playback, and covering the picture
       each time would flash it. */
    onLoading: ({ loading, label }) => {
      if (viewport.dataset.ready === "true") return;
      setOverlay(loading ? label || "Loading" : null);
    },
    onError: (e) => {
      console.error("rendr error", e);
      setOverlay(null);
    },
  });
  root.rendr = rendr; // handy from the console

  /* ── transport ── */
  const step = (d) => {
    rendr.pause();
    rendr.seek(Math.min(Math.max(rendr.frame + d, 0), rendr.totalFrames - 1));
  };
  toggleBtn.onclick = () => rendr.toggle();
  $("back").onclick = () => step(-1);
  $("forward").onclick = () => step(1);
  viewport.onclick = () => rendr.toggle();
  viewport.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); rendr.toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  };
  scrub.onpointerdown = () => { dragging = true; };
  scrub.onpointerup = () => { setTimeout(() => { dragging = false; }, 300); };
  scrub.oninput = () => rendr.seek(Number(scrub.value));
  $("rate").onchange = (e) => rendr.setRate(Number(e.target.value));
  const loopBtn = $("loop");
  loopBtn.onclick = () => {
    const on = loopBtn.getAttribute("aria-pressed") !== "true";
    loopBtn.setAttribute("aria-pressed", String(on));
    rendr.setLoop(on);
  };

  /* ── stats ── */
  const STAT_DEFS = [
    ["Elements", (s) => s.elements],
    ["Cached frames", (s) => s.framesHeld],
    ["Memory", (s) => `${(s.bytesHeld / 1e6).toFixed(0)} MB`],
    ["Sources", (s) => s.sources],
    ["Updates", (s) => s.reconciles],
    ["Rebuilds", (s) => s.builds],
    ["Frame cost", (s) => `${s.frameCost.toFixed(1)} ms`],
  ];
  $("stats").innerHTML = STAT_DEFS.map(([k], i) => `<div class="stat"><dt>${k}</dt><dd id="st-${i}">0</dd></div>`).join("");
  const paintStats = () => {
    const s = rendr.stats();
    STAT_DEFS.forEach(([, fn], i) => { $(`st-${i}`).textContent = fn(s); });
  };
  setInterval(paintStats, 400);

  /* ── editing: fields <-> composition <-> JSON panel ── */
  const writeJson = () => { jsonEl.value = JSON.stringify(comp, null, 2); };
  const setBadge = (state, text) => { jsonBadge.dataset.state = state; jsonBadge.textContent = text; };

  function readFields() {
    for (const f of fields) {
      const el = $(`f-${f.id}`);
      const v = toControl(f, getIn(comp, f.path));
      if (v !== undefined) el.value = v;
      if (f.type === "range") $(`f-${f.id}-out`).textContent = `${v}${f.unit ?? ""}`;
    }
  }

  const apply = async () => {
    try {
      /* update() returns a promise: a change of fps or duration changes the
         total frame count, which is only correct once it settles. */
      await rendr.update(clone(comp));
      syncTotals();
      showFrame(rendr.frame);
      paintStats();
    } catch (e) {
      console.error(e);
    }
  };

  for (const f of fields) {
    const el = $(`f-${f.id}`);
    el.addEventListener("input", () => {
      setIn(comp, f.path, fromControl(f, el.value));
      if (f.type === "range") $(`f-${f.id}-out`).textContent = `${el.value}${f.unit ?? ""}`;
      writeJson();
      setBadge("ok", "live");
      jsonErr.hidden = true;
      apply();
    });
  }

  let jsonTimer = 0;
  jsonEl.addEventListener("input", () => {
    clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => {
      try {
        comp = JSON.parse(jsonEl.value);
      } catch (e) {
        setBadge("error", "invalid");
        jsonErr.textContent = e.message;
        jsonErr.hidden = false;
        return;
      }
      jsonErr.hidden = true;
      setBadge("ok", "live");
      readFields();
      apply();
    }, 250);
  });

  writeJson();
  readFields();

  rendr.ready().then(() => {
    syncTotals();
    showFrame(0);
    rendr.setLoop(true);
    viewport.dataset.ready = "true";
    setOverlay(null);
    paintStats();
  });

  return rendr;
}
