#!/usr/bin/env bash
# List running containers whose environment mentions Ollama, so you know
# which apps to repoint at the router. Run on the mini PC.
set -euo pipefail
for c in $(docker ps --format '{{.Names}}'); do
  hits=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" \
    | grep -iE '11434|ollama' | grep -viE 'key|token|secret|password' || true)
  if [ -n "$hits" ]; then
    echo "== $c"
    echo "$hits" | sed 's/^/   /'
  fi
done
echo
echo "Apps configured in their own UI (e.g. Open WebUI, n8n) won't show up here; check their settings too."
