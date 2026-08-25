const test = require("node:test");
const assert = require("node:assert/strict");

const { SpeechController, createTrackpadGestureController, estimatePlaybackToken, isSameOriginReaderImage, loadReaderImage, normalizeReaderAppearance, normalizeReaderBlocks, playbackTokens, splitForTts, validateLocalEndpoint } = require("../reader.js");

test("automatically loads only images with the article's exact origin", () => {
  const source = "https://www.economist.com/business/article";
  assert.equal(isSameOriginReaderImage("https://www.economist.com/image.jpg", source), true);
  assert.equal(isSameOriginReaderImage("https://cdn.economist.com/image.jpg", source), false);
  assert.equal(isSameOriginReaderImage("http://www.economist.com/image.jpg", source), false);
  assert.equal(isSameOriginReaderImage("not a URL", source), false);
});

test("normalizes supported reader appearance choices and preserves them", () => {
  for (const theme of ["white", "sepia", "gray", "black"]) {
    for (const font of ["serif", "sans", "georgia", "palatino"]) {
      assert.deepEqual(normalizeReaderAppearance(theme, font), { theme, font });
    }
  }
});

test("falls back independently to the Apple Reader-inspired defaults", () => {
  assert.deepEqual(normalizeReaderAppearance("not-a-theme", "palatino"), { theme: "sepia", font: "palatino" });
  assert.deepEqual(normalizeReaderAppearance("black", "not-a-font"), { theme: "black", font: "serif" });
  assert.deepEqual(normalizeReaderAppearance(undefined, null), { theme: "sepia", font: "serif" });
});

test("article text is split into service-sized chunks on word boundaries", () => {
  const chunks = splitForTts("one two three four five six", 13);
  assert.deepEqual(chunks, ["one two three", "four five six"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 13));
});

test("empty article text produces no chunks", () => {
  assert.deepEqual(splitForTts("  "), []);
});

test("preserves structured article blocks in their original order", () => {
  assert.deepEqual(normalizeReaderBlocks([
    { type: "paragraph", text: "First paragraph." },
    { type: "heading", text: "A section" },
    { type: "quote", text: "A quotation." },
    { type: "list-item", text: "A listed point" },
    { type: "preformatted", text: "line one\nline two" }
  ], "ignored fallback"), [
    { type: "paragraph", text: "First paragraph." },
    { type: "heading", text: "A section" },
    { type: "quote", text: "A quotation." },
    { type: "list-item", text: "A listed point" },
    { type: "preformatted", text: "line one\nline two" }
  ]);
});

test("retains paragraph boundaries for legacy plain-text articles", () => {
  assert.deepEqual(normalizeReaderBlocks(null, "First paragraph.\n\nSecond paragraph.\nThird paragraph."), [
    { type: "paragraph", text: "First paragraph." },
    { type: "paragraph", text: "Second paragraph." },
    { type: "paragraph", text: "Third paragraph." }
  ]);
});

test("retains ordered inline image blocks and their accessible metadata", () => {
  const blocks = normalizeReaderBlocks([
    { type: "paragraph", text: "Before the image." },
    {
      type: "image",
      src: "http://127.0.0.1:8765/observatory.svg",
      alt: "The observatory dome at sunrise",
      caption: "The observatory dome catches the first light."
    },
    { type: "paragraph", text: "After the image." }
  ], "ignored fallback");
  assert.deepEqual(blocks, [
    { type: "paragraph", text: "Before the image." },
    {
      type: "image",
      src: "http://127.0.0.1:8765/observatory.svg",
      alt: "The observatory dome at sunrise",
      caption: "The observatory dome catches the first light."
    },
    { type: "paragraph", text: "After the image." }
  ]);
});

