/* global Readability, ReaderTtsLeadImage */

(() => {
  try {
    const parsed = new Readability(document.cloneNode(true), { charThreshold: 120 }).parse();
    if (!parsed) return null;
    const parsedDocument = new DOMParser().parseFromString(String(parsed.content || ""), "text/html");
    const blocks = [];
    const supportedPictureType = (value) => !value || new Set(["image/avif", "image/webp", "image/jpeg", "image/png", "image/gif", "image/svg+xml"]).has(String(value).trim().toLowerCase());
    const mediaMatches = (value) => {
      if (!value) return true;
      try { return typeof matchMedia === "function" && matchMedia(value).matches; } catch (_) { return false; }
    };
    const readerPixelTarget = 720 * Math.min(2, Math.max(1, Number(devicePixelRatio) || 1));
    const imageSource = (image) => {
      const srcsetUrl = (value) => {
        const candidates = ReaderTtsLeadImage.parseSrcsetCandidates(value).map((entry) => {
          const src = safeHttpUrl(entry.url);
          const descriptor = entry.descriptor;
          const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
          const resolution = match ? (match[2] === "w" ? Number(match[1]) : Number(match[1]) * 720) : 720;
          return src && Number.isFinite(resolution) && resolution > 0 ? { src, resolution } : null;
        }).filter(Boolean);
        if (!candidates.length) return "";
        return candidates.sort((left, right) => {
          const distance = Math.abs(left.resolution - readerPixelTarget) - Math.abs(right.resolution - readerPixelTarget);
          return distance || left.resolution - right.resolution;
        })[0].src;
      };
      const candidates = [
        image.getAttribute("data-src"),
        image.getAttribute("data-original"),
        image.getAttribute("data-lazy-src"),
        image.getAttribute("data-url"),
        image.getAttribute("data-original-src")
      ];
      for (const candidate of candidates) {
        const safe = safeHttpUrl(candidate);
        if (safe) return safe;
      }
      const picture = image.closest("picture");
      if (picture) {
        for (const source of picture.querySelectorAll("source")) {
          const media = source.getAttribute("media");
          if (!supportedPictureType(source.getAttribute("type")) || !mediaMatches(media)) continue;
          const fromSource = srcsetUrl(source.getAttribute("data-srcset")) || srcsetUrl(source.getAttribute("srcset"));
          if (fromSource) return fromSource;
        }
      }
      const fromImageSrcset = srcsetUrl(image.getAttribute("data-srcset")) || srcsetUrl(image.getAttribute("srcset"));
      if (fromImageSrcset) return fromImageSrcset;
      return safeHttpUrl(image.getAttribute("src"));
    };
    const safeHttpUrl = (value) => {
      if (!value) return "";
      try {
        const url = new URL(String(value).trim(), document.baseURI || location.href);
        return ["http:", "https:"].includes(url.protocol) ? url.href : "";
      } catch (_) {
        return "";
      }
    };
    const imageDimension = (value) => {
      const dimension = Number.parseInt(String(value || ""), 10);
      return Number.isInteger(dimension) && dimension > 0 && dimension <= 10000 ? dimension : undefined;
    };
    const imageBlock = (image, caption = "") => {
      const width = imageDimension(image.getAttribute("width"));
      const height = imageDimension(image.getAttribute("height"));
      if (image.getAttribute("aria-hidden") === "true" || (Number.isFinite(width) && Number.isFinite(height) && width <= 4 && height <= 4)) return null;
      const src = imageSource(image);
      if (!src) return null;
      const block = {
        type: "image",
        src,
        alt: String(image.getAttribute("alt") || "").trim().replace(/\s+/gu, " "),
        caption: String(caption || "").trim().replace(/\s+/gu, " ")
      };
      if (width) block.width = width;
      if (height) block.height = height;
      return block;
    };
    const metaContent = (selector) => String(document.querySelector(selector)?.getAttribute("content") || "").trim();
    const metadataLeadUrl = safeHttpUrl(metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]') || metaContent('meta[name="thumbnail"]'));
    let metadataLeadImage = null;
    if (metadataLeadUrl) {
      const originalImage = Array.from(document.querySelectorAll("article figure img, main article img")).find((image) =>
        ReaderTtsLeadImage.sameImageAsset(imageSource(image), metadataLeadUrl, document.baseURI || location.href));
      if (originalImage) {
        const originalFigure = originalImage.closest("figure");
        const caption = originalFigure
          ? Array.from(originalFigure.children).find((child) => child.tagName.toLowerCase() === "figcaption")?.textContent || ""
          : "";
        metadataLeadImage = imageBlock(originalImage, caption);
      } else {
        const width = imageDimension(metaContent('meta[property="og:image:width"]'));
        const height = imageDimension(metaContent('meta[property="og:image:height"]'));
        metadataLeadImage = {
          type: "image",
          src: metadataLeadUrl,
          alt: metaContent('meta[property="og:image:alt"]') || metaContent('meta[name="twitter:image:alt"]'),
          caption: ""
        };
        if (width) metadataLeadImage.width = width;
        if (height) metadataLeadImage.height = height;
      }
    }
    const figureBlocks = new WeakMap();
    for (const figure of parsedDocument.body.querySelectorAll("figure")) {
      const images = Array.from(figure.querySelectorAll("img")).filter((image) => image.closest("figure") === figure)
        .map((image) => imageBlock(image)).filter(Boolean);
      if (!images.length) continue;
      const caption = Array.from(figure.children).find((child) => child.tagName.toLowerCase() === "figcaption")?.textContent || "";
      const normalizedCaption = String(caption).trim().replace(/\s+/gu, " ");
      if (images.length === 1) {
        images[0].caption = normalizedCaption;
        figureBlocks.set(figure, images[0]);
      } else {
        figureBlocks.set(figure, { type: "image-group", images, caption: normalizedCaption });
      }
    }
    const addBlock = (block) => {
      if (!block) return;
      const previous = blocks[blocks.length - 1];
      if (block.type === "image" || block.type === "image-group" || !previous || previous.text !== block.text || previous.type !== block.type) blocks.push(block);
    };
    for (const element of parsedDocument.body.querySelectorAll("h2, h3, h4, p, li, blockquote, pre, figure, img")) {
      const tag = element.tagName.toLowerCase();
      if (tag === "figure") {
        addBlock(figureBlocks.get(element));
        continue;
      }
      if (element.closest("figure") && figureBlocks.has(element.closest("figure"))) continue;
      if (tag === "img") {
        addBlock(imageBlock(element));
        continue;
      }
      if (tag === "blockquote" && element.querySelector("p, li, pre")) continue;
      if (tag !== "li" && element.closest("li")) continue;
      let source = element;
      if (tag === "li" && element.querySelector("ul, ol")) {
        source = element.cloneNode(true);
        for (const nestedList of source.querySelectorAll("ul, ol")) nestedList.remove();
      }
      const rawText = String(source.textContent || "").trim();
      const text = tag === "pre" ? rawText : rawText.replace(/\s+/gu, " ");
      if (!text) continue;
      const type = tag.startsWith("h") ? "heading"
        : tag === "li" ? "list-item"
          : tag === "pre" ? "preformatted"
            : (tag === "blockquote" || element.closest("blockquote")) ? "quote" : "paragraph";
      addBlock({ type, text });
    }
    if (ReaderTtsLeadImage.shouldPrependLeadImage(metadataLeadImage, blocks, document.baseURI || location.href)) blocks.unshift(metadataLeadImage);
    const textContent = blocks.length ? blocks.map((block) => (block.type === "image" || block.type === "image-group") ? block.caption : block.text).filter(Boolean).join("\n\n") : (parsed.textContent || "");
    return {
      title: parsed.title || document.title || "Untitled article",
      byline: parsed.byline || "",
      siteName: parsed.siteName || "",
      lang: parsed.lang || document.documentElement.lang || "",
      textContent,
      blocks,
      excerpt: parsed.excerpt || "",
      sourceUrl: location.href
    };
  } catch (_) {
    return null;
  }
})();
