# rendr-web

A rendering runtime for the browser. It takes a composition, a JSON document describing what appears, where, and when, and draws any frame of it into a DOM element you give it.

This is the browser half of **Rendr**, the video rendering engine behind the live demos on [ayoubelomari.online](https://www.ayoubelomari.online/project/rendr). The same code runs those demos in your tab. Frame capture (CEF and shared memory) and encoding (FFmpeg) are separate and not in this repo.

```js
import { createRendr } from "./rendr-web/index.js";

const rendr = createRendr(hostElement, composition, {
  onFrame: ({ frame, time }) => {},
});
await rendr.ready();
rendr.play();
```

No dependencies and no framework. Video is decoded natively through WebCodecs, and the MP4 demuxer (`media/mp4box.js`) is only loaded when a composition actually contains a video.

## Why it exists

The original Rendr engine was built for a host process that renders a file once, front to back, then exits. That shape is wrong for a web page, where the same runtime has to survive being edited, scrubbed, replayed, and left open for an hour on a phone.

| The original assumed | A page actually does |
| --- | --- |
| One composition, loaded once | The composition changes on every keystroke |
| Frames are rendered in order, once each | The reader scrubs backwards, jumps, replays |
| Memory is reclaimed when the process exits | Nothing is reclaimed unless the code reclaims it |
| The machine is ours | One tab, on a phone, next to other tabs |
| Rendering ends | It doesn't |

Three failures forced the rewrite:

- **Decoded frames were cached as `ImageBitmap`s.** A group of pictures at 854x480 is about 20 MB of GPU-backed textures, several groups were held at once, and garbage collection does not reclaim them. The fix is not a smaller cache. A renderer showing frame *n* only needs frame *n*, so a decoded frame is drawn and released straight away.
- **A `VideoDecoder` was constructed per group and never closed.** Platforms allow only a handful of hardware decoders at once. The fix is one decoder per source, reused.
- **Every edit rebuilt the whole engine.** Teardown, reload, re-decode, re-mount, about 30 `<style>` nodes replaced. The fix is to diff the new composition against the old one and touch only what changed.

## The one constraint that is not obvious

**A decoded frame you are holding is a buffer the decoder cannot decode into.**

Hardware decoders own a small, fixed pool of output buffers. An application that retains `VideoFrame`s faster than it releases them does not use more memory. It stalls the decoder, with no error and nothing on the console. This was measured during the build:

```
12 chunks fed -> 9 frames out -> flush() pending forever -> no error
```

`VideoSource` therefore never holds a decoder frame. The output callback draws each frame onto an `OffscreenCanvas`, takes a synchronous `ImageBitmap`, and closes the frame, so the decoder holds at most one buffer at a time however long the group is. The cache then holds bitmaps, which the decoder has no claim on, and is bounded by an explicit memory budget instead of by the decoder's pool.

An earlier version kept at most four `VideoFrame`s alive to stay under that pool. That was correct and it was also the cause of visible stutter: every fourth frame blocked on a decode. Copying out instead costs RGBA memory (4 bytes a pixel instead of the codec's 1.5) and buys a cache as deep as you want to pay for.

Two more things keep playback smooth:

- **Prefetch.** Every frame request also checks that the next `lookahead` frames are cached, and decodes the next group in the background if not, wrapping to the start for looping. Decoding runs several times faster than real time, so the frames are waiting when the playhead arrives. Only a seek outside the cache waits.
- **Group-level eviction.** Per-frame LRU is backwards for playback (the frame just shown is the newest and the frames about to be shown are the oldest), so groups are stamped when any of their frames is requested and evicted whole. The group being played and the one being prefetched are the last to go.

The budget is per source and scales with the device tier (`high` 384 MB, `mid` 192 MB, `low` 64 MB), which is about 109 frames of 720p on `high`. It fills as playback proceeds, not up front. To change it:

```js
createRendr(host, composition, {
  capabilities: { frameBudgetMB: 1024, lookahead: 24 },
});
```

A related trap: a `Map.set` over an occupied key silently drops the old value, and here the old value is a frame. Looping playback decodes the same group again on every pass, producing frames with the same timestamps, so each loop stranded a group's worth until the outgoing frame was closed first.

## Principles

1. **Bounded by construction.** Every cache has a stated ceiling derived from the device (`runtime/Capabilities.js`).
2. **A decoder's frames are never held.** Each is copied to a bitmap and closed immediately. The cache holds bitmaps against a memory budget.
3. **Updates are diffs.** `update(json)` reconciles. Rebuilding is the fallback for a structural change.
4. **The runtime owns time.** Play, pause, seek, rate and looping live here, so a host never re-implements a frame clock.
5. **The host subscribes, it does not poll.** Events carry the frame number.
6. **Nothing is global.** Two instances on one page share nothing but the module.

## API

```js
const rendr = createRendr(stageElement, composition, {
  onFrame:   ({ frame, time }) => {},
  onState:   ({ playing, ready }) => {},
  onLoading: ({ loading, label }) => {},
  onError:   (err) => {},
});

await rendr.ready();

rendr.update(nextComposition);   // reconciles, does not reboot

rendr.play(); rendr.pause(); rendr.toggle();
rendr.seek(120);                 // by frame
rendr.seekTime(4.5);             // by seconds
rendr.setRate(0.5);              // 0.25 to 4
rendr.setLoop(true);

rendr.frame; rendr.totalFrames; rendr.time; rendr.duration;
rendr.fps; rendr.resolution; rendr.aspect;
rendr.playing; rendr.timecode();
rendr.stats();                   // frame cost, decoder count, bytes held

rendr.destroy();
```

`createRendr(host, ...)` takes a box you size. The runtime builds its own stage inside it and owns sizing, fit, clipping and teardown. A `ResizeObserver` refits on every change, so responsive layouts and rotation need no help from the host.

### The smallest composition

Enough to see something move, with no assets and therefore no demuxer:

```js
const composition = {
  rendr: "v2.1.0",
  settings: { fps: 30, resolution: [1280, 720] },
  variables: { accent: "#e6e6e6" },
  timeline: [
    {
      id: "box",
      type: "Text",
      at: "00:00:00.000",
      duration: "00:00:02.000",
      config: { content: "" },
      style: {
        "&": {
          position: "absolute",
          top: "310px",
          width: "100px",
          height: "100px",
          background: "@variables:accent",
          left: {
            keyframes: [
              { at: "0%", value: "100px", easing: "easeOutCubic" },
              { at: "100%", value: "1080px" },
            ],
          },
        },
      },
    },
  ],
};
```

Two rules that are easy to trip on:

1. **The authoring space is always 1280 wide.** Height follows the ratio (16:9 gives 720, 1:1 gives 1280, 9:16 gives 2276). `settings.resolution` only scales the output, it does not move a coordinate. Changing the aspect ratio is a second layout, not a setting.
2. **A `@ref` only substitutes when it is the whole string.** `"color": "@variables:accent"` works. `"border": "1px solid @variables:accent"` passes through unsubstituted and the CSS parser silently drops the line. Split shorthands.

## Measured

On a sandbox composition (16 s, two clips, a photograph, word-synced captions, 29 resolved elements), desktop browser:

| | Old engine | rendr-web |
| --- | --- | --- |
| `VideoDecoder`s created | one per group, never closed (12 live after boot alone) | one per source, reused |
| Decoded frames held | a whole group per source, unbounded, as RGBA `ImageBitmap`s | up to a per-source byte budget (~109 at 720p on `high`), as RGBA `ImageBitmap`s, filled on demand |
| `<style>` nodes | ~29, plus 29 more per reboot | 1 adopted stylesheet, 0 nodes |
| An edit | full teardown and rebuild | reconcile (11 edits, `builds` stayed 1) |
| Frame cost, warm | ~1-2 ms | ~2.7 ms (does more per frame: bounded decode) |
| 6 aspect-ratio swaps | flat after fixes | flat (DOM 8950 to 8950) |

Determinism holds: render a frame, go far away, come back, and the stage's HTML is byte-identical.

The table above predates the bitmap cache and prefetch described earlier, except the "Decoded frames held" row. The effect of that change on playback, measured on a 720p, 30 fps clip with a frame requested every 33 ms for 412 requests (two full passes, including the loop seam):

| | Four-frame `VideoFrame` window | Bitmap cache with prefetch |
| --- | --- | --- |
| Requests slower than 8 ms | 103 | 0 |
| Requests slower than 16 ms | 33 | 0 |
| Slowest request | 26 to 32 ms | 7.4 ms |

That run is request latency, driven by timers, not a real-time playback test: the tab it ran in was backgrounded, so the animation clock did not tick. Please check smoothness with the play button in your own browser.

## Layout

```
index.js              createRendr(), the only entry point
core/
  Rendr.js            facade: composition, stage, clock, assets
  Composition.js      JSON to a normalised, resolved, queryable model
  Reconciler.js       diff two compositions, apply the difference
  Stage.js            the DOM surface: sizing, fit, teardown
  Clock.js            playback: rAF loop, time debt, rate, seek, loop
  Emitter.js          a small event bus
elements/             Text, Image, Video, Caption + registry
animation/            keyframed tracks, easings, interpolation
media/
  AssetStore.js       ref-counted, shared, LRU-evicted
  VideoSource.js      demux + one reused decoder + bounded lookahead
  demux.js, Samples.js  mp4box wrapper, sample table and GOP arithmetic
  mp4box.js           third party (GPAC, BSD-3-Clause), not part of this project
runtime/Capabilities.js  what this device can be asked for
util/                 timecode, css, refs
```

## Try it

There is no build step. Serve the folder over http (opening the files from disk will not work, because browsers block ES modules on `file://`) and open an example:

```
python -m http.server 8765
# then open http://localhost:8765/examples/basic.html
#          http://localhost:8765/examples/video.html
```

- `examples/basic.html`: one element, one curve. Change the easing, destination, accent, or frame rate and `update()` reconciles it into the running stage. No assets, so the demuxer is never fetched.
- `examples/video.html`: a clip decoded live through WebCodecs, with editable title, subtitle, size, and accent. Needs a current Chrome, Edge, or Safari.

Each page has the same shell: a player with transport (step, play, scrub, rate, loop, and keyboard shortcuts), live stats from `rendr.stats()`, editable fields, and the composition JSON in a panel you can edit directly. Invalid JSON is flagged and ignored until it parses. The shell is plain DOM and CSS in `examples/shared/` and is not part of the library.

## Status

Used in production by the Rendr live demos. The rest of Rendr (CEF capture, shared-memory transport, encoding) is closed source for now.

## License

Source-available, all rights reserved. You can read it. You can't copy, use, or build on it without written permission. See [LICENSE](LICENSE).

`media/mp4box.js` is the GPAC project's MP4 demuxer, vendored under its own BSD-3-Clause license (see `media/MP4BOX-LICENSE.txt`). Everything else here is original work.
