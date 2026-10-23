#!/usr/bin/env bash
# Puts the demo projects, the webapp's git history, and the demo Claude Code transcripts where the
# demo tasks expect them: ~/looper-demo (demo/home's tasks name /home/leandro/looper-demo).
# An existing ~/looper-demo is left as it is.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/looper-demo"
if [ -d "$dest" ]; then
  echo "demo projects: $dest already there"
  exit 0
fi
cp -r "$here/demo/projects" "$dest"
tmp="$(mktemp -d)"
git clone -q --no-checkout "$here/demo/webapp.bundle" "$tmp/webapp"
mv "$tmp/webapp/.git" "$dest/webapp/.git"
rm -rf "$tmp"
git -C "$dest/webapp" remote remove origin
git -C "$dest/webapp" reset -q
transcripts="$HOME/.claude/projects/$(printf '%s' "$dest/webapp" | tr '/.' '--')"
mkdir -p "$transcripts"
cp -n "$here/demo/claude-projects/"*.jsonl "$transcripts/"
echo "demo projects: set up $dest"
