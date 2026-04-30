#!/usr/bin/env node
// Backfills snitch's per-month channel archive from existing IRC client
// logs (The Lounge and/or Weechat). Reads both source logs, normalizes
// each line into the snitch archive format `[ISO] body`, sorts and
// deduplicates the union, buckets by UTC month, and merges into
// data/logs/${channel}-YYYY-MM.log.
//
// Idempotent: re-running merges with whatever's on disk via the same
// dedup pass, so it's safe to run multiple times. SAFE only when
// snitch is stopped — otherwise the live process can append between
// our read and write.

const fs = require("fs");
const path = require("path");

const args = require("util").parseArgs({
  options: {
    channel: { type: "string" },
    "out-dir": { type: "string" },
    lounge: { type: "string" },
    weechat: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
}).values;

if (!args.channel || !args["out-dir"]) {
  console.error(
    "Usage: backfill-from-irc-logs.js --channel <#name> --out-dir <path> [--lounge <file>] [--weechat <file>] [--dry-run]"
  );
  process.exit(1);
}

const CHANNEL = args.channel;
const OUT_DIR = args["out-dir"];

// --- The Lounge parser ---
// Lines: `[ISO] body` where body is already in our target format.
// Skip lines with `set mode` and `changed host` from the Lounge format
// (Lounge logs noise that bradroot.me's parser already drops); but for
// archival we keep everything.
function parseLoungeLine(line) {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s(.*)$/);
  if (!m) return null;
  return { ts: m[1], body: m[2] };
}

// --- Weechat parser ---
// Lines: `YYYY-MM-DD HH:MM:SS.uuuuuuZ\tcol2\tcol3`
// col2 is one of `--`, `-->`, `<--`, ` *`, or a real nick (possibly
// prefixed with `+` or `@`).
const WC_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\d*Z$/;

function parseWeechatLine(line, channel) {
  const cols = line.split("\t");
  if (cols.length < 3) return null;
  const [tsRaw, marker, ...rest] = cols;
  const text = rest.join("\t");
  const m = tsRaw.match(WC_TS);
  if (!m) return null;
  const ts = `${m[1]}T${m[2]}.${m[3]}Z`;

  // Real-nick (chat or voice/op-prefixed nick): treat as privmsg.
  if (!["--", "-->", "<--", " *"].includes(marker)) {
    return { ts, body: `<${marker}> ${text}` };
  }

  // /me action: ` *\tnick action_text`
  if (marker === " *") {
    const sp = text.indexOf(" ");
    if (sp === -1) return null;
    const nick = text.slice(0, sp);
    const action = text.slice(sp + 1);
    return { ts, body: `* ${nick} ${action}` };
  }

  // Join: `-->\tnick [realname?] (gecos?) (ident@host) has joined #chan`
  if (marker === "-->") {
    const j = text.match(/^(\S+)\s+.*?\((~?\S+@\S+)\)\s+has joined/);
    if (!j) return null;
    return { ts, body: `*** ${j[1]} (${j[2]}) joined` };
  }

  // Quit/Part: `<--\tnick (ident@host) has quit (reason)` OR `... has left #chan (reason)`
  if (marker === "<--") {
    const q = text.match(/^(\S+)\s+\((~?\S+@\S+)\)\s+has quit\s*(?:\((.*)\))?$/);
    if (q) {
      const reason = q[3] ? ` (${q[3]})` : "";
      return { ts, body: `*** ${q[1]} (${q[2]}) quit${reason}` };
    }
    const p = text.match(/^(\S+)\s+\((~?\S+@\S+)\)\s+has left\s+\S+(?:\s+\((.*)\))?$/);
    if (p) {
      const reason = p[3] ? ` (${p[3]})` : "";
      return { ts, body: `*** ${p[1]} (${p[2]}) left${reason}` };
    }
    return null;
  }

  // `--` lines have varied content. The interesting ones:
  //   `Mode #x [+modes targets] by setter`     -> mode change
  //   `nick has changed topic for #x from "..." to "new"` -> topic change
  //   `nick is now known as new`               -> nick change
  //   `nick was kicked by kicker (reason)`     -> kick
  // The boring ones (informational, fired on JOIN, not real events):
  //   `Topic for #x is "..."`
  //   `Topic set by ... on ...`
  //   `Channel #x: N nicks ...`
  //   `Channel created on ...`
  if (marker === "--") {
    if (
      text.startsWith("Topic for ") ||
      text.startsWith("Topic set by ") ||
      text.startsWith("Channel #") ||
      text.startsWith("Channel created on ")
    ) {
      return null;
    }

    const mode = text.match(/^Mode \S+ \[(.+?)\] by (\S+)/);
    if (mode) {
      return { ts, body: `*** ${mode[2]} set mode ${mode[1]}` };
    }
    const topic = text.match(/^(\S+) has changed topic for \S+ from "(?:.*?)" to "(.*)"$/);
    if (topic) {
      return { ts, body: `*** ${topic[1]} changed topic to '${topic[2]}'` };
    }
    const nick = text.match(/^(\S+) is now known as (\S+)$/);
    if (nick) {
      return { ts, body: `*** ${nick[1]} is now known as ${nick[2]}` };
    }
    const kick = text.match(/^(\S+) was kicked by (\S+)\s*(?:\((.*)\))?$/);
    if (kick) {
      const reason = kick[3] ? ` (${kick[3]})` : "";
      return { ts, body: `*** ${kick[1]} was kicked by ${kick[2]}${reason}` };
    }
    return null;
  }

  return null;
}

