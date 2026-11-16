#!/bin/sh
# Writes the highest total memory (PSS, so shared pages count once) of the browser's processes to $1, every 0.5 s.
peak=0
while :; do
  total=0
  for d in /proc/[0-9]*; do
    case "$(cat "$d/comm" 2>/dev/null)" in
      *chrom*|*Chrom*|*headless*|*firefox*|*Web\ Content*|*Isolated*|*RDD*|*Socket*|*GPU*|*Utility*|*Privileged*|*WebExtensions*|*Network*)
        p=$(awk '/^Pss:/ {print $2}' "$d/smaps_rollup" 2>/dev/null)
        total=$((total + ${p:-0})) ;;
    esac
  done
  [ "$total" -gt "$peak" ] && peak=$total && echo $((peak / 1024)) > "$1"
  sleep 0.5
done
