import assert from "node:assert/strict";
import test from "node:test";
import {
  createCommandResult,
  createSafeCommand,
  createVerificationResult,
  validateSafeCommand,
} from "../../src/core/result-model.ts";

test("models argv commands without shell interpolation", () => {
  const command = createSafeCommand("node", ["script.mjs", "$(touch", "file)"], { cwd: "fixtures" });
  assert.deepEqual(command.args, ["script.mjs", "$(touch", "file)"]);
  assert.equal(validateSafeCommand({ executable: "node", args: [], cwd: "../outside" }).valid, false);
});

test("normalizes command and verifier results", () => {
  const command = createSafeCommand("node", ["verify.mjs"]);
  const commandResult = createCommandResult({ command, status: "passed", exitCode: 0, stdout: "ok", durationMs: 4 });
  const verification = createVerificationResult({
    outcome: "passed",
    summary: "all checks passed",
    checks: [{ name: "health route", outcome: "passed" }],
    commandResult,
  });

  assert.equal(commandResult.kind, "command");
  assert.equal(verification.kind, "verification");
  assert.equal(verification.commandResult?.status, "passed");
});
