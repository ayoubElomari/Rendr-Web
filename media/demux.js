import { createFile, DataStream } from "./mp4box.js";

/**
 * mp4 → a sample table and a decoder config.
 *
 * Demuxing is separating the compressed frames from the container without
 * decoding any of them. It is the cheap half of video, and the half worth doing
 * once and keeping: the samples are the compressed bytes, which are small, while
 * decoded frames are enormous. That asymmetry is why `VideoSource` can throw away
 * every decoded frame and still come back in one GOP's time — it never throws
 * this away.
 *
 * The whole file is loaded. The original trimmed the sample table to a
 * `startFrame`/`nbFrames` window, which was a per-*asset* trim and therefore
 * fought with two elements wanting different parts of one clip; that now belongs
 * to the element as an in-point.
 */
export async function demux(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    let track = null;

    mp4.onError = (err) => reject(new Error(`Demux failed: ${err}`));

    mp4.onReady = (info) => {
      track = info.videoTracks?.[0];
      if (!track) {
        reject(new Error("No video track — this file has no picture in it."));
        return;
      }

      /* The codec-private description (SPS/PPS for H.264 and its equivalents).
         WebCodecs needs it to configure a decoder for anything but Annex-B, and
         mp4box keeps it in a box whose name depends on the codec. */
      const entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        /* The first 8 bytes are the box header, which is not part of the
           description the decoder wants. */
        track.description = stream.buffer.slice(8);
      }

      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();
    };

    mp4.onSamples = (_id, _user, samples) => {
      /* Frames are stored in decode order and shown in display order — they
         differ whenever the encoder used B-frames. mp4box hands us decode order;
         sorting by composition timestamp recovers display order, and the map
         between the two is what lets a caller ask for "frame 47" and mean the
         47th frame someone sees. */
      const displayToDecodeIndex = new Map(
        samples
          .map((sample, index) => ({ index, cts: sample.cts }))
          .sort((a, b) => a.cts - b.cts)
          .map(({ index }, displayIndex) => [displayIndex, index]),
      );

      resolve({
        samples,
        displayToDecodeIndex,
        config: {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          optimizeForLatency: true,
          ...(track.description && { description: track.description }),
        },
        properties: {
          width: track.video.width,
          height: track.video.height,
          frameCount: samples.length,
          fps: track.nb_samples / (track.duration / track.timescale),
        },
      });
    };

    const buffer = arrayBuffer;
    buffer.fileStart = 0;
    mp4.appendBuffer(buffer);
    mp4.flush();
  });
}
