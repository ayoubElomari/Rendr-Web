/**
 * Apply the difference between two compositions.
 *
 * The original rebuilt everything on every change: tear down the renderer, refetch
 * and re-demux the media, re-resolve every reference, re-mount every element,
 * replace thirty `<style>` nodes. It was debounced to make that survivable, which
 * is the tell — you debounce something because it is too expensive to do when it
 * is actually asked for.
 *
 * An edit is a diff. Dragging a number changes one property of one element; the
 * other twenty-two are unchanged and there is no reason for any of them to notice.
 *
 * ── What counts as "the same element" ──────────────────────────────────────
 *
 * `spec.key`, assigned by `Composition` and stable across edits (the file's own
 * `id`, or position, or `parent/childIndex` for a component's expansion). Without
 * a stable key, nothing here is possible — every edit would look like "everything
 * was removed and different things were added".
 *
 * ── The three outcomes ─────────────────────────────────────────────────────
 *
 *   kept      same key, same type → adopt the new spec in place. Styling is a
 *             rule rewrite; timing is two numbers; content is a text swap.
 *   replaced  same key, different type → the DOM it needs is different, so it is
 *             rebuilt. Rare, and honest when it happens.
 *   added/removed  self-explanatory.
 *
 * Assets are handled by the store, not here: a clip referenced by both the old
 * and new composition is retained before the old one is released, so it never
 * touches zero and never gets torn down mid-edit.
 */
export function reconcile(previous, next) {
  const before = new Map(previous.map((element) => [element.key, element]));
  const kept = [];
  const added = [];
  const replaced = [];

  for (const spec of next) {
    const existing = before.get(spec.key);
    if (!existing) {
      added.push(spec);
      continue;
    }
    before.delete(spec.key);
    if (existing.canAdopt(spec)) kept.push({ element: existing, spec });
    else replaced.push({ element: existing, spec });
  }

  return { kept, added, replaced, removed: [...before.values()] };
}

/**
 * Whether two specs differ in a way that needs the stylesheet rewritten.
 *
 * Compared as JSON, which is cheap here (a style block is small) and exact. The
 * alternative — a deep structural compare — costs more to write, more to read,
 * and is wrong more often.
 */
export function styleChanged(a, b) {
  return JSON.stringify(a.style) !== JSON.stringify(b.style);
}

/** Whether an element's window on the frame axis moved. */
export function timingChanged(a, b) {
  return a.at !== b.at || a.duration !== b.duration;
}