test("rejects unsafe inline image URLs while retaining safe article blocks", () => {
  const blocks = normalizeReaderBlocks([
    { type: "paragraph", text: "Before unsafe images." },
    { type: "image", src: "javascript:alert('reader-image-xss')", alt: "Script probe", caption: "Drop me" },
    { type: "image", src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", alt: "Data probe", caption: "Drop me too" },
    { type: "image", src: "https://example.com/valid.jpg", alt: "Valid image", caption: "Keep me" },
    { type: "paragraph", text: "After unsafe images." }
  ], "ignored fallback");
  assert.deepEqual(blocks, [
    { type: "paragraph", text: "Before unsafe images." },
    { type: "image", src: "https://example.com/valid.jpg", alt: "Valid image", caption: "Keep me" },
    { type: "paragraph", text: "After unsafe images." }
  ]);
});

test("preserves intrinsic image dimensions for safe reader images", () => {
  assert.deepEqual(normalizeReaderBlocks([
    {
      type: "image",
      src: "/observatory.svg",
      alt: "The observatory dome at sunrise",
      caption: "The observatory dome catches the first light.",
      width: "640",
      height: "360"
    }
  ], "ignored fallback", "http://127.0.0.1:8765/index.html"), [
    {
      type: "image",
      src: "http://127.0.0.1:8765/observatory.svg",
      alt: "The observatory dome at sunrise",
      caption: "The observatory dome catches the first light.",
      width: 640,
      height: 360
    }
  ]);
});

test("preserves ordered image-group members and one shared caption", () => {
  assert.deepEqual(normalizeReaderBlocks([
    {
      type: "image-group",
      images: [
        { src: "/observatory-small.svg", alt: "Close view", width: "320", height: "180" },
        { src: "/observatory-wide.svg", alt: "Wide view", width: "1280", height: "720" }
      ],
      caption: "Two ordered views share one figure caption."
    }
  ], "ignored fallback", "http://127.0.0.1:8765/index.html"), [
    {
      type: "image-group",
      images: [
        { src: "http://127.0.0.1:8765/observatory-small.svg", alt: "Close view", caption: "", width: 320, height: 180 },
        { src: "http://127.0.0.1:8765/observatory-wide.svg", alt: "Wide view", caption: "", width: 1280, height: 720 }
      ],
      caption: "Two ordered views share one figure caption."
    }
  ]);
});

test("times out a hanging image quickly, cancels its src, and removes listeners", async () => {
  const listeners = new Map();
  const removedAttributes = [];
  const image = {
    complete: false,
    naturalWidth: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    removeAttribute(name) { removedAttributes.push(name); },
    set src(value) { this.assignedSrc = value; },
    get src() { return this.assignedSrc || ""; }
  };
  const started = Date.now();
  const result = await loadReaderImage({ image, src: "http://127.0.0.1:8765/hanging.svg" }, 10);
  assert.equal(result.loaded, false);
  assert.equal(result.entry.image, image);
  assert.ok(Date.now() - started < 500, "test hook must not wait for the production timeout");
  assert.equal(image.assignedSrc, "http://127.0.0.1:8765/hanging.svg");
  assert.ok(removedAttributes.includes("src"), "timeout cancels the pending image request");
  assert.equal(listeners.size, 0, "timeout removes load/error listeners");
});

test("hard splitting does not break Unicode surrogate pairs", () => {
  assert.deepEqual(splitForTts("😀😀😀", 2), ["😀😀", "😀"]);
});

test("only the local OpenAI-compatible speech path is accepted", () => {
  assert.equal(validateLocalEndpoint("http://localhost:5050/v1/audio/speech"), "http://localhost:5050/v1/audio/speech");
  assert.throws(() => validateLocalEndpoint("https://example.com/v1/audio/speech"), /local endpoint/i);
  assert.throws(() => validateLocalEndpoint("http://127.0.0.1:5050/voices"), /local endpoint/i);
});

test("playback position maps to a weighted token within the current audio chunk", () => {
  assert.deepEqual(playbackTokens("One  substantial word."), ["One", "substantial", "word."]);
  assert.equal(estimatePlaybackToken("One substantial word.", 0, 10), 0);
  assert.equal(estimatePlaybackToken("One substantial word.", 4, 10), 1);
  assert.equal(estimatePlaybackToken("One substantial word.", 10, 10), 2);
});

test("uses a short first chunk and larger bounded continuation chunks", () => {
  const text = Array.from({ length: 80 }, (_, index) => `Sentence ${index} is long enough to exercise streaming.`).join(" ");
  const chunks = splitForTts(text);
  assert.ok(chunks.length > 2);
  assert.ok(Array.from(chunks[0]).length <= 320);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 1800));
  assert.equal(chunks.join(" "), text);
});

