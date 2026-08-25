/* global browser, ArchiveSupport, ReaderViewSupport */

const activeSynthesis = new Map();
const DEFAULT_VOICE = "en-US-AvaMultilingualNeural";
const READ_ALOUD_MENU_ID = "reader-tts-read-aloud";
const { originalUrlFromReaderView, hostPermissionPattern } = ReaderViewSupport;
const { extractNewestOrCreate, isSnapshotUrl, normalizeSourceUrl } = ArchiveSupport;

function validateTtsEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch (_) { throw new Error("Enter a valid TTS endpoint URL."); }
  if (url.username || url.password) throw new Error("Credentials are not allowed in the endpoint URL.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "http:" || !loopback) throw new Error("Only a local http://localhost or http://127.0.0.1 TTS service is allowed.");
  if (url.pathname !== "/v1/audio/speech") throw new Error("The endpoint path must be /v1/audio/speech.");
  return url.href;
}

async function extractArticle(tabId) {
  await browser.scripting.executeScript({ target: { tabId }, files: ["vendor/readability.js"] });
  await browser.scripting.executeScript({ target: { tabId }, files: ["src/lead-image.js"] });
  const results = await browser.scripting.executeScript({ target: { tabId }, files: ["content/extractor.js"] });
  const article = results?.[0]?.result;
  if (!article || !String(article.textContent || "").trim()) throw new Error("Reader mode could not find a main article on this page.");
  return article;
}

function waitForTabComplete(tabId, expectedUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("The original article did not finish loading.")), 20000);
    const isExpected = (tab) => {
      try { return new URL(tab.url).href === new URL(expectedUrl).href; } catch (_) { return false; }
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete" && isExpected(tab)) finish();
    };
    function finish(error) {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    }
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then((tab) => { if (tab.status === "complete" && isExpected(tab)) finish(); }).catch(finish);
  });
}

function waitForArchiveSnapshot(tabId, mode = "lookup", onInteractionRequired = () => undefined) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let interactionRequested = false;
    const timeoutMs = mode === "capture" ? 300000 : 30000;
    const timeout = setTimeout(() => {
      const error = new Error(mode === "capture"
        ? "Archive.ph did not finish within five minutes. Its tab was left open so you can continue or retry."
        : "Archive.ph did not finish loading a snapshot.");
      if (mode === "capture") error.keepArchiveTabOpen = true;
      finish(error);
    }, timeoutMs);
    const inspect = (tab) => {
      if (isSnapshotUrl(tab.url)) finish();
      else if (String(tab.url || "").startsWith("https://archive.ph/") && tab.status === "complete") {
        let path = "";
        try { path = new URL(tab.url).pathname.toLowerCase(); } catch (_) { /* invalid URL */ }
        if (path.startsWith("/wip/")) return;
        if (mode === "lookup") {
          const error = new Error("Archive.ph has no accessible snapshot for this URL.");
          error.code = "ARCHIVE_SNAPSHOT_MISSING";
          finish(error);
        } else {
          if (!interactionRequested) {
            interactionRequested = true;
            Promise.resolve(onInteractionRequired(tabId)).catch(() => undefined);
          }
        }
      }
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") inspect(tab);
    };
    const removedListener = (removedId) => {
      if (removedId === tabId) finish(new Error("The archive.ph capture tab was closed before the snapshot finished."));
    };
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      browser.tabs.onRemoved.removeListener(removedListener);
      if (error) reject(error); else resolve();
    }
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.onRemoved.addListener(removedListener);
    browser.tabs.get(tabId).then(inspect).catch(finish);
  });
}

async function extractArchiveArticle(message, sender) {
  const requestedUrl = String(message.sourceUrl || "").trim();
  let sourceUrl = requestedUrl;
  if (!sourceUrl) {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("No source article was provided for archive.ph.");
    const tab = await browser.tabs.get(tabId);
    sourceUrl = originalUrlFromReaderView(tab.url) || tab.url || "";
  }
  sourceUrl = normalizeSourceUrl(sourceUrl);
  const readerTabId = sender?.tab?.id;
  const requestId = String(message.requestId || "");
  const article = await extractNewestOrCreate(sourceUrl, {
    createTab: (url) => browser.tabs.create({ url, active: false }),
    waitForSnapshot: (tabId, mode) => waitForArchiveSnapshot(tabId, mode, async () => {
      await browser.tabs.update(tabId, { active: true });
      await browser.runtime.sendMessage({ type: "archive-interaction-required", requestId }).catch(() => undefined);
    }),
    getTab: (tabId) => browser.tabs.get(tabId),
    extractArticle,
    removeTab: (tabId) => browser.tabs.remove(tabId),
    isMissingSnapshotError: (error) => error?.code === "ARCHIVE_SNAPSHOT_MISSING"
  });
  if (Number.isInteger(readerTabId)) await browser.tabs.update(readerTabId, { active: true }).catch(() => undefined);
  return article;
}