// --- Read sources ---
const events = [];

if (args.lounge && fs.existsSync(args.lounge)) {
  const lines = fs.readFileSync(args.lounge, "utf-8").trimEnd().split("\n");
  let kept = 0;
  for (const line of lines) {
    const ev = parseLoungeLine(line);
    if (ev) {
      events.push(ev);
      kept++;
    }
  }
  console.error(`lounge: ${kept}/${lines.length} lines parsed`);
}

if (args.weechat && fs.existsSync(args.weechat)) {
  const lines = fs.readFileSync(args.weechat, "utf-8").trimEnd().split("\n");
  let kept = 0;
  let dropped = 0;
  for (const line of lines) {
    const ev = parseWeechatLine(line, CHANNEL);
    if (ev) {
      events.push(ev);
      kept++;
    } else {
      dropped++;
    }
  }
  console.error(`weechat: ${kept}/${lines.length} lines parsed (${dropped} skipped)`);
}

// --- Pull in existing per-month archive files so re-runs are merge-safe ---
let existingFiles = [];
try {
  existingFiles = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(`${CHANNEL}-`) && f.endsWith(".log"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
for (const f of existingFiles) {
  const lines = fs
    .readFileSync(path.join(OUT_DIR, f), "utf-8")
    .trimEnd()
    .split("\n");
  for (const line of lines) {
    const ev = parseLoungeLine(line);
    if (ev) events.push(ev);
  }
}
console.error(
  `existing archive: ${existingFiles.length} files (${existingFiles.join(", ")})`
);

// --- Sort + dedup ---
events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

// Dedup: same body within 5s → drop second occurrence. Lounge and Weechat
// timestamp the same IRC line at near-identical receive times; this collapses
// the overlap window without losing legitimate repeats far apart.
const DEDUP_WINDOW_MS = 5000;
const recent = new Map(); // body -> last ts (ms)
const deduped = [];
let dropped = 0;
for (const ev of events) {
  const ms = Date.parse(ev.ts);
  const last = recent.get(ev.body);
  if (last !== undefined && ms - last < DEDUP_WINDOW_MS) {
    dropped++;
    continue;
  }
  recent.set(ev.body, ms);
  deduped.push(ev);
}
console.error(`combined: ${events.length} events, ${dropped} dedup dropped`);

// --- Bucket by UTC month ---
const buckets = new Map(); // "YYYY-MM" -> [ev]
for (const ev of deduped) {
  const ym = ev.ts.slice(0, 7);
  if (!buckets.has(ym)) buckets.set(ym, []);
  buckets.get(ym).push(ev);
}

// --- Write ---
if (args["dry-run"]) {
  for (const [ym, list] of [...buckets.entries()].sort()) {
    console.error(`would write ${CHANNEL}-${ym}.log: ${list.length} lines`);
  }
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [ym, list] of buckets) {
  const out = list.map((e) => `[${e.ts}] ${e.body}`).join("\n") + "\n";
  const dst = path.join(OUT_DIR, `${CHANNEL}-${ym}.log`);
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, dst);
  console.error(`wrote ${dst}: ${list.length} lines`);
}
