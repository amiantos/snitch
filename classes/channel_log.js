const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// First-class IRC channel log archiver. Subscribes to a bridge's IRC client
// and appends every channel-relevant event to a per-month log file in
// Lounge-compatible format, then optionally tails the most recent N lines
// and PUTs them to R2 on a fixed interval.
//
// Lines on disk:
//   [ISO] <nick> message            -- privmsg
//   [ISO] * nick message            -- /me action
//   [ISO] -nick- message            -- channel notice
//   [ISO] *** nick (~ident@host) joined
//   [ISO] *** nick (~ident@host) left (reason)
//   [ISO] *** nick (~ident@host) quit (reason)
//   [ISO] *** target was kicked by kicker (reason)
//   [ISO] *** nick set mode +o othernick
//   [ISO] *** oldnick is now known as newnick
//   [ISO] *** nick changed topic to 'text'

class ChannelLog {
  constructor(logger, config) {
    this.logger = logger;
    this.logDir = config.log_dir || "data/logs";
    this.tailLines = config.tail_lines || 100;
    this.intervalMs = (config.interval_seconds || 60) * 1000;
    this.channel = null;
    this.uploadTimer = null;
    this.lastUploadedContent = null;
    // Lowercased nicks currently in our channel. Maintained from
    // userlist/join/part/kick/quit/nick so we can filter the server-wide
    // QUIT and NICK events down to users actually in this channel.
    this._users = new Set();

    // R2 is optional. Without it, the archive grows but nothing is uploaded.
    this.r2 = null;
    if (config.r2 && config.r2.endpoint && config.r2.bucket) {
      this.r2 = {
        bucket: config.r2.bucket,
        key: config.r2.key || "chat-log.txt",
        client: new S3Client({
          region: "auto",
          endpoint: config.r2.endpoint,
          credentials: {
            accessKeyId: config.r2.access_key_id,
            secretAccessKey: config.r2.secret_access_key,
          },
        }),
      };
    }
  }

  attachTo(ircClient, channel) {
    this.channel = channel;
    const isOurChannel = (target) =>
      target && target.toLowerCase() === channel.toLowerCase();

    ircClient.on("privmsg", (e) => {
      if (!isOurChannel(e.target)) return;
      this._append(`<${e.nick}> ${e.message}`);
    });

    ircClient.on("action", (e) => {
      if (!isOurChannel(e.target)) return;
      this._append(`* ${e.nick} ${e.message}`);
    });

    ircClient.on("notice", (e) => {
      if (!isOurChannel(e.target)) return;
      this._append(`-${e.nick}- ${e.message}`);
    });

    // RPL_ENDOFNAMES: full member list on join. Replaces our tracked set.
    ircClient.on("userlist", (e) => {
      if (!isOurChannel(e.channel)) return;
      this._users = new Set((e.users || []).map((u) => u.nick.toLowerCase()));
    });

    ircClient.on("join", (e) => {
      if (!isOurChannel(e.channel)) return;
      this._users.add(e.nick.toLowerCase());
      this._append(`*** ${e.nick} (${e.ident}@${e.hostname}) joined`);
    });

    ircClient.on("part", (e) => {
      if (!isOurChannel(e.channel)) return;
      this._users.delete(e.nick.toLowerCase());
      const reason = e.message ? ` (${e.message})` : "";
      this._append(`*** ${e.nick} (${e.ident}@${e.hostname}) left${reason}`);
    });

    // QUIT is server-wide. Filter to users actually in this channel — the
    // bot may share other channels (e.g. a notifications-only channel) and
    // those quits would otherwise leak into every channel's log.
    ircClient.on("quit", (e) => {
      const key = e.nick.toLowerCase();
      if (!this._users.has(key)) return;
      this._users.delete(key);
      const reason = e.message ? ` (${e.message})` : "";
      this._append(`*** ${e.nick} (${e.ident}@${e.hostname}) quit${reason}`);
    });

    ircClient.on("kick", (e) => {
      if (!isOurChannel(e.channel)) return;
      this._users.delete(e.kicked.toLowerCase());
      const reason = e.message ? ` (${e.message})` : "";
      this._append(`*** ${e.kicked} was kicked by ${e.nick}${reason}`);
    });

    ircClient.on("mode", (e) => {
      if (!isOurChannel(e.target)) return;
      const modes = (e.modes || [])
        .map((m) => (m.param ? `${m.mode} ${m.param}` : m.mode))
        .join(" ");
      this._append(`*** ${e.nick || "server"} set mode ${modes}`);
    });

    // NICK is server-wide; same filtering rationale as QUIT.
    ircClient.on("nick", (e) => {
      const key = e.nick.toLowerCase();
      if (!this._users.has(key)) return;
      this._users.delete(key);
      this._users.add(e.new_nick.toLowerCase());
      this._append(`*** ${e.nick} is now known as ${e.new_nick}`);
    });

    ircClient.on("topic", (e) => {
      if (!isOurChannel(e.channel)) return;
      // RPL_TOPIC on JOIN has no nick — informational. Skip those to avoid
      // re-recording the topic every time we connect.
      if (!e.nick) return;
      this._append(`*** ${e.nick} changed topic to '${e.topic}'`);
    });
  }