async function storeReaderSession(article) {
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await browser.storage.session.set({ [`readerTtsSession:${sessionId}`]: article });
  return sessionId;
}

async function openReaderViewArticle(tab, autoplay = false) {
  const originalUrl = originalUrlFromReaderView(tab.url);
  if (!originalUrl) throw new Error("Firefox Reader View did not expose a valid original article URL.");
  const pattern = hostPermissionPattern(originalUrl);
  const granted = await browser.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Reader TTS needs permission for the original article site.");
  let sourceTab;
  try {
    sourceTab = await browser.tabs.create({ url: originalUrl, active: false });
    await waitForTabComplete(sourceTab.id, originalUrl);
    const article = await extractArticle(sourceTab.id);
    const sessionId = await storeReaderSession(article);
    await browser.tabs.create({ url: browser.runtime.getURL(`reader.html?sessionId=${encodeURIComponent(sessionId)}${autoplay ? "&autoplay=1" : ""}`) });
  } finally {
    if (sourceTab?.id != null) await browser.tabs.remove(sourceTab.id).catch(() => undefined);
  }
}

async function handleArticleAction(tab, autoplay = false) {
  if (tab.id == null) return;
  try {
    if (originalUrlFromReaderView(tab.url)) await openReaderViewArticle(tab, autoplay);
    else await browser.tabs.create({ url: browser.runtime.getURL(`reader.html?tabId=${encodeURIComponent(tab.id)}${autoplay ? "&autoplay=1" : ""}`) });
  } catch (error) {
    await browser.tabs.create({ url: browser.runtime.getURL(`reader.html?error=${encodeURIComponent(error?.message || String(error))}`) });
  }
}

async function synthesize(message) {
  const values = message.options || {};
  const requestId = String(message.requestId || "");
  if (!requestId) throw new Error("Missing synthesis request id.");
  const input = String(message.input || "").trim();
  if (!input || Array.from(input).length > 3500) throw new Error("TTS chunks must contain 1–3500 characters.");
  const endpoint = validateTtsEndpoint(values.endpoint);
  const speed = Number(values.speed || 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error("TTS speed must be between 0.25 and 4.0.");
  const controller = new AbortController();
  activeSynthesis.set(requestId, controller);
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: Object.assign({ "Content-Type": "application/json" }, values.apiKey ? { Authorization: `Bearer ${values.apiKey}` } : {}),
      body: JSON.stringify({ model: "tts-1", input, voice: values.voice || DEFAULT_VOICE, response_format: "mp3", speed, stream_format: "audio" })
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = String(body.error?.message || body.error || body.details || "").slice(0, 180);
      } catch (_) { /* not JSON */ }
      throw new Error(`TTS service returned ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("audio/")) throw new Error("TTS service returned a non-audio response.");
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error("TTS service returned empty audio.");
    return { bytes, contentType };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Speech synthesis was cancelled or timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    activeSynthesis.delete(requestId);
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "extract-article") {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.reject(new Error("A valid source tab is required."));
    return extractArticle(tabId);
  }
  if (message?.type === "extract-archive-article") return extractArchiveArticle(message, sender);
  if (message?.type === "tts-synthesize") return synthesize(message);
  if (message?.type === "tts-cancel") {
    activeSynthesis.get(String(message.requestId || ""))?.abort();
    return Promise.resolve();
  }
  if (message?.type === "get-reader-session") {
    const key = `readerTtsSession:${String(message.sessionId || "")}`;
    return browser.storage.session.get(key).then(async (stored) => {
      const article = stored[key];
      if (article) await browser.storage.session.remove(key);
      return article || null;
    });
  }
  return undefined;
});

browser.action.onClicked.addListener((tab) => handleArticleAction(tab));
browser.pageAction.onClicked.addListener((tab) => handleArticleAction(tab));
browser.commands.onCommand.addListener(async (command, eventTab) => {
  if (command !== "read-aloud-current-article") return;
  const tab = eventTab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) await handleArticleAction(tab, true);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || "";
  if (originalUrlFromReaderView(url)) browser.pageAction.show(tabId);
  else browser.pageAction.hide(tabId);
});

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: READ_ALOUD_MENU_ID,
    title: "Read aloud with Reader TTS",
    contexts: ["page", "selection"]
  });
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== READ_ALOUD_MENU_ID || tab.id == null) return;
  const selectedText = String(info.selectionText || "").trim();
  if (selectedText) {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `readerTtsSession:${sessionId}`;
    await browser.storage.session.set({ [key]: {
      title: "Selected text",
      byline: tab.title || "",
      textContent: selectedText,
      sourceUrl: tab.url || ""
    } });
    await browser.tabs.create({ url: browser.runtime.getURL(`reader.html?sessionId=${encodeURIComponent(sessionId)}&autoplay=1`) });
    return;
  }
  await browser.tabs.create({ url: browser.runtime.getURL(`reader.html?tabId=${encodeURIComponent(tab.id)}&autoplay=1`) });
});

if (typeof module === "object" && module.exports) module.exports = { validateTtsEndpoint };
