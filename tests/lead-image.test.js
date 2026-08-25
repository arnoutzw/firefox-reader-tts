const test = require("node:test");
const assert = require("node:assert/strict");

const { imageAssetIdentity, parseSrcsetCandidates, sameImageAsset, shouldPrependLeadImage } = require("../src/lead-image.js");

const original = "https://www.economist.com/content-assets/images/20260829_WBP501.jpg";
const transformed = "https://www.economist.com/cdn-cgi/image/width=1424,quality=80,format=auto/content-assets/images/20260829_WBP501.jpg";

test("recognizes a Cloudflare-transformed Economist image as the Open Graph asset", () => {
  assert.equal(imageAssetIdentity(transformed), "/content-assets/images/20260829_WBP501.jpg");
  assert.equal(sameImageAsset(original, transformed), true);
});

test("parses Economist Cloudflare srcset URLs without splitting transformation commas", () => {
  const srcset = [
    "https://www.economist.com/cdn-cgi/image/width=834,quality=80,format=auto/content-assets/images/20260829_WBP501.jpg 834w",
    "https://www.economist.com/cdn-cgi/image/width=1424,quality=80,format=auto/content-assets/images/20260829_WBP501.jpg 1424w"
  ].join(", ");
  assert.deepEqual(parseSrcsetCandidates(srcset), [
    { url: "https://www.economist.com/cdn-cgi/image/width=834,quality=80,format=auto/content-assets/images/20260829_WBP501.jpg", descriptor: "834w" },
    { url: transformed, descriptor: "1424w" }
  ]);
});

test("recovers a metadata lead image only when Readability omitted the asset", () => {
  const lead = { type: "image", src: transformed, alt: "Shein office", caption: "Photograph: Getty Images" };
  assert.equal(shouldPrependLeadImage(lead, [{ type: "paragraph", text: "Article text" }]), true);
  assert.equal(shouldPrependLeadImage(lead, [{ type: "image", src: original }]), false);
  assert.equal(shouldPrependLeadImage(lead, [{ type: "image-group", images: [{ src: original }] }]), false);
});

test("does not conflate distinct image assets", () => {
  assert.equal(sameImageAsset(original, "https://www.economist.com/content-assets/images/another.jpg"), false);
});
