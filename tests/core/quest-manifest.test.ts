import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestManifest, validateQuestManifest } from "../../src/core/quest-manifest.ts";

const validManifest = {
  schemaVersion: 1,
  id: "express-basics",
  title: "Express basics",
  description: "Learn the request path.",
  missions: [
    {
      id: "route",
      title: "Add a route",
      objective: "Expose a health endpoint.",
      validation: {
        baseline: { executable: "node", args: ["scripts/baseline.mjs"], cwd: ".", timeoutMs: 1000 },
      },
    },
  ],
};

test("validates and normalizes a versioned manifest", () => {
  const result = validateQuestManifest(validManifest);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.value.schemaVersion, 1);
    assert.equal(result.value.missions[0]?.validation?.baseline?.executable, "node");
  }
});

test("reports unsupported versions, duplicate mission ids, and unsafe commands", () => {
  const result = validateQuestManifest({
    ...validManifest,
    schemaVersion: 2,
    missions: [
      validManifest.missions[0],
      {
        ...validManifest.missions[0],
        validation: { verifier: { executable: "node with spaces", args: [] } },
      },
    ],
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((error) => error.path === "$.schemaVersion"));
    assert.ok(result.errors.some((error) => error.message.includes("unique")));
    assert.ok(result.errors.some((error) => error.path === "$.missions[1].validation.verifier.executable"));
  }
});

test("parseQuestManifest throws on malformed input", () => {
  assert.throws(() => parseQuestManifest({}), /schemaVersion|id|missions/);
});
