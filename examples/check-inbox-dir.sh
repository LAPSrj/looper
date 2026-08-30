#!/usr/bin/env bash
# Example looper check script: "did any new files land in an inbox directory?"
# Cheapest possible check — no network, no tokens. Pair it with a classifier
# if the files need judgement before an agent is worth starting.
set -euo pipefail

dir="${1:-inbox}"
files=$(find "$dir" -maxdepth 1 -type f -newer "$dir/.looper-seen" 2>/dev/null || find "$dir" -maxdepth 1 -type f 2>/dev/null || true)

if [ -n "$files" ]; then
  list=$(printf '%s\n' "$files" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n"))))')
  touch "$dir/.looper-seen"
  printf '{"act": true, "summary": "new files in %s", "context": {"files": %s}}\n' "$dir" "$list"
else
  echo '{"act": false, "summary": "no new files"}'
fi
