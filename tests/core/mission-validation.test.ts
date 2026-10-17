import assert from "node:assert/strict";
import test from "node:test";
import { createMissionValidationState, evaluateMissionCandidate, MissionValidationStateMachine } from "../../src/core/mission-validation.ts";
import { createCommandResult, createSafeCommand, createVerificationResult, type MissionEvidence } from "../../src/core/result-model.ts";

const command = createSafeCommand("node", ["check.mjs"]);
const passedCommand = () => createCommandResult({ command, status: "passed", exitCode: 0 });
const failedCommand = () => createCommandResult({ command, status: "failed", exitCode: 1, stderr: "failed" });
const verifier = (outcome: "passed" | "failed" | "inconclusive") =>
  createVerificationResult({ outcome, summary: outcome });

function evidence(stage: MissionEvidence["stage"], result: MissionEvidence["result"]): MissionEvidence {
  return { stage, result };
}

test("remains a candidate until all three evidence stages pass", () => {
  const machine = new MissionValidationStateMachine("mission-1");
  assert.equal(machine.state.status, "candidate");
  machine.apply(evidence("baseline", passedCommand()));
  machine.apply(evidence("solver", passedCommand()));
  assert.equal(machine.state.status, "candidate");
  machine.apply(evidence("verifier", verifier("passed")));
  assert.equal(machine.state.status, "verified");
});

test("rejects failed evidence and lets a later failure invalidate a pass", () => {
  const rejected = evaluateMissionCandidate("mission-2", [
    evidence("baseline", passedCommand()),
    evidence("solver", failedCommand()),
    evidence("verifier", verifier("passed")),
  ]);
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.reasons, ["Solver evidence failed"]);

  const unchanged = new MissionValidationStateMachine("mission-3");
  unchanged.apply(evidence("baseline", passedCommand()));
  unchanged.apply(evidence("solver", passedCommand()));
  unchanged.apply(evidence("verifier", verifier("passed")));
  const after = unchanged.apply(evidence("verifier", verifier("failed")));
  assert.equal(after.status, "rejected");
  assert.equal(after.evidence.length, 4);
});

test("evaluating evidence is independent of stage order", () => {
  const inOrder = evaluateMissionCandidate("mission-4", [
    evidence("baseline", passedCommand()),
    evidence("solver", passedCommand()),
    evidence("verifier", verifier("passed")),
  ]);
  const reverseOrder = evaluateMissionCandidate("mission-4", [
    evidence("verifier", verifier("passed")),
    evidence("solver", passedCommand()),
    evidence("baseline", passedCommand()),
  ]);
  assert.equal(inOrder.status, "verified");
  assert.equal(reverseOrder.status, "verified");
});

test("starts with an empty candidate state", () => {
  assert.deepEqual(createMissionValidationState("mission-5").evidence, []);
});
