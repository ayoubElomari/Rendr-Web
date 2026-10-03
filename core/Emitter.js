/**
 * A small event bus.
 *
 * This exists so a host can watch playback without re-rendering to find out
 * what happened. The demo this was built for drove its transport from React
 * state, which meant every frame of playback re-rendered an editor containing an
 * 800-line JSON view — sixty times a second, on a phone. Events let the readout
 * update and nothing else.
 *
 * A listener that throws must not take the frame loop down with it, so handlers
 * are isolated. The error is reported rather than swallowed.
 */
export default class Emitter {
  #listeners = new Map();

  on(event, handler) {
    if (typeof handler !== "function") return () => {};
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this.#listeners.get(event);
    if (!handlers?.size) return;
    /* Copied before iterating: a handler is allowed to unsubscribe itself, and
       mutating the set mid-iteration would skip its neighbour. */
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        if (event === "error") throw err;
        this.emit("error", err);
      }
    }
  }

  clear() {
    this.#listeners.clear();
  }
}
