const test = require("node:test");
const assert = require("node:assert/strict");

const createTtsClient = require("../src/tts-client.js");

test("TTS client rejects an empty input", async () => {
  const client = createTtsClient();
  await assert.rejects(() => client.synthesize("  "), /no text/i);
});

test("extension message includes the Edge voice, speed and request id", async () => {
  const originalBrowser = global.browser;
  let message;
  global.browser = { runtime: { sendMessage: async (value) => {
    message = value;
    return { bytes: new ArrayBuffer(1), contentType: "audio/mpeg" };
  } } };
  try {
    const client = createTtsClient({ speed: 1.2 });
    await client.synthesize("Hello", { requestId: "req-1" });
    assert.equal(message.requestId, "req-1");
    assert.equal(message.options.voice, "en-US-AvaMultilingualNeural");
    assert.equal(message.options.speed, 1.2);
    assert.equal(Object.hasOwn(message.options, "endpoint"), false);
    assert.equal(Object.hasOwn(message.options, "apiKey"), false);
  } finally {
    global.browser = originalBrowser;
  }
});
