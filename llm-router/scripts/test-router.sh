#!/usr/bin/env bash
# Ask the router a question and show which backend answered.
# usage: scripts/test-router.sh [router_url]   (default http://localhost:4000)
set -euo pipefail
cd "$(dirname "$0")/.."
url=${1:-http://localhost:4000}
key=$(grep -E '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)

headers=$(mktemp); trap 'rm -f "$headers"' EXIT
body=$(curl -sS -D "$headers" "$url/v1/chat/completions" \
  -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"Reply with one short sentence."}]}')

backend=$(grep -i '^x-litellm-model-id:' "$headers" | cut -d' ' -f2 | tr -d '\r')
echo "backend: ${backend:-unknown}"
echo "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"] if "choices" in d else d)'
