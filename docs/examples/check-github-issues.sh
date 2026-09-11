#!/usr/bin/env bash
# Example looper check script: "are there open bug issues to work on?"
#
# Contract: the LAST line of stdout must be a JSON object:
#   {"act": true|false, "summary": "one line", "context": <anything>}
# Exit non-zero (or print no JSON) to report an ERROR — errors never start an agent.
#
# Requires: gh (authenticated), run inside the repo (looper sets cwd for you).
set -euo pipefail

issues=$(gh issue list --label bug --state open --json number,title,url --limit 20)
count=$(printf '%s' "$issues" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')

if [ "$count" -gt 0 ]; then
  printf '{"act": true, "summary": "%s open bug issue(s)", "context": %s}\n' "$count" "$issues"
else
  echo '{"act": false, "summary": "no open bug issues"}'
fi