  // Outgoing channel messages we send via ircClient.say() — the IRC client
  // doesn't echo them through the privmsg listener, so the bridge calls this
  // explicitly at each say-to-channel site.
  recordSent(nick, message) {
    this._append(`<${nick}> ${message}`);
  }

  start() {
    if (!this.r2) {
      this.logger.info("ChannelLog: R2 not configured, archive-only mode");
      return;
    }
    this.logger.info(
      `ChannelLog: uploading last ${this.tailLines} lines every ${this.intervalMs / 1000}s -> ${this.r2.key}`
    );
    this._upload();
    this.uploadTimer = setInterval(() => this._upload(), this.intervalMs);
  }

  stop() {
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    }
  }

  _currentLogPath() {
    if (!this.channel) {
      throw new Error("ChannelLog: attachTo() must be called before recording");
    }
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    return path.join(this.logDir, `${this.channel}-${yyyy}-${mm}.log`);
  }

  _append(body) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] ${body}\n`;
      fs.appendFileSync(this._currentLogPath(), line);
    } catch (err) {
      this.logger.error(`ChannelLog: append failed: ${err.message}`);
    }
  }

  // Read backward across monthly files until we have `n` lines (or run out).
  // Returns the joined tail (no trailing newline).
  tail(n) {
    if (!this.channel) return "";
    let files;
    try {
      files = fs
        .readdirSync(this.logDir)
        .filter(
          (f) => f.startsWith(`${this.channel}-`) && f.endsWith(".log")
        )
        .sort();
    } catch (err) {
      if (err.code === "ENOENT") return "";
      throw err;
    }

    const lines = [];
    for (let i = files.length - 1; i >= 0 && lines.length < n; i--) {
      const content = fs.readFileSync(
        path.join(this.logDir, files[i]),
        "utf-8"
      );
      const fileLines = content.replace(/\n$/, "").split("\n");
      // Prepend earlier-file lines to keep chronological order.
      lines.unshift(...fileLines);
    }
    return lines.slice(-n).join("\n");
  }

  async _upload() {
    if (!this.r2) return;
    let content;
    try {
      content = this.tail(this.tailLines);
    } catch (err) {
      this.logger.error(`ChannelLog: tail failed: ${err.message}`);
      return;
    }
    if (!content) return;
    if (content === this.lastUploadedContent) return;

    try {
      await this.r2.client.send(
        new PutObjectCommand({
          Bucket: this.r2.bucket,
          Key: this.r2.key,
          Body: content,
          ContentType: "text/plain; charset=utf-8",
          CacheControl: "public, max-age=30",
        })
      );
      this.lastUploadedContent = content;
      this.logger.debug(
        `ChannelLog: uploaded ${this.r2.key} (${content.length} bytes)`
      );
    } catch (err) {
      this.logger.error(`ChannelLog: upload failed: ${err.message}`);
    }
  }
}

module.exports = ChannelLog;
