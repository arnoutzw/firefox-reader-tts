const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");

test("Ctrl+Shift+U is assigned to current-article read aloud", () => {
  const command = manifest.commands["read-aloud-current-article"];
  assert.equal(command.suggested_key.default, "Ctrl+Shift+U");
  assert.match(command.description, /read.*current article.*aloud/i);
});
