import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import test from "node:test";
import {
  candidatesPath,
  approveCandidates,
  evidencePath,
  exportQuest,
  formatReviewSummary,
  generateCandidatePlan,
  initializeWorkspace,
  questPath,
  reviewCandidates,
  validateCandidateEvidence,
} from "../../src/core/maintainer-workflow.ts";

test("init does not clobber an existing quest and creates the config", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    const first = await initializeWorkspace(root);
    await writeFile(first.questPath, "maintainer-authored quest\n", "utf8");

    const second = await initializeWorkspace(root);

    assert.equal(second.questCreated, false);
    assert.equal(await readFile(first.questPath, "utf8"), "maintainer-authored quest\n");
    assert.equal(second.configCreated, false);
    assert.match(await readFile(first.configPath, "utf8"), /"repository":\s*"\."/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate persists planner candidates with portable target paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await writeFile(join(root, "entry.ts"), "export const start = () => true;\n", "utf8");

    const plan = await generateCandidatePlan(root);
    const persisted = JSON.parse(await readFile(candidatesPath(root), "utf8")) as typeof plan;

    assert.deepEqual(persisted, plan);
    for (const candidate of persisted.candidates) {
      for (const targetFile of candidate.targetFiles) {
        assert.equal(isAbsolute(targetFile), false);
        assert.equal(targetFile.includes("\\"), false);
        assert.equal(targetFile.split("/").includes(".."), false);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review stays pending without evidence and export scrubs non-portable candidate text", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    await initializeWorkspace(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await writeFile(join(root, "entry.ts"), "export const start = () => true;\n", "utf8");
    await generateCandidatePlan(root);

    const pending = await reviewCandidates(root);
    assert.equal(pending.verified, 0);
    assert.equal(pending.rejected, 0);
    assert.ok(pending.pending > 0);
    assert.match(formatReviewSummary(pending), /Pending:/);

    const candidates = JSON.parse(await readFile(candidatesPath(root), "utf8")) as {
      candidates: Array<Record<string, unknown>>;
    };
    const first = candidates.candidates[0];
    assert.ok(first);
    first.status = "verified";
    first.title = "Boot C:\\Users\\maintainer\\repo";
    first.objective = "Run token=super-secret in /home/maintainer/repo";
    await writeFile(candidatesPath(root), `${JSON.stringify(candidates, null, 2)}\n`, "utf8");

    const exported = await exportQuest(root);
    const quest = await readFile(exported.filePath, "utf8");
    assert.equal(exported.missionCount, 1);
    assert.equal(quest.includes("super-secret"), false);
    assert.equal(quest.includes("C:\\\\Users"), false);
    assert.equal(quest.includes("/home/maintainer"), false);
    assert.equal(exported.filePath, questPath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintainer approval is explicit before export", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await writeFile(join(root, "entry.ts"), "export const start = () => true;\n", "utf8");
    await initializeWorkspace(root);
    await generateCandidatePlan(root);
    const approved = await approveCandidates(root, "--all");
    assert.ok(approved > 0);
    const review = await reviewCandidates(root);
    assert.equal(review.verified, approved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation runs the offline pipeline and persists portable evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await writeFile(join(root, "entry.ts"), "export const start = () => true;\n", "utf8");
    await initializeWorkspace(root);
    await generateCandidatePlan(root);

    const summary = await validateCandidateEvidence(root);
    assert.equal(summary.rejected, 0);
    assert.ok(summary.verified > 0);
    assert.equal(summary.pending, 0);

    const candidates = JSON.parse(await readFile(candidatesPath(root), "utf8")) as {
      candidates: Array<Record<string, unknown>>;
    };
    assert.equal(candidates.candidates.some((candidate) => candidate.approved === true), false);

    const rawEvidence = await readFile(evidencePath(root), "utf8");
    const evidence = JSON.parse(rawEvidence) as {
      schemaVersion: number;
      candidates: Array<{ status: string; evidence: unknown[] }>;
    };
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.candidates.length, candidates.candidates.length);
    assert.ok(evidence.candidates.every((candidate) => candidate.evidence.length > 0));
    assert.equal(rawEvidence.includes(root), false);
    assert.equal(rawEvidence.includes("C:\\Users"), false);

    const exported = await exportQuest(root);
    assert.equal(exported.missionCount, summary.verified);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation returns per-candidate rejection reasons without leaking command data", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-cli-"));
  try {
    const passCommand = {
      executable: "node",
      args: ["-e", "process.stdout.write('token=super-secret C:/Users/maintainer/repo')"],
      timeoutMs: 5_000,
    };
    const failCommand = {
      executable: "node",
      args: ["-e", "process.stderr.write('password=still-secret'); process.exit(2)"],
      timeoutMs: 5_000,
    };
    const candidates = [
      {
        id: "passes-with-sensitive-output",
        title: "Passes",
        objective: "Run the checks",
        concept: "Testing",
        difficulty: "beginner",
        evidence: "command",
        targetFiles: [],
        source: "local-rules",
        validation: { baseline: passCommand, solver: passCommand, verifier: passCommand },
      },
      {
        id: "fails-the-solver",
        title: "Fails",
        objective: "Find the failure",
        concept: "Testing",
        difficulty: "beginner",
        evidence: "command",
        targetFiles: [],
        source: "local-rules",
        validation: { baseline: passCommand, solver: failCommand, verifier: passCommand },
      },
    ] as const;

    const summary = await validateCandidateEvidence(root, candidates);
    assert.equal(summary.verified, 1);
    assert.equal(summary.rejected, 1);
    assert.equal(summary.pending, 0);
    assert.deepEqual(summary.missions.map((mission) => mission.status), ["verified", "rejected"]);
    assert.match(summary.missions[1]?.reasons.join(" ") ?? "", /Solver evidence failed/);

    const rawEvidence = await readFile(evidencePath(root), "utf8");
    assert.equal(rawEvidence.includes("super-secret"), false);
    assert.equal(rawEvidence.includes("still-secret"), false);
    assert.equal(rawEvidence.includes("C:/Users"), false);
    assert.equal(rawEvidence.includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
