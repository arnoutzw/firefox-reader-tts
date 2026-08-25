/* global browser, createReaderTtsClient */

(function readerApp() {
  if (typeof document === "undefined") return;
  const query = new URLSearchParams(location.search);
  const sourceTabValue = query.get("tabId");
  const sourceTabId = sourceTabValue === null ? Number.NaN : Number(sourceTabValue);
  const sessionId = query.get("sessionId");
  const autoplay = query.get("autoplay") === "1";
  const startupError = query.get("error");
  const ids = ["article", "article-title", "article-byline", "article-content", "article-source", "loading", "error", "appearance-read-aloud", "play-button", "pause-button", "stop-button", "player-status", "voice", "speed", "speed-value", "endpoint", "api-key", "settings", "settings-button", "archive-button"];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  let articleText = "";
  let articleSourceUrl = "";
  let controller;
  let playbackHighlighter;
  let readerFontScale = 1;
  let readerTheme = "sepia";
  let readerFont = "serif";
  let appearanceWrite = Promise.resolve();
  let appearanceFadeTimer = null;
  let archiveRequestId = null;
  const gestures = createTrackpadGestureController({
    canSeek: () => Boolean(controller?.audio),
    onSeek: (seconds) => {
      const moved = controller?.seekBy(seconds) || 0;
      if (!moved) return;
      const direction = moved > 0 ? "forward" : "back";
      el["player-status"].textContent = `Skipped ${direction} ${Math.abs(moved).toFixed(1)} seconds`;
    },
    onScale: (steps) => setReaderFontScale(readerFontScale + (steps * 0.1), true)
  });

  document.getElementById("back-button").addEventListener("click", () => browser.tabs.getCurrent().then((tab) => tab && browser.tabs.remove(tab.id)).catch(() => close()));
  el["settings-button"].addEventListener("click", () => {
    const open = el.settings.hasAttribute("hidden");
    el.settings.toggleAttribute("hidden", !open);
    el["settings-button"].setAttribute("aria-expanded", String(open));
    const appearancePanel = document.getElementById("appearance-panel");
    appearancePanel?.toggleAttribute("inert", open);
    if (appearancePanel) appearancePanel.setAttribute("aria-hidden", String(open));
  });
  el.speed.addEventListener("input", () => { el["speed-value"].textContent = `${Number(el.speed.value).toFixed(1)}×`; });
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("clear-settings").addEventListener("click", clearSettings);
  for (const button of document.querySelectorAll("#theme-options button[data-reader-theme]")) {
    button.addEventListener("click", () => { setReaderAppearance(button.dataset.readerTheme, readerFont, true); });
  }
  for (const button of document.querySelectorAll("#font-options button[data-reader-font]")) {
    button.addEventListener("click", () => { setReaderAppearance(readerTheme, button.dataset.readerFont, true); });
  }
  document.getElementById("font-size-down")?.addEventListener("click", () => setReaderFontScale(readerFontScale - 0.1, true));
  document.getElementById("font-size-up")?.addEventListener("click", () => setReaderFontScale(readerFontScale + 0.1, true));
  initializeAppearanceFade();
  el["archive-button"].addEventListener("click", loadArchiveSnapshot);
  el["play-button"].addEventListener("click", startReading);
  el["appearance-read-aloud"].addEventListener("click", startReading);
  el["pause-button"].addEventListener("click", () => controller?.togglePause());
  el["stop-button"].addEventListener("click", () => controller?.stop());
  document.addEventListener("wheel", gestures.handleWheel, { passive: false });
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "archive-interaction-required" || message.requestId !== archiveRequestId) return;
    el["archive-button"].textContent = "Waiting…";
    el["player-status"].textContent = "Complete the archive.ph challenge in the opened tab; extraction will resume automatically.";
  });
  addEventListener("unload", () => {
    if (appearanceFadeTimer) clearTimeout(appearanceFadeTimer);
    gestures.destroy();
    controller?.stop(false);
  });

  loadSettings().then(async () => {
    if (startupError) throw new Error(startupError);
    if (sessionId) {
      const article = await browser.runtime.sendMessage({ type: "get-reader-session", sessionId });
      if (!article) throw new Error("The selected-text reading session expired.");
      return article;
    }
    if (!Number.isInteger(sourceTabId) || sourceTabId < 0) throw new Error("No source tab was provided.");
    return browser.runtime.sendMessage({ type: "extract-article", tabId: sourceTabId });
  }).then((article) => {
    renderArticle(article);
    if (autoplay) return startReading();
    return undefined;
  }).catch(showFatalError);

  async function loadSettings() {
    const saved = await browser.storage.local.get(["ttsEndpoint", "ttsVoice", "ttsSpeed", "ttsApiKey", "readerFontScale", "readerTheme", "readerFont"]);
    if (saved.ttsEndpoint) el.endpoint.value = saved.ttsEndpoint;
    if (saved.ttsVoice) el.voice.value = saved.ttsVoice;
    if (saved.ttsSpeed) el.speed.value = String(saved.ttsSpeed);
    if (saved.ttsApiKey !== undefined) el["api-key"].value = saved.ttsApiKey;
    if (saved.readerFontScale !== undefined) setReaderFontScale(saved.readerFontScale);
    setReaderAppearance(saved.readerTheme, saved.readerFont);
    el.speed.dispatchEvent(new Event("input"));
  }

  async function saveSettings() {
    const endpoint = validateLocalEndpoint(el.endpoint.value);
    await appearanceWrite.catch(() => undefined);
    await browser.storage.local.set({ ttsEndpoint: endpoint, ttsVoice: el.voice.value, ttsSpeed: Number(el.speed.value), ttsApiKey: el["api-key"].value, readerFontScale, readerTheme, readerFont });
    el["player-status"].textContent = "Settings saved";
    return endpoint;
  }

  async function clearSettings() {
    await appearanceWrite.catch(() => undefined);
    await browser.storage.local.clear();
    el.endpoint.value = "http://127.0.0.1:5050/v1/audio/speech";
    el.voice.value = "en-US-AvaMultilingualNeural";
    el.speed.value = "1";
    el["api-key"].value = "reader-local";
    setReaderFontScale(1);
    setReaderAppearance("sepia", "serif");
    el.speed.dispatchEvent(new Event("input"));
    el["player-status"].textContent = "Settings cleared";
  }

  function renderArticle(article) {
    const readerBlocks = normalizeReaderBlocks(article?.blocks, article?.textContent, article?.sourceUrl || article?.originalUrl);
    articleText = readerBlocks.map((block) => (block.type === "image" || block.type === "image-group") ? block.caption : block.text).filter(Boolean).join("\n\n");
    if (!articleText) throw new Error("Reader mode could not find a main article on this page.");
    articleSourceUrl = String(article.originalUrl || article.sourceUrl || "");
    el.loading.hidden = true;
    el.error.hidden = true;
    el.article.hidden = false;
    el["article-title"].textContent = article.title || "Untitled article";
    el["article-byline"].textContent = article.byline || article.siteName || "";
    el["article-byline"].hidden = !el["article-byline"].textContent;
    el["article-source"].textContent = article.sourceUrl || "";
    if (article.sourceUrl) el["article-source"].href = article.sourceUrl; else el["article-source"].hidden = true;
    const tokenElements = [];
    el["article-content"].replaceChildren(...readerBlocks.map((block) => {
      if (block.type === "image" || block.type === "image-group") return createReaderFigure(block, tokenElements);
      const tag = block.type === "heading" ? "h2" : block.type === "quote" ? "blockquote" : block.type === "preformatted" ? "pre" : "p";
      const container = document.createElement(tag);
      if (block.type === "list-item") container.className = "list-item";
      appendReaderTokens(container, block.text, tokenElements);
      return container;
    }));
    for (const name of ["appearance-read-aloud", "play-button", "pause-button", "stop-button"]) el[name].disabled = false;
    playbackHighlighter = createPlaybackHighlighter(tokenElements);
    controller = new SpeechController(createClient(), setPlayerStatus, (index) => playbackHighlighter.set(index));
  }

  function createReaderFigure(block, tokenElements) {
    const figure = document.createElement("figure");
    figure.className = "article-image";
    const images = block.type === "image-group" ? block.images : [block];
    const imageEntries = [];
    for (const imageBlock of images) {
      const frame = document.createElement("div");
      frame.className = "article-image-frame";
      const setFrameRatio = (width, height) => frame.style.setProperty("--reader-image-aspect", String(width / height));
      setFrameRatio(16, 9);
      const image = document.createElement("img");
      image.alt = imageBlock.alt;
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      if (imageBlock.width) image.setAttribute("width", String(imageBlock.width));
      if (imageBlock.height) image.setAttribute("height", String(imageBlock.height));
      if (imageBlock.width && imageBlock.height) {
        setFrameRatio(imageBlock.width, imageBlock.height);
      }
      image.addEventListener("error", () => figure.classList.add("image-unavailable"), { once: true });
      frame.append(image);
      figure.append(frame);
      imageEntries.push({ image, src: imageBlock.src });
    }
    const addImageLoadControl = (initialEntries, automatic = false) => {
      const hosts = [...new Set(initialEntries.map((entry) => readerImageHostname(entry.src)).filter(Boolean))];
      const loadButton = document.createElement("button");
      const status = document.createElement("span");
      loadButton.type = "button";
      loadButton.className = "load-image-button";
      loadButton.dataset.loadImage = "";
      loadButton.textContent = `Load image${initialEntries.length === 1 ? "" : "s"} from ${hosts.join(" and ")} (may redirect)`;
      loadButton.title = "Images may redirect and contact another host.";
      loadButton.setAttribute("aria-label", `${loadButton.textContent}. Images may redirect and contact another host.`);
      loadButton.setAttribute("aria-disabled", "false");
      status.className = "image-load-status";
      status.dataset.imageStatus = "";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      let failed = initialEntries;
      const load = async () => {
        if (loadButton.getAttribute("aria-disabled") === "true") return;
        const loading = failed;
        loadButton.setAttribute("aria-disabled", "true");
        loadButton.dataset.imageState = "loading";
        loadButton.textContent = `Loading image${loading.length === 1 ? "" : "s"}…`;
        loadButton.setAttribute("aria-label", `Loading images from ${[...new Set(loading.map((entry) => readerImageHostname(entry.src)))].join(" and ")}.`);
        status.textContent = `Loading images from ${[...new Set(loading.map((entry) => readerImageHostname(entry.src)))].join(" and ")}.`;
        const results = await Promise.all(loading.map((entry) => loadReaderImage(entry)));
        failed = results.filter((result) => !result.loaded).map((result) => result.entry);
        if (failed.length) {
          const failedHosts = [...new Set(failed.map((entry) => readerImageHostname(entry.src)).filter(Boolean))];
          loadButton.setAttribute("aria-disabled", "false");
          loadButton.dataset.imageState = "error";
          loadButton.textContent = `Retry image${failed.length === 1 ? "" : "s"} from ${failedHosts.join(" and ")} (may redirect)`;
          loadButton.setAttribute("aria-label", `${loadButton.textContent}. Images may redirect and contact another host.`);
          status.textContent = `Could not load ${failed.length === 1 ? "the image" : "some images"}. Try again.`;
        } else {
          figure.classList.remove("image-unavailable");
          if (automatic) {
            loadButton.remove();
            status.remove();
            return;
          }
          loadButton.dataset.imageState = "loaded";
          loadButton.textContent = `${initialEntries.length === 1 ? "Image" : "Images"} loaded from ${hosts.join(" and ")}`;
          loadButton.setAttribute("aria-label", loadButton.textContent);
          status.textContent = `${initialEntries.length === 1 ? "Image" : "Images"} loaded from ${hosts.join(" and ")}.`;
        }
      };
      loadButton.addEventListener("click", load);
      loadButton.hidden = automatic;
      figure.append(loadButton);
      figure.append(status);
      if (automatic) void load().then(() => { if (failed.length) loadButton.hidden = false; });
    };
    const automaticEntries = imageEntries.filter((entry) => isSameOriginReaderImage(entry.src, articleSourceUrl));
    const consentEntries = imageEntries.filter((entry) => !isSameOriginReaderImage(entry.src, articleSourceUrl));
    if (consentEntries.length) addImageLoadControl(consentEntries);
    if (automaticEntries.length) {
      for (const entry of automaticEntries) entry.image.loading = "eager";
      addImageLoadControl(automaticEntries, true);
    }
    if (block.caption) {
      const caption = document.createElement("figcaption");
      appendReaderTokens(caption, block.caption, tokenElements);
      figure.append(caption);
    }
    return figure;
  }

  function appendReaderTokens(container, text, tokenElements) {
    for (const part of String(text).split(/(\s+)/u)) {
      if (!part) continue;
      if (/^\s+$/u.test(part)) { container.append(document.createTextNode(part)); continue; }
      const token = document.createElement("span");
      token.className = "reading-token";
      token.textContent = part;
      token.dataset.readingIndex = String(tokenElements.length);
      tokenElements.push(token);
      container.append(token);
    }
  }

  async function loadArchiveSnapshot() {
    const button = el["archive-button"];
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Archiving…";
    archiveRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    el.error.hidden = true;
    controller?.stop(false);
    el["player-status"].textContent = "Finding or creating archive.ph snapshot…";
    try {
      const granted = await browser.permissions.request({ origins: ["https://archive.ph/*"] });
      if (!granted) throw new Error("Permission to open archive.ph was not granted.");
      const article = await browser.runtime.sendMessage({
        type: "extract-archive-article",
        tabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
        sourceUrl: articleSourceUrl,
        requestId: archiveRequestId
      });
      renderArticle(article);
      el["player-status"].textContent = article.snapshotCreated ? "New archive.ph snapshot created" : "Archive.ph snapshot loaded";
      if (autoplay) await startReading();
    } catch (error) {
      el.loading.hidden = true;
      el.error.textContent = `Archive.ph: ${error?.message || String(error)}`;
      el.error.hidden = false;
      el["player-status"].textContent = "Archive extraction failed";
    } finally {
      archiveRequestId = null;
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function createClient(endpoint) {
    return createReaderTtsClient({ endpoint: endpoint || el.endpoint.value.trim(), voice: el.voice.value, speed: Number(el.speed.value), apiKey: el["api-key"].value });
  }

  function setPlayerStatus(value) {
    el["player-status"].textContent = value;
    el["pause-button"].textContent = value === "Paused" ? "Resume" : "Pause";
  }

  function setReaderFontScale(value, persist = false) {
    const next = Math.round(Math.min(1.6, Math.max(0.8, Number(value) || 1)) * 10) / 10;
    const changed = next !== readerFontScale;
    document.getElementById("font-size-down")?.toggleAttribute("disabled", next <= 0.8);
    document.getElementById("font-size-up")?.toggleAttribute("disabled", next >= 1.6);
    if (!changed) return;
    readerFontScale = next;
    document.documentElement.style.setProperty("--reader-font-scale", String(next));
    const output = document.getElementById("font-size-value");
    if (output) output.textContent = `${Math.round(next * 100)}%`;
    if (persist) {
      el["player-status"].textContent = `Text size ${Math.round(next * 100)}%`;
      appearanceWrite = appearanceWrite.catch(() => undefined).then(() => browser.storage.local.set({ readerFontScale: next }));
      appearanceWrite.catch(() => { el["player-status"].textContent = "Could not save text size"; });
    }
  }

  async function setReaderAppearance(theme, font, persist = false) {
    ({ theme: readerTheme, font: readerFont } = normalizeReaderAppearance(theme, font));
    document.documentElement.dataset.readerTheme = readerTheme;
    document.documentElement.dataset.readerFont = readerFont;
    for (const button of document.querySelectorAll("#theme-options button[data-reader-theme]")) {
      button.setAttribute("aria-pressed", String(button.dataset.readerTheme === readerTheme));
    }
    for (const button of document.querySelectorAll("#font-options button[data-reader-font]")) {
      button.setAttribute("aria-pressed", String(button.dataset.readerFont === readerFont));
    }
    if (persist) {
      const snapshot = { readerTheme, readerFont };
      appearanceWrite = appearanceWrite.catch(() => undefined).then(() => browser.storage.local.set(snapshot));
      try { await appearanceWrite; } catch (_) { el["player-status"].textContent = "Could not save reading appearance"; }
    }
  }

  function initializeAppearanceFade() {
    const panel = document.getElementById("appearance-panel");
    if (!panel) return;
    const schedule = () => {
      panel.classList.remove("faded");
      if (appearanceFadeTimer) clearTimeout(appearanceFadeTimer);
      appearanceFadeTimer = setTimeout(() => {
        if (panel.matches(":hover") || panel.contains(document.activeElement)) return schedule();
        panel.classList.add("faded");
      }, 3500);
    };
    document.addEventListener("pointermove", schedule, { passive: true });
    document.addEventListener("scroll", schedule, { passive: true });
    panel.addEventListener("focusin", schedule);
    panel.addEventListener("pointerenter", schedule);
    panel.addEventListener("pointerleave", schedule);
    schedule();
  }

  async function startReading() {
    try {
      const endpoint = await saveSettings();
      controller.client = createClient(endpoint);
      await controller.start(articleText, { voice: el.voice.value, speed: Number(el.speed.value), apiKey: el["api-key"].value });
    } catch (error) {
      if (error?.message === "Speech synthesis was cancelled or timed out." && controller?.stopped) return;
      el.error.textContent = error?.message || String(error);
      el.error.hidden = false;
      setPlayerStatus("Playback error");
    }
  }

  function showFatalError(error) {
    el.loading.hidden = true;
    el.article.hidden = true;
    el.error.textContent = error?.message || String(error);
    el.error.hidden = false;
    el["play-button"].disabled = true;
    el["appearance-read-aloud"].disabled = true;
    setPlayerStatus("Unavailable");
  }
})();

