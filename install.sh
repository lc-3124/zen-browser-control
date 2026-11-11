#!/usr/bin/env bash
# Install zbr + zserver and the agent skill into the current user's home.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${ZBR_HOME:-$HOME/.local/share/dsh-browser}"
SKILLS="${DSH_SKILLS:-$HOME/.dsh/skills}"
SKILL_DIR="$SKILLS/zen-browser-control"
RESTART=0
for a in "$@"; do [ "$a" = "--restart" ] && RESTART=1; done

mkdir -p "$DEST" "$SKILL_DIR" "$HOME/.local/bin"
cp "$ROOT/src/zserver.mjs" "$DEST/zserver.mjs"
cp "$ROOT/src/zbr.mjs" "$DEST/zbr.mjs"
chmod +x "$DEST/zserver.mjs" "$DEST/zbr.mjs"
ln -sfn "$DEST/zbr.mjs" "$HOME/.local/bin/zbr"
cp "$ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"

echo "installed:"
echo "  $DEST/zserver.mjs"
echo "  $DEST/zbr.mjs  ->  $HOME/.local/bin/zbr"
echo "  $SKILL_DIR/SKILL.md"

if [ "$RESTART" = "1" ] && [ -f "$DEST/zserver.pid" ]; then
  PID="$(cat "$DEST/zserver.pid" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "restarting bridge (pid $PID)…"
    kill -TERM "$PID" 2>/dev/null || true
    sleep 1
  fi
fi
echo "done. run: zbr doctor"
