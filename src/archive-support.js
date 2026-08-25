(function expose(root, factory) {
  const helpers = factory();
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.ArchiveSupport = helpers;
})(typeof self !== "undefined" ? self : this, function createArchiveSupport() {
  const ARCHIVE_ORIGIN = "https://archive.ph";

  function normalizeSourceUrl(value) {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Archive.ph requires a public HTTP or HTTPS article URL.");
    }
    if (url.hostname === "archive.ph") throw new Error("This page is already an archive.ph page.");
    url.hash = "";
    return url.href;
  }

  function newestSnapshotUrl(value) {
    return `${ARCHIVE_ORIGIN}/newest/${encodeURIComponent(normalizeSourceUrl(value))}`;
  }

  function submitSnapshotUrl(value) {
    return `${ARCHIVE_ORIGIN}/submit/?url=${encodeURIComponent(normalizeSourceUrl(value))}`;
  }

  function isSnapshotUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.origin !== ARCHIVE_ORIGIN) return false;
      const firstPathPart = url.pathname.split("/").filter(Boolean)[0] || "";
      return Boolean(firstPathPart) && !["newest", "submit", "search", "wip"].includes(firstPathPart.toLowerCase());
    } catch (_) {
      return false;
    }
  }

  async function extractSnapshotFromEntry(sourceUrl, entryUrl, mode, adapters) {
    const originalUrl = normalizeSourceUrl(sourceUrl);
    const archiveTab = await adapters.createTab(entryUrl, mode);
    let keepTabOpen = false;
    try {
      await adapters.waitForSnapshot(archiveTab.id, mode);
      const snapshotTab = await adapters.getTab(archiveTab.id);
      if (!isSnapshotUrl(snapshotTab.url)) throw new Error("Archive.ph did not redirect to an archived snapshot.");
      const article = await adapters.extractArticle(archiveTab.id);
      return Object.assign({}, article, {
        originalUrl,
        archiveUrl: snapshotTab.url,
        sourceUrl: snapshotTab.url,
        snapshotCreated: mode === "capture"
      });
    } catch (error) {
      keepTabOpen = Boolean(error?.keepArchiveTabOpen);
      throw error;
    } finally {
      if (!keepTabOpen) await adapters.removeTab(archiveTab.id).catch(() => undefined);
    }
  }

  function extractNewestSnapshot(sourceUrl, adapters) {
    return extractSnapshotFromEntry(sourceUrl, newestSnapshotUrl(sourceUrl), "lookup", adapters);
  }

  function extractSubmittedSnapshot(sourceUrl, adapters) {
    return extractSnapshotFromEntry(sourceUrl, submitSnapshotUrl(sourceUrl), "capture", adapters);
  }

  async function extractNewestOrCreate(sourceUrl, adapters) {
    try {
      return await extractNewestSnapshot(sourceUrl, adapters);
    } catch (error) {
      if (!adapters.isMissingSnapshotError(error)) throw error;
      return extractSubmittedSnapshot(sourceUrl, adapters);
    }
  }

  return { ARCHIVE_ORIGIN, extractNewestOrCreate, extractNewestSnapshot, extractSubmittedSnapshot, isSnapshotUrl, newestSnapshotUrl, normalizeSourceUrl, submitSnapshotUrl };
});
