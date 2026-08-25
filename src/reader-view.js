(function expose(root, factory) {
  const helpers = factory();
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.ReaderViewSupport = helpers;
})(typeof self !== "undefined" ? self : this, function createReaderViewSupport() {
  function originalUrlFromReaderView(value) {
    if (!String(value || "").startsWith("about:reader?")) return null;
    try {
      const original = new URLSearchParams(String(value).slice("about:reader?".length)).get("url");
      const parsed = new URL(original || "");
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
    } catch (_) {
      return null;
    }
  }

  function hostPermissionPattern(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  }

  return { originalUrlFromReaderView, hostPermissionPattern };
});
