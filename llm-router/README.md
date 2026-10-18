# LLM router

One always-on LLM endpoint for the apps on the mini PC. Requests go to the
RTX 4090 (Ollama on the main PC) when it's on, and to Infomaniak's hosted AI
API when it's off. Apps don't notice the switch.

```
apps ──► litellm :4000 (mini PC) ──► ollama-gw (nginx) ──► Ollama on main PC   [preferred]
                                 └──► Infomaniak AI API (Switzerland)          [fallback]
```

## How failover behaves

Measured against stand-in backends with this exact config:

| Situation | What happens |
|---|---|
| Main PC on | 4090 answers |
| Ollama stopped / PC refuses connections | Infomaniak answers, no noticeable delay |
| PC off and its address silent (common over Wi-Fi/VPN) | First request takes ~4 s (3 s connect timeout), then Infomaniak answers instantly |
| PC comes back | 4090 is retried after at most 60 s and takes over again |

Every response carries an `x-litellm-model-id` header (`local-4090` or
`infomaniak`) saying which one answered.

## Setup

1. **Infomaniak AI Tools.** Activate AI Tools in the Infomaniak Manager, note
   its product id, and create an API token with the `ai_tools` scope.
2. **Ollama on the main PC** must accept LAN connections
   (`OLLAMA_HOST=0.0.0.0`). If your apps already reach it from the mini PC,
   it does.
3. **On the mini PC:**
   ```sh
   cp .env.example .env    # fill in the values
   docker compose up -d
   scripts/test-router.sh  # prints which backend answered
   ```
   Run the test once with the main PC on and once with it off.

## Pointing apps at the router

| Setting | Value |
|---|---|
| Base URL | `http://<mini-pc-ip>:4000/v1` |
| API key | `LITELLM_MASTER_KEY` from `.env` |
| Model | `chat` |

`scripts/find-ollama-clients.sh` lists running containers whose environment
mentions Ollama.

The router speaks the **OpenAI API** (`/v1/chat/completions`). Apps using
Ollama's native API (`/api/chat`, `/api/generate`, or an "Ollama" connection
type) need to be switched to their "OpenAI-compatible" connection option; most
apps have one (Open WebUI, n8n, Home Assistant, Continue, …).

## Things to know

- **Embeddings: keep them out of the router.** Vectors from different models
  can't be mixed. An app that indexes documents with an Ollama embedding model
  must keep using that same model, so leave its embedding setting pointed at
  Ollama directly.
- **Different model when the PC is off.** The fallback model
  (`INFOMANIAK_MODEL`) is not the one on your 4090, so answers can differ in
  style and quality. Bigger models appear in Infomaniak's list as "coming soon";
  switch `INFOMANIAK_MODEL` when one becomes available.
- **Privacy.** While the PC is off, prompts go to Infomaniak (hosted in
  Switzerland) instead of staying on your network.
- **Cost.** Infomaniak bills per request only while the 4090 is off.
- **Only the master key works.** LiteLLM's per-app keys need a database, which
  this setup doesn't run.

## Adding more models

Each model your apps request is a model group in `config.yaml`. Copy the two
`chat` entries, give them a new `model_name` (e.g. `coder`) and new `id`s, and
set the Ollama and Infomaniak models for that group. Keep both entries in the
same group: failover only works within one.
