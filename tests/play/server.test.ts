import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRepoQuestServer } from "../../src/server.ts";

test("serves generic project, quest, state, verify, and reset endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-server-test-"));
  await writeFile(join(root, "check.js"), "process.exit(0);\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
  await mkdir(join(root, ".repoquest"), { recursive: true });
  await writeFile(join(root, ".repoquest", "candidates.json"), JSON.stringify({
    mode: "local-rules",
    candidates: [{
      id: "boot-project",
      title: "Boot project",
      objective: "Run the project test script.",
      concept: "setup",
      difficulty: "beginner",
      evidence: "command",
      targetFiles: ["package.json"],
      source: "local-rules",
    }],
  }));
  const quest = join(root, "quest.yml");
  await writeFile(
    quest,
    [
      "schemaVersion: 1",
      "id: endpoint-play",
      "title: Endpoint Play",
      "description: Exercises the local API.",
      "missions:",
      "  - id: verify-check",
      "    title: Verify check",
      "    objective: Run the check.",
      "    validation:",
      "      verifier:",
      "        executable: node",
      "        args: [check.js]",
      "        cwd: .",
      "        timeoutMs: 2000",
    ].join("\n") + "\n",
  );

  const application = await startRepoQuestServer({ port: 0, repositoryRoot: root, questManifestPath: quest });
  const url = (path: string) => `http://127.0.0.1:${application.port}${path}`;
  try {
    const projectResponse = await fetch(url("/api/project"));
    assert.equal(projectResponse.status, 200);
    assert.equal((await projectResponse.json()).workspaceRoot !== root, true);

    const questResponse = await fetch(url("/api/quest"));
    assert.equal((await questResponse.json()).id, "endpoint-play");

    const candidatesResponse = await fetch(url("/api/candidates"));
    assert.equal(candidatesResponse.status, 200);
    assert.equal((await candidatesResponse.json()).review.pending, 1);

    const candidateValidation = await fetch(url("/api/validate-candidates"), { method: "POST" });
    const candidateResult = await candidateValidation.json();
    assert.equal(candidateValidation.status, 200);
    assert.equal(candidateResult.review.verified, 1);

    const verifyResponse = await fetch(url("/api/verify"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ missionId: "verify-check" }),
    });
    const verification = await verifyResponse.json();
    assert.equal(verifyResponse.status, 200);
    assert.equal(verification.passed, true);
    assert.equal(verification.state.progress.completed, 1);

    const resetResponse = await fetch(url("/api/reset"), { method: "POST" });
    assert.equal((await resetResponse.json()).progress.completed, 0);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
