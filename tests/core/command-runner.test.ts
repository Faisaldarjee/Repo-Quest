import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeCommand, runSafeCommand } from "../../src/core/index.ts";

test("runs an allow-listed argv command without a shell", async () => {
  const result = await runSafeCommand(createSafeCommand("node", ["-e", "process.stdout.write('ok')"]), {
    repoRoot: process.cwd(),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.stdout, "ok");
});

test("blocks an executable outside the allow-list", async () => {
  const result = await runSafeCommand({ executable: "rm", args: ["-rf", "."] }, { repoRoot: process.cwd() });
  assert.equal(result.status, "blocked");
  assert.match(result.error ?? "", /allow-listed/);
});
