(function expose(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.createReaderTtsClient = factory;
})(typeof self !== "undefined" ? self : this, function createTtsClient(options) {
  const config = Object.assign({
    voice: "en-US-AvaMultilingualNeural",
    speed: 1
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
          options: { voice: values.voice, speed: Number(values.speed) }
        });
        return new Blob([result.bytes], { type: result.contentType || "audio/mpeg" });
      }
      throw new Error("Reader TTS requires the Firefox extension background worker.");
    },
    cancel(requestId) {
      if (typeof browser !== "undefined" && browser.runtime?.sendMessage && requestId) {
        return browser.runtime.sendMessage({ type: "tts-cancel", requestId }).catch(() => undefined);
      }
      return Promise.resolve();
    }
  };
});
