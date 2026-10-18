import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileMissionCandidate,
  createSafeCommand,
  scanRepository,
  validateMissionCandidate,
  type MissionCandidate,
} from "../../src/core/index.ts";

function candidate(overrides: Partial<MissionCandidate> = {}): MissionCandidate {
  return {
    id: "command-check",
    title: "Run the command check",
    objective: "Run the repository command and confirm it passes.",
    concept: "Command execution",
    difficulty: "beginner",
    evidence: "command",
    targetFiles: [],
    source: "local-rules",
    ...overrides,
  };
}

async function repository(packageScripts: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repoquest-verifier-test-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: packageScripts }), "utf8");
  return root;
}

test("compiles and verifies a command candidate using only argv package-script commands", async () => {
  const root = await repository({ test: "node -e \"process.stdout.write('ok')\"" });
  try {
    const scan = await scanRepository(root);
    const compiled = compileMissionCandidate(candidate(), scan);
    assert.equal(compiled.valid, true);
    if (!compiled.valid) return;
    assert.deepEqual(compiled.plan.verifier?.args, ["test"]);
    assert.equal(compiled.mission.validation?.baseline?.executable, "npm");
    assert.equal(compiled.adapter, "command");

    const result = await validateMissionCandidate(root, candidate(), { scan });
    assert.equal(result.status, "verified");
    assert.equal(result.solverPassed, true);
    assert.equal(result.workspaceDisposed, true);
    assert.deepEqual(result.evidence.map((item) => item.stage), ["baseline", "solver", "verifier"]);
    const verifier = result.evidence[2]?.result;
    assert.equal(verifier?.kind, "verification");
    if (verifier?.kind === "verification") assert.equal(verifier.outcome, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported evidence and a plan with a missing verifier", async () => {
  const root = await repository();
  try {
    const scan = await scanRepository(root);
    const unsupported = compileMissionCandidate(
      candidate({ evidence: "browser" as MissionCandidate["evidence"] }),
      scan,
    );
    assert.equal(unsupported.valid, false);
    if (!unsupported.valid) assert.match(unsupported.reasons.join(" "), /Unsupported evidence type: browser/);

    const missingVerifier = compileMissionCandidate(
      candidate({
        validation: {
          baseline: createSafeCommand("node", ["-e", "process.exit(0)"]),
          solver: createSafeCommand("node", ["-e", "process.exit(0)"]),
        },
      }),
      scan,
    );
    assert.equal(missingVerifier.valid, false);
    if (!missingVerifier.valid) assert.match(missingVerifier.reasons.join(" "), /Verifier command is required/);

    const rejected = await validateMissionCandidate(root, candidate({
      id: "missing-verifier",
      validation: {
        baseline: createSafeCommand("node", ["-e", "process.exit(0)"]),
        solver: createSafeCommand("node", ["-e", "process.exit(0)"]),
      },
    }), { scan });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.evidence.length, 0);
    assert.match(rejected.reasons.join(" "), /Verifier command is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects failed solver and verifier evidence without claiming solver success", async () => {
  const root = await repository();
  try {
    const result = await validateMissionCandidate(root, candidate({
      id: "failed-stages",
      validation: {
        baseline: createSafeCommand("node", ["-e", "process.exit(0)"]),
        solver: createSafeCommand("node", ["-e", "process.stderr.write('solver failed');process.exit(1)"]),
        verifier: createSafeCommand("node", ["-e", "process.stderr.write('verifier failed');process.exit(1)"]),
      },
    }));

    assert.equal(result.status, "rejected");
    assert.equal(result.solverPassed, false);
    assert.equal(result.evidence.length, 3);
    assert.match(result.reasons.join(" "), /Solver evidence failed/);
    assert.match(result.reasons.join(" "), /Verifier evidence failed/);
    assert.match(result.reasons.join(" "), /Solver command failed/);
    const verifier = result.evidence[2]?.result;
    assert.equal(verifier?.kind, "verification");
    if (verifier?.kind === "verification") assert.equal(verifier.outcome, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
