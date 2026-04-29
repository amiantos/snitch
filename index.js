const path = require("path");
const express = require("express");
const config = require("./conf/config.json");
const Logger = require("./classes/logger");
const DiscordBridge = require("./classes/discord_bridge");
const TopicStore = require("./classes/topic_store");
const { createWebhookRouter } = require("./classes/github_webhook");
const { createDiscourseWebhookRouter } = require("./classes/discourse_webhook");

const logger = new Logger(true);

const topicStore = new TopicStore(path.join(__dirname, "data", "topics.json"));
const bridge = new DiscordBridge(logger, config, topicStore);
bridge.start();

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
  bridge.stop();
  if (server) server.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
