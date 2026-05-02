# CLAUDE.md

## Project Overview

Snitch is the IRC ↔ Discord bridge for #amiantos. It connects to libera as `EyeBridge` and to a single Discord channel, forwarding messages between them in both directions. It also exposes HTTP endpoints for GitHub and Discourse webhooks and announces those events to both networks via the same bridge.

Snitch was split out of `impostor` (the Isaac IRC bot at `~/Coding/impostor`) — the two share an IRC channel but no code. They each connect to libera with their own nick.

## Development Commands

```bash
npm run dev      # nodemon
npm start        # production
npm test         # node:test runner

./start.sh       # docker compose down && up --build -d
./stop.sh
```

## Architecture

### Entry Point
- **index.js**: Loads config, creates Logger / TopicStore / DiscordBridge, mounts webhook routers on a tiny Express app.

### Classes (`classes/`)

| Class | Purpose |
|-------|---------|
| **DiscordBridge** | Owns both Discord (discord.js) and IRC (irc-framework) connections. Forwards messages each way, handles `!topic` / `!op` admin commands via ChanServ, restores persistent topic on drift |
| **TopicStore** | Tiny JSON-backed key-value store (`data/topics.json`) for the persistent channel topic |
| **ChannelLog** | First-class IRC channel archiver. Subscribes to the bridge's IRC client, appends every channel event (chat, actions, joins/parts/quits, modes, nick/topic changes) to a per-month log file. Optionally tails last N lines and PUTs to R2 every interval |
| **Logger** | Same shape as impostor's |
| **admin_commands** | Pure parser for `!command args` syntax |
| **github_webhook** | Express router factory; verifies HMAC, formats events, calls `bridge.announce()` |
| **discourse_webhook** | Same pattern for Discourse `post_created` events |
| **postalgic_webhook** | Same pattern for Postalgic `post.share` events; output is `[blog] title - excerpt <permalink>` |
| **message_splitter** | Wraps long IRC lines on word/URL boundaries |

### Wire format (the contract with Isaac)

When EyeBridge relays a Discord message into IRC, the IRC line is:

```
[Discord] <DisplayName> the message
```

When EyeBridge relays an IRC message into Discord, the Discord message is:

```
[#amiantos] <**nick**> the message
```

(Boldness on the nick is for Discord rendering; the IRC side bolds nothing.)

Isaac (in the impostor repo) parses the IRC form via `classes/bridge_parser.js` to extract the real Discord username when responding. **If you change this format, update `bridge_parser.js` in impostor too.**

## Configuration

- **conf/config.json**: All settings (gitignored)
- **conf/config.json.example**: Template

## State

- `data/topics.json`: `{ "#channel": "last topic set via !topic" }`. Atomic writes (tmp + rename).
- `data/logs/${channel}-YYYY-MM.log`: append-only channel archive, one file per month (UTC boundaries). Lounge-format lines:
  - `[ISO] <nick> message` — chat
  - `[ISO] * nick message` — `/me` action
  - `[ISO] -nick- message` — channel notice
  - `[ISO] *** nick (~ident@host) joined` / `left` / `quit`
  - `[ISO] *** target was kicked by kicker (reason)`
  - `[ISO] *** nick set mode +o othernick`
  - `[ISO] *** oldnick is now known as newnick`
  - `[ISO] *** nick changed topic to 'text'`

  **Outgoing messages** (Discord-bridged + webhook announcements) are recorded too via explicit `recordSent()` calls in `discord_bridge.js` — `irc-framework` doesn't echo our own privmsgs through the listener.

  The R2 upload is just `tail(N)` of the archive PUT every `interval_seconds`. Tail spans monthly file boundaries so the upload always has continuity. Skip-if-unchanged check avoids no-op PUTs.

  Wire format on disk == wire format uploaded == what `bradroot.me/website/js/irc-chat.js` parses. If you change the format, that parser needs updating.

## Webhooks

- `POST /webhook` → GitHub (X-Hub-Signature-256, sha256 HMAC)
- `POST /discourse-webhook` → Discourse (X-Discourse-Event-Signature, sha256 HMAC)
- `POST /postalgic-webhook` → Postalgic (X-Postalgic-Signature, sha256 HMAC; only `post.share` is acted on)

All three consume the raw request body for signature verification (captured in `index.js` middleware).
