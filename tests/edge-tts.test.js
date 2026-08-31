const test = require("node:test");
const assert = require("node:assert/strict");
const { createSynthesis, escapeXml, handshakeHeaders, rateForSpeed, secMsGec } = require("../src/edge-tts.js");

function audioFrame(text) {
  const header = new TextEncoder().encode("Path:audio\r\nContent-Type:audio/mpeg\r\n");
  const audio = new TextEncoder().encode(text);
  const frame = new Uint8Array(2 + header.length + audio.length);
  frame[0] = header.length >> 8;
  frame[1] = header.length & 0xff;
  frame.set(header, 2);
  frame.set(audio, 2 + header.length);
  return frame.buffer;
}

test("Edge TTS escapes SSML and maps reader speed to Edge prosody", () => {
  assert.equal(escapeXml(`<a&b>"'`), "&lt;a&amp;b&gt;&quot;&apos;");
  assert.equal(rateForSpeed(0.5), "-50%");
  assert.equal(rateForSpeed(1), "+0%");
  assert.equal(rateForSpeed(2), "+100%");
  assert.throws(() => rateForSpeed(2.1), /speed/i);
});

test("Edge TTS limits its handshake rewrite to the required Edge headers", () => {
  const headers = handshakeHeaders([{ name: "Origin", value: "moz-extension://temporary" }, { name: "Accept", value: "*/*" }]);
  assert.equal(headers.find((header) => header.name === "Accept").value, "*/*");
  assert.equal(headers.find((header) => header.name === "Origin").value, "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
  assert.match(headers.find((header) => header.name === "Cookie").value, /^muid=[A-F0-9]{32};$/);
});

test("Edge TTS builds the GEC proof from exact Windows ticks", async () => {
  // This is a fixed five-minute boundary. A floating-point tick calculation
  // produces a different digest on JavaScript engines.
  assert.equal(await secMsGec(0), "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C");
});

test("Edge TTS returns concatenated MP3 frames and does not need a local endpoint", async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen()); }
    send(value) {
      this.sent.push(value);
      if (!value.includes("Path:ssml")) return;
      queueMicrotask(() => this.onmessage({ data: audioFrame("one") }));
      queueMicrotask(() => this.onmessage({ data: audioFrame("two") }));
      queueMicrotask(() => this.onmessage({ data: "Path:turn.end\r\n\r\n" }));
    }
    close() { this.readyState = 3; }
  }
  const synthesis = createSynthesis({ input: "Text & symbols", voice: "en-US-AvaMultilingualNeural", speed: 1, requestId: "00112233445566778899aabbccddeeff", WebSocketImpl: FakeWebSocket });
  const result = await synthesis.promise;
  assert.match(sockets[0].url, /^wss:\/\/speech\.platform\.bing\.com\//);
  assert.match(sockets[0].url, /ConnectionId=00112233445566778899aabbccddeeff/);
  assert.match(sockets[0].url, /Sec-MS-GEC=[A-F0-9]{64}/);
  assert.match(sockets[0].sent[1], /Text &amp; symbols/);
  assert.equal(new TextDecoder().decode(result.bytes), "onetwo");
  assert.equal(result.contentType, "audio/mpeg");
});
