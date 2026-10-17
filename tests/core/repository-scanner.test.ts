import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "../../src/core/repository-scanner.ts";

test("scans repository metadata with portable paths and ignores generated directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "repoquest-core-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(join(root, ".repoquest"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));
    await writeFile(
      join(root, "src", "server.ts"),
      [
        "export const answer = 42;",
        "export function start() {}",
        "app.get('/health', handler);",
      ].join("\n"),
    );
    await writeFile(join(root, "tests", "server.test.ts"), "test('works', () => {});");
    await writeFile(join(root, "node_modules", "ignored", "hidden.ts"), "export const hidden = true;");
    await writeFile(join(root, ".repoquest", "state.json"), "{}");

    const result = await scanRepository(root);
    assert.deepEqual(result.files, ["package.json", "src/server.ts", "tests/server.test.ts"]);
    assert.deepEqual(result.packageScripts, { lint: "eslint .", test: "node --test" });
    assert.deepEqual(result.likelyRoutes, ["/health"]);
    assert.deepEqual(result.tests, ["tests/server.test.ts"]);
    assert.deepEqual(result.exportedSymbols, ["answer", "start"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
