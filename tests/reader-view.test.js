const test = require("node:test");
const assert = require("node:assert/strict");

const { originalUrlFromReaderView, hostPermissionPattern } = require("../src/reader-view.js");

test("extracts the original URL from Firefox Reader View", () => {
  const original = "https://example.com/article?id=7";
  const readerUrl = `about:reader?url=${encodeURIComponent(original)}`;
  assert.equal(originalUrlFromReaderView(readerUrl), original);
});

test("rejects non-reader and unsafe Reader View URLs", () => {
  assert.equal(originalUrlFromReaderView("https://example.com/article"), null);
  assert.equal(originalUrlFromReaderView("about:reader?url=file%3A%2F%2F%2Ftmp%2Fsecret"), null);
});

test("creates a least-privilege exact-host permission pattern", () => {
  assert.equal(hostPermissionPattern("https://news.example.com:8443/story"), "https://news.example.com/*");
});
