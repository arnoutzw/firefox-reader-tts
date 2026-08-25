(function exposeLeadImageSupport(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ReaderTtsLeadImage = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function imageAssetIdentity(value, baseUrl) {
    if (!value) return "";
    try {
      const url = new URL(String(value), baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      const pathname = url.pathname.replace(/^\/cdn-cgi\/image\/[^/]+(?=\/)/u, "");
      return pathname.replace(/\/{2,}/gu, "/");
    } catch (_) {
      return "";
    }
  }

  function sameImageAsset(left, right, baseUrl) {
    const leftIdentity = imageAssetIdentity(left, baseUrl);
    return Boolean(leftIdentity && leftIdentity === imageAssetIdentity(right, baseUrl));
  }

  function parseSrcsetCandidates(value) {
    const source = String(value || "").trim();
    if (!source) return [];
    const candidates = Array.from(source.matchAll(/(?:^|,\s*)(\S+)\s+(\d+(?:\.\d+)?[wx])(?=\s*(?:,|$))/gu), (match) => ({
      url: match[1],
      descriptor: match[2]
    }));
    if (candidates.length) return candidates;
    return [{ url: source, descriptor: "" }];
  }

  function shouldPrependLeadImage(leadImage, blocks, baseUrl) {
    if (!leadImage?.src) return false;
    const images = (blocks || []).flatMap((block) => block?.type === "image-group" ? block.images || [] : block?.type === "image" ? [block] : []);
    return !images.some((image) => sameImageAsset(image?.src, leadImage.src, baseUrl));
  }

  return { imageAssetIdentity, parseSrcsetCandidates, sameImageAsset, shouldPrependLeadImage };
});
