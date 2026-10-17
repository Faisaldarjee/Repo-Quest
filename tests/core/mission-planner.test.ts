import assert from "node:assert/strict";
import { test } from "node:test";
import { planLocalMissions } from "../../src/core/index.ts";

test("local planner turns scan evidence into bounded mission candidates", () => {
  const plan = planLocalMissions({
    files: ["package.json", "src/auth.ts", "tests/auth.test.ts"],
    packageScripts: { test: "vitest run" },
    likelyRoutes: ["/login"],
    tests: ["tests/auth.test.ts"],
    exportedSymbols: ["login"],
  });

  assert.equal(plan.mode, "local-rules");
  assert.equal(plan.candidates.length, 4);
  assert.equal(plan.candidates.every((candidate) => candidate.source === "local-rules"), true);
  assert.equal(plan.candidates.some((candidate) => candidate.targetFiles.includes("src/auth.ts")), true);
});
