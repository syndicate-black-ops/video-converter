#!/usr/bin/env bash
# Serves the page on localhost and runs e2e.mjs in the Playwright image, then checks the files with ffprobe.
#   SBO_SAMPLE=<sdk/examples/video/sbo_sample.ogv> test/run.sh [port]
# TEST_BROWSER=firefox uses Firefox, HEADED=1 a headed browser (in xvfb), ONLY_VARIANTS=1 only the real-world set,
# VARIANTS='/t/inputs/real/<file> ...' other files, PAGE_QUERY=?debug and LOGDIR=/t/out/logs for ffmpeg logs, TIMEOUT seconds for the browser run (default 2400).
# Every conversion also checks that the preview's size estimate is within 25% of the real file, and the run reports
# the browser's peak memory.
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
REAL=test/inputs/real
mkdir -p "$REAL"
# The two files from the first bug reports: a 1080p H.264 MP4 and a YouTube WebM in AV1
[ -f "$REAL/sample-5s.mp4" ] || timeout 300 curl -fsSL --max-filesize 100000000 -o "$REAL/sample-5s.mp4" https://samplelib.com/mp4/sample-5s.mp4
[ -f "$REAL/le-liyQA-Wg-av1.webm" ] || timeout 300 curl -fsSL --max-filesize 100000000 -o "$REAL/le-liyQA-Wg-av1.webm" \
  https://archive.org/download/youtube-le-liyQA-Wg/le-liyQA-Wg.webm
gen() { # <output> <ffmpeg arguments...>: made once, with real encoders
  local out=$1; shift
  [ -f "$REAL/$out" ] || timeout 600 docker run --rm --network none --memory=2g --cpus=2 -u "$(id -u):$(id -g)" --entrypoint ffmpeg \
    -v "$PWD/$REAL:/o" "$FFMPEG" -hide_banner -loglevel error -y "$@" "/o/$out"
}
SRC=(-f lavfi -i "testsrc2=s=1920x1080:r=30,noise=alls=12:allf=t" -f lavfi -i "sine=f=330:r=48000")
gen h264_4k30_aac.mp4 -f lavfi -i "testsrc2=s=3840x2160:r=30,noise=alls=12:allf=t" -f lavfi -i "sine=f=330:r=48000" -t 3 \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -c:a aac -b:a 160k
gen vp9_opus_1080p30.webm "${SRC[@]}" -t 5 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 4M -c:a libopus
gen h264_1080p60_nosound.mp4 -f lavfi -i "testsrc2=s=1920x1080:r=60" -t 5 -c:v libx264 -preset veryfast -pix_fmt yuv420p
# A phone video: HEVC, portrait by a rotation tag, variable frame rate
gen phone_hevc_rot90_vfr.mp4 -display_rotation 90 "${SRC[@]}" -t 5 -vf "select=gt(random(0)\,0.3)" -fps_mode vfr \
  -c:v libx265 -preset ultrafast -tag:v hvc1 -c:a aac
gen vp8_vorbis_mediarecorder.webm "${SRC[@]}" -t 5 -c:v libvpx -deadline realtime -cpu-used 8 -b:v 2M -c:a libvorbis -f webm -live 1
# Half of a file, which must fail with a message and leave the page working
[ -f "$REAL/broken_truncated.mp4" ] || head -c 1000000 "$REAL/sample-5s.mp4" > "$REAL/broken_truncated.mp4"
VARIANTS="${VARIANTS:-/t/inputs/real/broken_truncated.mp4 /t/inputs/real/sample-5s.mp4 /t/inputs/real/le-liyQA-Wg-av1.webm \
/t/inputs/real/h264_4k30_aac.mp4 /t/inputs/real/vp9_opus_1080p30.webm /t/inputs/real/h264_1080p60_nosound.mp4 \
/t/inputs/real/phone_hevc_rot90_vfr.mp4 /t/inputs/real/vp8_vorbis_mediarecorder.webm}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >test/out/server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
STATUS=0
rm -f test/out/peak-mb.txt test/out/mem-timeline.txt
RUN=node; [ -n "${HEADED:-}" ] && RUN="xvfb-run -a node"
timeout "${TIMEOUT:-2400}" docker run --rm --memory=3g --memory-swap=3g --cpus=2 --network host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e TEST_BROWSER="${TEST_BROWSER:-}" -e HEADED="${HEADED:-}" -e ONLY_VARIANTS="${ONLY_VARIANTS:-}" -e LOGDIR="${LOGDIR:-}" \
  -v "$PWD/test:/t" -w /tmp "$PW" sh -c "npm i --silent --no-audit --no-fund playwright@1.48.2 >/dev/null && cp /t/e2e.mjs . && \
  (sh /t/peak-mem.sh /t/out/peak-mb.txt /t/out/mem-timeline.txt &) && $RUN e2e.mjs 'http://127.0.0.1:$PORT/${PAGE_QUERY:-}' '/t/inputs/Sample Clip 10s.mp4' /t/out /t/inputs/noisy_10s.mp4 $VARIANTS" | tee test/out/report.json || STATUS=1
echo "Browser peak memory (PSS): $(cat test/out/peak-mb.txt 2>/dev/null) MB"
for f in test/out/*--*.og?; do
  echo "== $f"
  timeout 60 docker run --rm --memory=1g --cpus=1 --entrypoint ffprobe -v "$PWD/$f:/f:ro" "$FFMPEG" -v error \
    -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,sample_rate,channels -of compact /f
done
exit $STATUS
