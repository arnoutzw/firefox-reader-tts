/* global WebSocket */
(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EdgeTts = api;
})(typeof self !== "undefined" ? self : this, function createEdgeTts() {
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const ENDPOINT = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
  const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
  const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
  const EDGE_EXTENSION_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
  const EDGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

  function requestId() {
    return crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  }

  function timestamp() { return new Date().toISOString(); }

  async function secMsGec(now = Date.now()) {
    // Windows ticks are a 17-digit value. Do not use Number here: its 53-bit
    // precision silently changes the timestamp and therefore invalidates GEC.
    const unixSeconds = BigInt(Math.floor(Number(now) / 1000));
    const roundedWindowsTicks = ((unixSeconds + 11644473600n) / 300n) * 300n * 10000000n;
    const data = new TextEncoder().encode(`${roundedWindowsTicks}${TRUSTED_CLIENT_TOKEN}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
  }

  function rateForSpeed(value) {
    const speed = Number(value || 1);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error("TTS speed must be between 0.5 and 2.0.");
    const percent = Math.round((speed - 1) * 100);
    return `${percent >= 0 ? "+" : ""}${percent}%`;
  }

  function frame(path, id, contentType, body) {
    return `X-RequestId:${id}\r\nContent-Type:${contentType}\r\nX-Timestamp:${timestamp()}\r\nPath:${path}\r\n\r\n${body}`;
  }

  function binaryAudioPayload(bytes) {
    // Edge binary frames begin with a two-byte, big-endian header length.
    // The audio payload follows those header bytes, not the first CRLF block.
    if (bytes.length >= 3) {
      const headerLength = (bytes[0] << 8) | bytes[1];
      const payloadStart = 2 + headerLength;
      if (headerLength > 0 && payloadStart <= bytes.length) {
        const header = new TextDecoder().decode(bytes.slice(2, payloadStart));
        if (/(?:^|\r\n)Path:audio(?:\r\n|$)/i.test(header)) return bytes.slice(payloadStart);
      }
    }
    // Retain support for the unprefixed form used by older implementations.
    const marker = [13, 10, 13, 10];
    let end = -1;
    for (let index = 0; index <= bytes.length - marker.length; index += 1) {
      if (marker.every((value, offset) => bytes[index + offset] === value)) { end = index + marker.length; break; }
    }
    if (end < 0) return null;
    const header = new TextDecoder().decode(bytes.slice(0, end));
    return /(?:^|\r\n)Path:audio(?:\r\n|$)/i.test(header) ? bytes.slice(end) : null;
  }

  function muid() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  function handshakeHeaders(headers) {
    const managed = new Set(["origin", "user-agent", "pragma", "cache-control", "cookie"]);
    const next = (headers || []).filter((header) => !managed.has(String(header.name || "").toLowerCase()));
    next.push(
      { name: "Origin", value: EDGE_EXTENSION_ORIGIN },
      { name: "User-Agent", value: EDGE_USER_AGENT },
      { name: "Pragma", value: "no-cache" },
      { name: "Cache-Control", value: "no-cache" },
      { name: "Cookie", value: `muid=${muid()};` }
    );
    return next;
  }

  function createSynthesis({ input, voice, speed, requestId: suppliedId, timeoutMs = 30000, WebSocketImpl = WebSocket, onDiagnostic = () => undefined }) {
    // Reader queue IDs (for example "2-0-…") are useful locally but Edge
    // requires its wire-level X-RequestId to be exactly 32 hexadecimal chars.
    const candidateId = String(suppliedId || "");
    const id = /^[a-f0-9]{32}$/i.test(candidateId) ? candidateId : requestId();
    const text = String(input || "").trim();
    if (!text) throw new Error("There is no text to read.");
    if (Array.from(text).length > 3500) throw new Error("TTS chunks must contain 1–3500 characters.");
    const rate = rateForSpeed(speed);
    let socket;
    let settled = false;
    let rejectPromise;
    let resolvePromise;
    const audioParts = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket && socket.readyState < 2) socket.close();
      if (error) rejectPromise(error); else resolvePromise({ bytes: concatenate(audioParts), contentType: "audio/mpeg" });
    };
    const timeout = setTimeout(() => finish(new Error("Speech synthesis timed out.")), timeoutMs);
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      Promise.resolve().then(async () => {
        const token = await secMsGec();
        if (settled) return;
        onDiagnostic("connecting", `request ${id}`);
        socket = new WebSocketImpl(`${ENDPOINT}&ConnectionId=${id}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          onDiagnostic("WebSocket opened", `request ${id}`);
          const config = JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: OUTPUT_FORMAT } } } });
          const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(voice || "en-US-AvaMultilingualNeural")}"><prosody rate="${rate}">${escapeXml(text)}</prosody></voice></speak>`;
          socket.send(frame("speech.config", id, "application/json; charset=utf-8", config));
          socket.send(frame("ssml", id, "application/ssml+xml", ssml));
        };
        socket.onmessage = async (event) => {
          try {
            if (typeof event.data === "string") {
              if (/(?:^|\r\n)Path:turn\.end(?:\r\n|$)/i.test(event.data)) {
                onDiagnostic("speech complete", `request ${id}; ${audioParts.length} audio frames`);
                if (!audioParts.length) finish(new Error("Edge TTS returned empty audio.")); else finish();
              }
              return;
            }
            const bytes = new Uint8Array(event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer());
            const audio = binaryAudioPayload(bytes);
            if (audio?.byteLength) audioParts.push(audio);
            else onDiagnostic("binary frame ignored", `request ${id}; ${bytes.byteLength} bytes`);
          } catch (error) { finish(error); }
        };
        socket.onerror = () => {
          onDiagnostic("WebSocket error", `request ${id}`);
          finish(new Error("Could not connect to Edge TTS. Check that the add-on was reloaded after updating."));
        };
        socket.onclose = (event) => {
          if (!settled) {
            onDiagnostic("WebSocket closed", `request ${id}; code ${event?.code || "unknown"}${event?.reason ? `: ${event.reason}` : ""}`);
            const detail = event?.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ""})` : "";
            finish(new Error(`Edge TTS closed before speech was complete${detail}.`));
          }
        };
      }).catch(finish);
    });
    return { promise, cancel: () => finish(new Error("Speech synthesis was cancelled.")) };
  }

  function concatenate(parts) {
    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result.buffer;
  }

  return { ENDPOINT, createSynthesis, escapeXml, rateForSpeed, binaryAudioPayload, handshakeHeaders, secMsGec };
});
