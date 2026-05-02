const crypto = require("crypto");
const express = require("express");

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = Buffer.from(
    "sha256=" +
      crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8"
  );
  const actual = Buffer.from(signatureHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function truncateByBytes(str, maxBytes) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.substring(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.substring(0, lo);
}

function formatShare(payload, maxLen) {
  const blog = payload?.blog;
  const post = payload?.post;
  if (!blog || !post || !post.permalink) return null;

  const blogName = (blog.name || "blog").trim();
  const title = post.title ? post.title.trim() : "";
  const excerpt = post.excerpt
    ? post.excerpt.replace(/\s+/g, " ").trim()
    : "";
  const url = post.permalink;

  const prefix = `[${blogName}]`;
  // Wrap URL in <> so Discord skips the link-preview embed, matching the
  // GitHub/Discourse webhook convention.
  const suffix = ` <${url}>`;

  // irc-framework reserves room under max_line_length for the IRC line
  // prefix (:nick!user@host PRIVMSG #chan :), so the real payload is
  // ~60-80 bytes smaller. Cap aggressively so the URL stays on one line.
  const budget = Math.min(maxLen, 350) - 90;

  // Body = "title - excerpt", "title", "excerpt", or empty.
  let body;
  if (title && excerpt) {
    body = `${title} - ${excerpt}`;
  } else if (title) {
    body = title;
  } else {
    body = excerpt;
  }

  if (!body) {
    return `${prefix}${suffix}`;
  }

  const fixedBytes =
    Buffer.byteLength(prefix + " ", "utf8") +
    Buffer.byteLength(suffix, "utf8");
  const room = budget - fixedBytes;

  if (room <= 0) {
    return `${prefix}${suffix}`;
  }

  if (Buffer.byteLength(body, "utf8") > room) {
    body = truncateByBytes(body, Math.max(0, room - 3)).trimEnd() + "...";
  }

  return `${prefix} ${body}${suffix}`;
}

function createPostalgicWebhookRouter(bridge, config, logger) {
  const router = express.Router();
  const secret = config.postalgic_webhook.secret;
  const maxLen = config.irc?.max_line_length || 350;

  router.post("/", async (req, res) => {
    const signature = req.headers["x-postalgic-signature"];
    if (!verifySignature(req.rawBody, signature, secret)) {
      logger.warn("Postalgic webhook: rejected invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.headers["x-postalgic-event"];
    const delivery = req.headers["x-postalgic-delivery"];

    logger.info(`Postalgic webhook: ${event} (${delivery})`);

    if (event !== "post.share") {
      logger.info(`Postalgic webhook: ignoring unhandled event: ${event}`);
      return res.json({ message: "ignored" });
    }

    const message = formatShare(req.body, maxLen);
    if (!message) {
      logger.info("Postalgic webhook: could not format payload, ignoring");
      return res.json({ message: "ignored" });
    }

    try {
      bridge.announce(message);
      logger.info(`Postalgic webhook: announced via EyeBridge: ${message}`);
      return res.json({ message: "posted" });
    } catch (err) {
      logger.error(`Postalgic webhook: failed to announce: ${err.message}`);
      return res.status(500).json({ error: "Failed to announce" });
    }
  });

  return router;
}

module.exports = {
  createPostalgicWebhookRouter,
  formatShare,
  truncateByBytes,
};
