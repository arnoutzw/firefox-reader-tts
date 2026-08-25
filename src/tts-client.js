(function expose(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.createReaderTtsClient = factory;
})(typeof self !== "undefined" ? self : this, function createTtsClient(options) {
  const config = Object.assign({
    endpoint: "http://127.0.0.1:5050/v1/audio/speech",
    voice: "en-US-AvaMultilingualNeural",
    speed: 1,
    apiKey: "reader-local"
  }, options || {});
  return {
    config,
    async synthesize(input, overrides) {
      if (!String(input || "").trim()) throw new Error("There is no text to read.");
      const values = Object.assign({}, config, overrides || {});
      const requestId = String(values.requestId || `${Date.now()}-${Math.random()}`);
      if (typeof browser !== "undefined" && browser.runtime?.sendMessage) {
        const result = await browser.runtime.sendMessage({
          type: "tts-synthesize",
          requestId,
          input: String(input),
          options: { endpoint: values.endpoint, voice: values.voice, speed: Number(values.speed), apiKey: values.apiKey }
        });
        return new Blob([result.bytes], { type: result.contentType || "audio/mpeg" });
      }
      const response = await fetch(values.endpoint, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, values.apiKey ? { Authorization: `Bearer ${values.apiKey}` } : {}),
        body: JSON.stringify({ model: "tts-1", input: String(input), voice: values.voice, response_format: "mp3", speed: Number(values.speed), stream_format: "audio" })
      });
      if (!response.ok) throw new Error(`TTS service returned ${response.status}.`);
      return response.blob();
    },
    cancel(requestId) {
      if (typeof browser !== "undefined" && browser.runtime?.sendMessage && requestId) {
        return browser.runtime.sendMessage({ type: "tts-cancel", requestId }).catch(() => undefined);
      }
      return Promise.resolve();
    }
  };
});
