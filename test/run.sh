#!/usr/bin/env bash
# Serves the page on localhost and runs e2e.mjs in the Playwright image, then checks the files with ffprobe.
#   test/run.sh [port]
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-8231}
FFMPEG=linuxserver/ffmpeg@sha256:f4191c1abe18d75c49a23f7224d1403d55334f80013a47cb096f5056cf19617b
PW=mcr.microsoft.com/playwright:v1.48.2-jammy
IN="test/inputs/Sample Clip 10s.mp4"
mkdir -p test/inputs test/out
if [ ! -f "$IN" ]; then
  # 10 s from the SDK's sample video (6 s, played twice), as H.264 + AAC
  timeout 120 docker run --rm --memory=1g --cpus=2 -u "$(id -u):$(id -g)" --entrypoint ffmpeg \
    -v "${SBO_SAMPLE:?SBO_SAMPLE=path to sdk/examples/video/sbo_sample.ogv}:/in.ogv:ro" -v "$PWD/test/inputs:/o" "$FFMPEG" \
    -hide_banner -loglevel error -y -stream_loop 1 -i /in.ogv -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k "/o/Sample Clip 10s.mp4"
fi
NOISY=test/inputs/noisy_10s.mp4
if [ ! -f "$NOISY" ]; then
  # 10 s of picture noise, which needs the full bitrate (the 10 MB warning)
  timeout 300 docker run --rm --memory=1g --cpus=2 -u "$(id -u):$(id -g)" --entrypoint ffmpeg -v "$PWD/test/inputs:/o" "$FFMPEG" \
    -hide_banner -loglevel error -y -f lavfi -i "color=gray:s=960x540:r=24,noise=alls=100:allf=t" -f lavfi -i "sine=f=440:r=44100" \
    -t 10 -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k /o/noisy_10s.mp4
fi
python3 -m http.server "$PORT" --bind 127.0.0.1 >test/out/server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
timeout 900 docker run --rm --memory=3g --memory-swap=3g --cpus=2 --network host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/test:/t" -w /tmp "$PW" sh -c "npm i --silent --no-audit --no-fund playwright@1.48.2 >/dev/null && cp /t/e2e.mjs . && \
  node e2e.mjs http://127.0.0.1:$PORT/ '/t/inputs/Sample Clip 10s.mp4' /t/out /t/inputs/noisy_10s.mp4" | tee test/out/report.json
for f in test/out/*--*.og?; do
  echo "== $f"
  timeout 60 docker run --rm --memory=1g --cpus=1 --entrypoint ffprobe -v "$PWD/$f:/f:ro" "$FFMPEG" -v error \
    -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,sample_rate,channels -of compact /f
done
