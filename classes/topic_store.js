const fs = require("fs");
const path = require("path");

// Tiny JSON-backed store for the persistent channel topic. Keys are channel
// names lowercased to match libera's case-insensitive channel matching.
class TopicStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  get(channel) {
    return this.data[channel.toLowerCase()] || null;
  }

  set(channel, topic) {
    this.data[channel.toLowerCase()] = topic;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = TopicStore;
