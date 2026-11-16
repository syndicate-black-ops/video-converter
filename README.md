# SBO Video Converter

Turns a video into an `.ogv` for Syndicate Black Ops 2.0.0, or its sound into an `.ogg`. It runs in your browser,
so your video is never uploaded.

https://syndicate-black-ops.github.io/video-converter/

## Use

1. Drop a video on the page
2. Change the settings if you want to, and click Convert
3. Click Save, and put the file in your map's folder in `Half-Life/syndicate/video`

The [Video page](https://sbo.sbotnas.io/mapping/features/video#making-a-video-file) of the docs
explains the settings, the limits and how to play the file in a map.

## Run it locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/. Opening `index.html` as a file doesn't work.

`test/run.sh` converts two short clips in headless Chromium and checks the files with ffprobe (needs Docker).

## GitHub Pages

Settings > Pages > Deploy from a branch > `main`, folder `/ (root)`. There is no build step.

## License

The page is MIT-0 ([LICENSE](LICENSE)).

`vendor/` holds [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) from npm, unchanged
(`sha256sum -c vendor/SHA256SUMS`):

- `vendor/ffmpeg/`: `@ffmpeg/ffmpeg` 0.12.15, MIT ([LICENSE](vendor/ffmpeg/LICENSE))
- `vendor/core/`: `@ffmpeg/core` 0.12.10, FFmpeg built with GPL parts (x264, x265), so GPL 2.0 or later
  ([COPYING](vendor/core/COPYING)); its source is attached to the first release ([SOURCE.txt](vendor/core/SOURCE.txt))
