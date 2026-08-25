const test = require("node:test");
const assert = require("node:assert/strict");

const { extractNewestOrCreate, extractNewestSnapshot, extractSubmittedSnapshot, isSnapshotUrl, newestSnapshotUrl, normalizeSourceUrl, submitSnapshotUrl } = require("../src/archive-support.js");

test("builds the archive.ph newest redirect without changing the source URL", () => {
  const source = "https://news.example/story?id=7#comments";
  assert.equal(normalizeSourceUrl(source), "https://news.example/story?id=7");
  assert.equal(newestSnapshotUrl(source), "https://archive.ph/newest/https%3A%2F%2Fnews.example%2Fstory%3Fid%3D7");
  assert.equal(submitSnapshotUrl(source), "https://archive.ph/submit/?url=https%3A%2F%2Fnews.example%2Fstory%3Fid%3D7");
});

test("recognizes snapshots and rejects control pages or unsafe source URLs", () => {
  assert.equal(isSnapshotUrl("https://archive.ph/AbC12"), true);
  assert.equal(isSnapshotUrl("https://archive.ph/20260101120000/https://example.com/story"), true);
  assert.equal(isSnapshotUrl("https://archive.ph/newest/https%3A%2F%2Fexample.com"), false);
  assert.equal(isSnapshotUrl("https://archive.ph/wip/AbC12"), false);
  assert.equal(isSnapshotUrl("https://example.com/AbC12"), false);
  assert.throws(() => normalizeSourceUrl("file:///tmp/article"), /HTTP or HTTPS/i);
  assert.throws(() => normalizeSourceUrl("https://user:secret@example.com/story"), /HTTP or HTTPS/i);
  assert.throws(() => normalizeSourceUrl("https://archive.ph/AbC12"), /already/i);
});

test("creates and extracts a new snapshot when the newest lookup reports none", async () => {
  const entries = [];
  const removed = [];
  let nextId = 0;
  const article = await extractNewestOrCreate("https://example.com/new-story", {
    createTab: async (url) => { entries.push(url); nextId += 1; return { id: nextId }; },
    waitForSnapshot: async (_id, mode) => {
      if (mode === "lookup") { const error = new Error("missing"); error.code = "ARCHIVE_SNAPSHOT_MISSING"; throw error; }
    },
    getTab: async () => ({ url: "https://archive.ph/New12" }),
    extractArticle: async () => ({ title: "New snapshot", textContent: "Freshly archived article" }),
    removeTab: async (id) => removed.push(id),
    isMissingSnapshotError: (error) => error.code === "ARCHIVE_SNAPSHOT_MISSING"
  });
  assert.match(entries[0], /^https:\/\/archive\.ph\/newest\//);
  assert.match(entries[1], /^https:\/\/archive\.ph\/submit\/\?url=/);
  assert.deepEqual(removed, [1, 2]);
  assert.equal(article.snapshotCreated, true);
  assert.equal(article.sourceUrl, "https://archive.ph/New12");
});

test("closes the capture tab when archive.ph requires a challenge", async () => {
  const removed = [];
  await assert.rejects(() => extractSubmittedSnapshot("https://example.com/new-story", {
    createTab: async () => ({ id: 22 }),
    waitForSnapshot: async () => { throw new Error("challenge required"); },
    getTab: async () => ({ url: "https://archive.ph/wip/New12" }),
    extractArticle: async () => ({ textContent: "unused" }),
    removeTab: async (id) => removed.push(id)
  }), /challenge/);
  assert.deepEqual(removed, [22]);
});

test("leaves an interactive capture tab open when the user needs more time", async () => {
  const removed = [];
  await assert.rejects(() => extractSubmittedSnapshot("https://example.com/new-story", {
    createTab: async (_url, mode) => { assert.equal(mode, "capture"); return { id: 23 }; },
    waitForSnapshot: async () => { const error = new Error("still waiting"); error.keepArchiveTabOpen = true; throw error; },
    getTab: async () => ({ url: "https://archive.ph/submit/?url=story" }),
    extractArticle: async () => ({ textContent: "unused" }),
    removeTab: async (id) => removed.push(id)
  }), /still waiting/);
  assert.deepEqual(removed, []);
});

test("follows the redirect, extracts the snapshot, preserves provenance, and closes the hidden tab", async () => {
  const calls = [];
  const article = await extractNewestSnapshot("https://example.com/story", {
    createTab: async (url) => { calls.push(["create", url]); return { id: 17 }; },
    waitForSnapshot: async (id) => calls.push(["wait", id]),
    getTab: async (id) => { calls.push(["get", id]); return { url: "https://archive.ph/AbC12" }; },
    extractArticle: async (id) => { calls.push(["extract", id]); return { title: "Archived story", textContent: "Article text" }; },
    removeTab: async (id) => calls.push(["remove", id])
  });
  assert.equal(article.originalUrl, "https://example.com/story");
  assert.equal(article.archiveUrl, "https://archive.ph/AbC12");
  assert.equal(article.sourceUrl, article.archiveUrl);
  assert.deepEqual(calls.map(([name]) => name), ["create", "wait", "get", "extract", "remove"]);
});

test("always closes the hidden archive tab when extraction fails", async () => {
  const removed = [];
  await assert.rejects(() => extractNewestSnapshot("https://example.com/story", {
    createTab: async () => ({ id: 9 }),
    waitForSnapshot: async () => undefined,
    getTab: async () => ({ url: "https://archive.ph/AbC12" }),
    extractArticle: async () => { throw new Error("no article"); },
    removeTab: async (id) => removed.push(id)
  }), /no article/);
  assert.deepEqual(removed, [9]);
});
