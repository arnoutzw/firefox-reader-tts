const test = require("node:test");
const assert = require("node:assert/strict");

const createTtsClient = require("../src/tts-client.js");

test("TTS client sends Ava Multilingual by default", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
  };
  try {
    const client = createTtsClient();
    const blob = await client.synthesize("Hello reader");
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, "http://127.0.0.1:5050/v1/audio/speech");
    assert.equal(body.voice, "en-US-AvaMultilingualNeural");
    assert.equal(body.response_format, "mp3");
    assert.equal(blob.type, "audio/mpeg");
  } finally {
    global.fetch = originalFetch;
  }
});

test("TTS client rejects an empty input", async () => {
  const client = createTtsClient();
  await assert.rejects(() => client.synthesize("  "), /no text/i);
});

test("extension message includes endpoint, Ava voice, key and request id", async () => {
  const originalBrowser = global.browser;
  let message;
  global.browser = { runtime: { sendMessage: async (value) => {
    message = value;
    return { bytes: new ArrayBuffer(1), contentType: "audio/mpeg" };
  } } };
  try {
    const client = createTtsClient({ apiKey: "reader-local" });
    await client.synthesize("Hello", { requestId: "req-1" });
    assert.equal(message.requestId, "req-1");
    assert.equal(message.options.endpoint, "http://127.0.0.1:5050/v1/audio/speech");
    assert.equal(message.options.voice, "en-US-AvaMultilingualNeural");
    assert.equal(message.options.apiKey, "reader-local");
  } finally {
    global.browser = originalBrowser;
  }
});