function loadReaderImage(entry, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      entry.image.removeEventListener("load", onLoad);
      entry.image.removeEventListener("error", onError);
      resolve({ entry, loaded });
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    entry.image.addEventListener("load", onLoad, { once: true });
    entry.image.addEventListener("error", onError, { once: true });
    timeoutId = setTimeout(() => {
      entry.image.removeAttribute("src");
      finish(false);
    }, timeoutMs);
    entry.image.removeAttribute("src");
    entry.image.src = entry.src;
    if (entry.image.complete) queueMicrotask(() => finish(entry.image.naturalWidth > 0));
  });
}

class SpeechController {
  constructor(client, setStatus, setPlaybackToken = () => undefined) { this.client = client; this.setStatus = setStatus; this.setPlaybackToken = setPlaybackToken; this.audio = null; this.objectUrl = null; this.generation = 0; this.requestId = null; this.waitResolve = null; this.cleanupAudio = null; this.updatePlaybackToken = null; this.stopped = true; }
  async start(text, options) {
    this.stop(false);
    const generation = ++this.generation;
    this.stopped = false;
    const chunks = splitForTts(text);
    if (!chunks.length) { this.stopped = true; this.setStatus("Finished"); return; }
    const tokenOffsets = [];
    let tokenOffset = 0;
    for (const chunk of chunks) { tokenOffsets.push(tokenOffset); tokenOffset += playbackTokens(chunk).length; }
    const prepare = (index) => {
      this.requestId = `${generation}-${index}-${Date.now()}`;
      const requestId = this.requestId;
      return this.client.synthesize(chunks[index], Object.assign({}, options, { requestId }))
        .then((blob) => ({ blob, requestId }), (error) => ({ error, requestId }));
    };
    let pending = prepare(0);
    for (let index = 0; index < chunks.length; index += 1) {
      if (generation !== this.generation) return;
      this.setStatus(`Preparing ${index + 1} of ${chunks.length}…`);
      const prepared = await pending;
      if (prepared.error) { if (generation !== this.generation) return; throw prepared.error; }
      const blob = prepared.blob;
      if (generation !== this.generation) return;
      pending = index + 1 < chunks.length ? prepare(index + 1) : null;
      const objectUrl = URL.createObjectURL(blob);
      this.objectUrl = objectUrl;
      this.audio = new Audio(objectUrl);
      const activeAudio = this.audio;
      let finish;
      const updatePlaybackToken = () => {
        if (generation !== this.generation || activeAudio !== this.audio) return;
        this.setPlaybackToken(tokenOffsets[index] + estimatePlaybackToken(chunks[index], activeAudio.currentTime, activeAudio.duration));
      };
      this.updatePlaybackToken = updatePlaybackToken;
      const cleanupAudio = () => {
        activeAudio.removeEventListener("loadedmetadata", updatePlaybackToken);
        activeAudio.removeEventListener("timeupdate", updatePlaybackToken);
        if (finish) {
          activeAudio.removeEventListener("ended", finish);
          activeAudio.removeEventListener("error", finish);
        }
        if (this.cleanupAudio === cleanupAudio) this.cleanupAudio = null;
        if (this.updatePlaybackToken === updatePlaybackToken) this.updatePlaybackToken = null;
      };
      this.cleanupAudio = cleanupAudio;
      activeAudio.addEventListener("loadedmetadata", updatePlaybackToken);
      activeAudio.addEventListener("timeupdate", updatePlaybackToken);
      this.setPlaybackToken(tokenOffsets[index]);
      this.setStatus(index + 1 < chunks.length
        ? `Playing ${index + 1} of ${chunks.length} · preparing ${index + 2}`
        : `Playing ${index + 1} of ${chunks.length}`);
      await activeAudio.play();
      if (generation !== this.generation) return;
      await new Promise((resolve, reject) => {
        this.waitResolve = resolve;
        finish = (event) => {
          this.waitResolve = null;
          cleanupAudio();
          URL.revokeObjectURL(objectUrl);
          if (this.objectUrl === objectUrl) this.objectUrl = null;
          if (event?.type === "error") reject(new Error("Firefox could not play the generated audio.")); else resolve();
        };
        this.audio.addEventListener("ended", finish);
        this.audio.addEventListener("error", finish);
      });
    }
    if (generation === this.generation) { this.audio = null; this.stopped = true; this.setPlaybackToken(null); this.setStatus("Finished"); }
  }
  togglePause() {
    if (!this.audio) return;
    if (this.audio.paused) this.audio.play().then(() => this.setStatus("Playing")).catch((error) => this.setStatus(`Resume failed: ${error.message}`));
    else { this.audio.pause(); this.setStatus("Paused"); }
  }
  seekBy(seconds) {
    if (!this.audio || !Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return 0;
    const before = Number(this.audio.currentTime) || 0;
    const after = Math.min(this.audio.duration, Math.max(0, before + Number(seconds || 0)));
    this.audio.currentTime = after;
    this.updatePlaybackToken?.();
    return after - before;
  }
  stop(updateStatus = true) {
    this.stopped = true;
    this.generation += 1;
    if (this.requestId) this.client?.cancel(this.requestId);
    if (this.audio) this.audio.pause();
    if (this.waitResolve) { const resolve = this.waitResolve; this.waitResolve = null; resolve(); }
    if (this.cleanupAudio) this.cleanupAudio();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.audio = null; this.objectUrl = null; this.requestId = null;
    this.setPlaybackToken(null);
    if (updateStatus) this.setStatus("Stopped");
  }
}

function normalizeReaderAppearance(theme, font) {
  const themes = new Set(["white", "sepia", "gray", "black"]);
  const fonts = new Set(["serif", "sans", "georgia", "palatino"]);
  return {
    theme: themes.has(theme) ? theme : "sepia",
    font: fonts.has(font) ? font : "serif"
  };
}

function normalizeReaderBlocks(blocks, fallbackText, sourceUrl) {
  const allowedTypes = new Set(["paragraph", "heading", "quote", "list-item", "preformatted"]);
  const normalizeText = (value) => String(value || "").trim().replace(/\s+/gu, " ");
  const normalized = Array.isArray(blocks) ? blocks.map((block) => {
    if (block?.type === "image") {
      const image = normalizeReaderImage(block, sourceUrl);
      return image ? Object.assign({ type: "image" }, image) : null;
    }
    if (block?.type === "image-group") {
      const images = Array.isArray(block.images) ? block.images.map((image) => normalizeReaderImage(image, sourceUrl)).filter(Boolean) : [];
      return images.length ? { type: "image-group", images, caption: normalizeText(block.caption) } : null;
    }
    const type = allowedTypes.has(block?.type) ? block.type : "paragraph";
    const text = String(block?.text || "").trim();
    return text ? { type, text } : null;
  }).filter(Boolean) : [];
  if (normalized.length) return normalized;
  return String(fallbackText || "").trim().split(/\n\s*\n|\n/u)
    .map((text) => ({ type: "paragraph", text: text.trim() }))
    .filter((block) => block.text);
}

function normalizeReaderImage(block, sourceUrl) {
  const src = safeReaderImageUrl(block?.src, sourceUrl);
  if (!src) return null;
  const image = {
    src,
    alt: String(block?.alt || "").trim().replace(/\s+/gu, " "),
    caption: String(block?.caption || "").trim().replace(/\s+/gu, " ")
  };
  const width = safeReaderImageDimension(block?.width);
  const height = safeReaderImageDimension(block?.height);
  if (width) image.width = width;
  if (height) image.height = height;
  return image;
}

function safeReaderImageDimension(value) {
  const dimension = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(dimension) && dimension > 0 && dimension <= 10000 ? dimension : undefined;
}

function safeReaderImageUrl(value, sourceUrl) {
  if (!value) return "";
  try {
    const base = sourceUrl || (typeof location !== "undefined" ? location.href : undefined);
    const url = new URL(String(value).trim(), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (_) {
    return "";
  }
}

function readerImageHostname(value) {
  try { return new URL(value).hostname; } catch (_) { return ""; }
}

function isSameOriginReaderImage(imageUrl, sourceUrl) {
  try {
    return new URL(String(imageUrl)).origin === new URL(String(sourceUrl)).origin;
  } catch (_) {
    return false;
  }
}

function createTrackpadGestureController({ canSeek = () => true, onSeek = () => undefined, onScale = () => undefined, threshold = 80, pinchThreshold = 24 } = {}) {
  let horizontalDistance = 0;
  let pinchDistance = 0;
  let horizontalTriggered = false;
  let resetTimer = null;
  const reset = () => {
    horizontalDistance = 0;
    pinchDistance = 0;
    horizontalTriggered = false;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = null;
  };
  const scheduleReset = () => {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(reset, 180);
  };
  const deltaPixels = (value, mode) => value * (mode === 1 ? 16 : mode === 2 ? 800 : 1);
  return {
    handleWheel(event) {
      const deltaX = deltaPixels(Number(event.deltaX) || 0, event.deltaMode);
      const deltaY = deltaPixels(Number(event.deltaY) || 0, event.deltaMode);
      if (event.ctrlKey && deltaY) {
        event.preventDefault();
        pinchDistance -= deltaY;
        const steps = Math.trunc(pinchDistance / pinchThreshold);
        if (steps) { onScale(steps); pinchDistance -= steps * pinchThreshold; }
        scheduleReset();
        return;
      }
      if (!canSeek() || Math.abs(deltaX) < Math.abs(deltaY) * 1.25 || !deltaX) return;
      event.preventDefault();
      horizontalDistance += deltaX;
      if (!horizontalTriggered && Math.abs(horizontalDistance) >= threshold) {
        onSeek(horizontalDistance > 0 ? 10 : -10);
        horizontalTriggered = true;
      }
      scheduleReset();
    },
    reset,
    destroy() { reset(); }
  };
}

function playbackTokens(text) {
  return String(text).trim().match(/\S+/gu) || [];
}

function estimatePlaybackToken(text, currentTime, duration) {
  const tokens = playbackTokens(text);
  if (!tokens.length) return 0;
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0;
  const progress = Math.min(1, Math.max(0, currentTime / duration));
  const weights = tokens.map((token) => {
    const spokenCharacters = Array.from(token.replace(/[^\p{L}\p{N}]/gu, "")).length;
    const pauseWeight = /[.!?]["'’”)]*$/u.test(token) ? 3 : /[,;:]["'’”)]*$/u.test(token) ? 1.5 : 0;
    return Math.max(2, spokenCharacters) + pauseWeight;
  });
  const target = progress * weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  for (let index = 0; index < weights.length; index += 1) {
    elapsed += weights[index];
    if (target < elapsed) return index;
  }
  return tokens.length - 1;
}

function createPlaybackHighlighter(tokenElements) {
  let active = null;
  return {
    set(index) {
      const next = Number.isInteger(index) ? tokenElements[index] : null;
      if (next === active) return;
      if (active) { active.classList.remove("current"); active.removeAttribute("aria-current"); }
      active = next || null;
      if (!active) return;
      active.classList.add("current");
      active.setAttribute("aria-current", "true");
      const bounds = active.getBoundingClientRect();
      if (bounds.top < 70 || bounds.bottom > innerHeight - 90) {
        const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
        active.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      }
    }
  };
}

function validateLocalEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch (_) { throw new Error("Enter a valid TTS endpoint URL."); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || url.pathname !== "/v1/audio/speech") {
    throw new Error("Use a local endpoint such as http://127.0.0.1:5050/v1/audio/speech.");
  }
  return url.href;
}

function splitForTts(text, maxLength = 1800, firstChunkLength = Math.min(320, maxLength)) {
  const chunkAtLimit = (source, limit) => {
    const output = [];
    let current = "";
    const lengthOf = (value) => Array.from(value).length;
    const push = (value) => { if (value) output.push(value); };
    const append = (unit) => {
      if (!unit) return;
      if (lengthOf(unit) <= limit) {
        if (current && lengthOf(current) + lengthOf(unit) + 1 > limit) { push(current); current = ""; }
        current += `${current ? " " : ""}${unit}`;
        return;
      }
      if (current) { push(current); current = ""; }
      const words = unit.split(/\s+/);
      for (const word of words) {
        if (lengthOf(word) > limit) {
          if (current) { push(current); current = ""; }
          const chars = Array.from(word);
          for (let i = 0; i < chars.length; i += limit) push(chars.slice(i, i + limit).join(""));
        } else if (!current) current = word;
        else if (lengthOf(current) + lengthOf(word) + 1 <= limit) current += ` ${word}`;
        else { push(current); current = word; }
      }
    };
    String(source).trim().split(/\n\s*\n/).flatMap((p) => p.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean).forEach(append);
    push(current);
    return output;
  };

  const regular = chunkAtLimit(text, maxLength);
  if (!regular.length || Array.from(regular[0]).length <= firstChunkLength) return regular;
  const firstParts = chunkAtLimit(regular[0], firstChunkLength);
  const first = firstParts.shift();
  const continuation = chunkAtLimit([...firstParts, ...regular.slice(1)].join(" "), maxLength);
  return [first, ...continuation];
}

if (typeof module === "object" && module.exports) module.exports = { SpeechController, createTrackpadGestureController, estimatePlaybackToken, isSameOriginReaderImage, loadReaderImage, normalizeReaderAppearance, normalizeReaderBlocks, playbackTokens, safeReaderImageUrl, splitForTts, validateLocalEndpoint };