test("prefetches the next chunk while current audio is playing", async () => {
  const originalAudio = global.Audio;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const calls = [];
  const resolvers = [];
  const client = {
    synthesize(text) {
      calls.push(text);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    cancel() { return Promise.resolve(); }
  };
  class FakeAudio {
    constructor() { this.paused = true; this.listeners = {}; this.currentTime = 0; this.duration = 10; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    removeEventListener(type) { delete this.listeners[type]; }
  }
  global.Audio = FakeAudio;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  try {
    const controller = new SpeechController(client, () => undefined);
    const text = Array.from({ length: 80 }, (_, index) => `Sentence ${index} is prepared ahead.`).join(" ");
    const running = controller.start(text, {});
    assert.equal(calls.length, 1);
    resolvers[0](new Blob(["first"], { type: "audio/mpeg" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, "second synthesis starts before first audio ends");
    controller.stop(false);
    await running;
  } finally {
    global.Audio = originalAudio;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("speech controller reports the current token and clears it when stopped", async () => {
  const originalAudio = global.Audio;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let audio;
  const highlighted = [];
  class FakeAudio {
    constructor() { audio = this; this.paused = true; this.listeners = {}; this.currentTime = 0; this.duration = 10; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    removeEventListener(type) { delete this.listeners[type]; }
  }
  global.Audio = FakeAudio;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  try {
    const client = { synthesize: async () => new Blob(["audio"], { type: "audio/mpeg" }), cancel: async () => undefined };
    const controller = new SpeechController(client, () => undefined, (index) => highlighted.push(index));
    const running = controller.start("One substantial word.", {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(highlighted.at(-1), 0);
    audio.currentTime = 4;
    audio.listeners.timeupdate();
    assert.equal(highlighted.at(-1), 1);
    controller.stop(false);
    await running;
    assert.equal(highlighted.at(-1), null);
  } finally {
    global.Audio = originalAudio;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("speech controller clears the marker when playback finishes", async () => {
  const originalAudio = global.Audio;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let audio;
  const highlighted = [];
  const statuses = [];
  class FakeAudio {
    constructor() { audio = this; this.paused = true; this.listeners = {}; this.currentTime = 0; this.duration = 2; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    removeEventListener(type) { delete this.listeners[type]; }
  }
  global.Audio = FakeAudio;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
  try {
    const client = { synthesize: async () => new Blob(["audio"], { type: "audio/mpeg" }), cancel: async () => undefined };
    const controller = new SpeechController(client, (status) => statuses.push(status), (index) => highlighted.push(index));
    const running = controller.start("One final sentence.", {});
    await new Promise((resolve) => setImmediate(resolve));
    audio.listeners.ended({ type: "ended" });
    await running;
    assert.equal(highlighted.at(-1), null);
    assert.equal(statuses.at(-1), "Finished");
  } finally {
    global.Audio = originalAudio;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("two-finger horizontal wheel gestures seek once per swipe and preserve vertical scrolling", () => {
  const seeks = [];
  const gesture = createTrackpadGestureController({ canSeek: () => true, onSeek: (seconds) => seeks.push(seconds) });
  const wheel = (deltaX, deltaY = 0) => {
    let prevented = false;
    gesture.handleWheel({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  try {
    assert.equal(wheel(45), true);
    assert.equal(wheel(40), true);
    assert.deepEqual(seeks, [10]);
    wheel(100);
    assert.deepEqual(seeks, [10], "one continuous swipe triggers only one seek");
    gesture.reset();
    wheel(-90);
    assert.deepEqual(seeks, [10, -10]);
    gesture.reset();
    assert.equal(wheel(5, 100), false, "vertical two-finger scrolling remains native");
  } finally {
    gesture.destroy();
  }
});

test("trackpad pinch emits text-size steps and cancels browser zoom", () => {
  const scales = [];
  let prevented = false;
  const gesture = createTrackpadGestureController({ onScale: (steps) => scales.push(steps) });
  try {
    gesture.handleWheel({ deltaX: 0, deltaY: -30, deltaMode: 0, ctrlKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(scales, [1]);
    gesture.reset();
    gesture.handleWheel({ deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: true, preventDefault: () => undefined });
    assert.deepEqual(scales, [1, -2]);
  } finally {
    gesture.destroy();
  }
});

test("speech controller seeks within the active audio chunk and refreshes the marker", () => {
  const controller = new SpeechController({}, () => undefined);
  let markerUpdates = 0;
  controller.audio = { currentTime: 15, duration: 30 };
  controller.updatePlaybackToken = () => { markerUpdates += 1; };
  assert.equal(controller.seekBy(10), 10);
  assert.equal(controller.audio.currentTime, 25);
  assert.equal(controller.seekBy(10), 5);
  assert.equal(controller.audio.currentTime, 30);
  assert.equal(controller.seekBy(-10), -10);
  assert.equal(controller.audio.currentTime, 20);
  assert.equal(markerUpdates, 3);
});
