const path = require("path");
const express = require("express");
const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const DiscordBridge = require("./classes/discord_bridge");
const TopicStore = require("./classes/topic_store");
const ChannelLog = require("./classes/channel_log");
const { createWebhookRouter } = require("./classes/github_webhook");
const { createDiscourseWebhookRouter } = require("./classes/discourse_webhook");
const { createPostalgicWebhookRouter } = require("./classes/postalgic_webhook");

const logger = new Logger(true);

const topicStore = new TopicStore(path.join(__dirname, "data", "topics.json"));

// One ChannelLog per IRC channel. Only the primary uploads to R2 — two
// instances PUTing the same key would clobber each other.
const channelLogs = new Map();
const primaryChannel = config.discord.irc_channel;
const extraChannels = (config.discord.extra_irc_channels || []).filter(
  (c) => c.toLowerCase() !== primaryChannel.toLowerCase()
);
const allChannels = [primaryChannel, ...extraChannels];

if (config.channel_log?.enabled) {
  channelLogs.set(
    primaryChannel.toLowerCase(),
    new ChannelLog(logger, config.channel_log)
  );
  const { r2, ...extraLogCfg } = config.channel_log;
  for (const ch of extraChannels) {
    channelLogs.set(ch.toLowerCase(), new ChannelLog(logger, extraLogCfg));
  }
}

const bridge = new DiscordBridge(logger, config, topicStore, channelLogs);
bridge.start();

for (const ch of allChannels) {
  const log = channelLogs.get(ch.toLowerCase());
  if (!log) continue;
  log.attachTo(bridge.ircClient, ch);
  log.start();
}

let server = null;
if (config.web?.enabled) {
  const app = express();

  // Capture raw body for HMAC verification on webhook routes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  if (config.github_webhook?.enabled) {
    app.use("/webhook", createWebhookRouter(bridge, config, logger));
    logger.info("GitHub webhook mounted at /webhook");
  }

  if (config.discourse_webhook?.enabled) {
    app.use("/discourse-webhook", createDiscourseWebhookRouter(bridge, config, logger));
    logger.info("Discourse webhook mounted at /discourse-webhook");
  }

  if (config.postalgic_webhook?.enabled) {
    app.use("/postalgic-webhook", createPostalgicWebhookRouter(bridge, config, logger));
    logger.info("Postalgic webhook mounted at /postalgic-webhook");
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  const port = config.web.port || 3002;
  server = app.listen(port, () => {
    logger.info(`Webhook server listening on :${port}`);
  });
}

function shutdown() {
  logger.info("Shutting down...");
  for (const log of channelLogs.values()) log.stop();
  bridge.stop();
  if (server) server.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
