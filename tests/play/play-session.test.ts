import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlaySession } from "../../src/play/index.ts";

async function makeRepository(): Promise<{ root: string; quest: string }> {
  const root = await mkdtemp(join(tmpdir(), "repoquest-play-test-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "play-fixture" }));
  await writeFile(join(root, "value.txt"), "original\n");
  await writeFile(join(root, "check.js"), "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt', 'utf8').includes('updated') ? 0 : 1);\n");
  const quest = join(root, "quest.yml");
  await writeFile(
    quest,
    [
      "schemaVersion: 1",
      "id: local-play",
      "title: Local Play",
      "description: A disposable play session.",
      "missions:",
      "  - id: check-value",
      "    title: Check the value",
      "    objective: Update the value and run the verifier.",
      "    validation:",
      "      verifier:",
      "        executable: node",
      "        args: [check.js]",
      "        cwd: .",
      "        timeoutMs: 2000",
    ].join("\n") + "\n",
  );
  return { root, quest };
}

async function waitForChange(session: Awaited<ReturnType<typeof createPlaySession>>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await session.getState()).fileChanges.some((change) => change.path === "value.txt")) return;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  assert.fail("the play session did not report the changed source file");
}

test("copies repositories, watches the disposable workspace, and verifies argv commands", async () => {
  const fixture = await makeRepository();
  const original = await readFile(join(fixture.root, "value.txt"), "utf8");
  const session = await createPlaySession({ repositoryRoot: fixture.root, questManifestPath: fixture.quest, pollIntervalMs: 25 });
  const initialWorkspace = session.workspaceRoot;
  try {
    assert.notEqual(initialWorkspace, fixture.root);
    await writeFile(join(initialWorkspace, "value.txt"), "updated\n");
    await waitForChange(session);

    const verification = await session.verifyMission("check-value");
    assert.equal(verification.passed, true);
    assert.equal(verification.result.status, "passed");
    assert.equal((await session.getState()).progress.completed, 1);
    assert.equal(await readFile(join(fixture.root, "value.txt"), "utf8"), original);

    await session.reset();
    assert.notEqual(session.workspaceRoot, initialWorkspace);
    assert.equal((await session.getState()).progress.completed, 0);
    assert.deepEqual((await session.getState()).fileChanges, []);
    await assert.rejects(access(initialWorkspace));
  } finally {
    await session.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
