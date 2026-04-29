# Snitch

A bidirectional IRC ↔ Discord bridge that lives in #amiantos as `EyeBridge`. Also fronts the GitHub and Discourse webhook receivers and announces events to both networks.

Split out of [impostor](https://github.com/amiantos/impostor) (the Isaac IRC bot) — the bridge has no dependency on Isaac and runs as its own process.

## What it does

- Mirrors messages between an IRC channel (libera) and a Discord channel.
  - IRC → Discord: `[#channel] <**Username**> message`
  - Discord → IRC: `[Discord] <Username> message`
- Resolves Discord mentions, role mentions, channel mentions, and custom emoji to readable text.
- `!topic <text>` and `!op [nick]` admin commands routed through ChanServ for allowed cloaks.
- Persists the configured channel topic in `data/topics.json` and restores it if drift is detected.
- HTTP endpoints for GitHub (`/webhook`) and Discourse (`/discourse-webhook`) webhooks; verifies HMAC signatures and announces formatted notifications to both networks.

## Setup

```sh
git clone <repo>
cd snitch
npm install
cp conf/config.json.example conf/config.json
# Edit conf/config.json with your Discord token, IRC SASL credentials, webhook secrets
npm start
```

Or with Docker:

```sh
./start.sh   # docker compose down && up --build -d
./stop.sh
```

## Config sections

| Key | Purpose |
|---|---|
| `discord` | Discord bot token, channel ID, IRC nick (`EyeBridge`), SASL password, admin allowed hosts |
| `irc` | Libera connection details (host, port, tls, max_line_length) |
| `github_webhook` | HMAC secret for GitHub deliveries |
| `discourse_webhook` | HMAC secret + base URL for Discourse instance |
| `web` | Port for the webhook HTTP server (default 3002) |

## Tests

```sh
npm test
```

Covers admin command parsing, GitHub webhook formatters, and Discourse webhook formatters/HMAC verification.
