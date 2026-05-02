const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatShare,
  truncateByBytes,
} = require("../classes/postalgic_webhook");

// --- truncateByBytes ---

test("truncateByBytes: returns the input unchanged when already short enough", () => {
  assert.equal(truncateByBytes("hello", 100), "hello");
});

test("truncateByBytes: respects multibyte characters (utf-8, not chars)", () => {
  const text = "🍕🍕🍕";
  const result = truncateByBytes(text, 5);
  assert.equal(Buffer.byteLength(result, "utf8") <= 5, true);
  assert.equal(result, "🍕");
});

// --- formatShare ---

const basePayload = (overrides = {}) => ({
  blog: { name: "staires!", url: "https://staires.org" },
  post: {
    title: "Sakanaction - Wasureararenaino",
    excerpt: "My dog loves this song. My dachshund is very finicky.",
    permalink: "https://staires.org/2026/02/24/sakanaction-wasureararenaino/",
    ...overrides.post,
  },
  ...overrides.top,
});

test("formatShare: builds '[blog] title - excerpt <url>' shape", () => {
  const result = formatShare(basePayload(), 350);
  assert.equal(
    result,
    "[staires!] Sakanaction - Wasureararenaino - My dog loves this song. My dachshund is very finicky. <https://staires.org/2026/02/24/sakanaction-wasureararenaino/>"
  );
});

test("formatShare: collapses newlines/whitespace inside the excerpt to single spaces", () => {
  const result = formatShare(
    basePayload({ post: { excerpt: "line one\n\nline two\n\tindented" } }),
    350
  );
  assert.match(result, /line one line two indented/);
  assert.doesNotMatch(result, /\n/);
});

test("formatShare: omits the excerpt cleanly when there is only a title", () => {
  const result = formatShare(
    basePayload({ post: { title: "just a title", excerpt: "" } }),
    350
  );
  assert.equal(
    result,
    "[staires!] just a title <https://staires.org/2026/02/24/sakanaction-wasureararenaino/>"
  );
});

test("formatShare: uses the excerpt alone when the post has no title", () => {
  const result = formatShare(
    basePayload({ post: { title: null, excerpt: "untitled body text" } }),
    350
  );
  assert.equal(
    result,
    "[staires!] untitled body text <https://staires.org/2026/02/24/sakanaction-wasureararenaino/>"
  );
});

test("formatShare: drops the body entirely when both title and excerpt are missing", () => {
  const result = formatShare(
    basePayload({ post: { title: null, excerpt: "" } }),
    350
  );
  assert.equal(
    result,
    "[staires!] <https://staires.org/2026/02/24/sakanaction-wasureararenaino/>"
  );
});

test("formatShare: truncates the body and appends ... when over budget", () => {
  const long = "x".repeat(2000);
  const result = formatShare(
    basePayload({ post: { excerpt: long } }),
    350
  );
  assert.ok(
    result.endsWith(
      " <https://staires.org/2026/02/24/sakanaction-wasureararenaino/>"
    )
  );
  assert.ok(result.includes("..."));
  assert.ok(
    Buffer.byteLength(result, "utf8") <= 350,
    `payload exceeded 350 bytes: ${Buffer.byteLength(result, "utf8")}`
  );
});

test("formatShare: returns null when payload has no post", () => {
  assert.equal(formatShare({ blog: { name: "x" } }, 350), null);
});

test("formatShare: returns null when post has no permalink", () => {
  assert.equal(
    formatShare(basePayload({ post: { permalink: undefined } }), 350),
    null
  );
});

test("formatShare: falls back to 'blog' when blog.name is missing", () => {
  const result = formatShare(
    basePayload({ top: { blog: { url: "https://x" } } }),
    350
  );
  assert.match(result, /^\[blog\] /);
});

test("formatShare: output begins with [blog] so the bridge parser tags it as a webhook", () => {
  // Regression guard: the leading tag must not be [discord], so impostor's
  // bridge_parser.js classifies these as webhook announcements.
  const result = formatShare(basePayload(), 350);
  assert.match(result, /^\[[^\]]+\] /);
  assert.doesNotMatch(result, /^\[discord\] /);
});
