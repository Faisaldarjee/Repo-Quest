import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGitHubUrl } from "../../src/preview/github-preview.ts";

test("accepts only clean public GitHub repository URLs", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/Faisaldarjee/Repo-Quest"), {
    owner: "Faisaldarjee",
    name: "Repo-Quest",
    url: "https://github.com/Faisaldarjee/Repo-Quest.git",
  });
  assert.throws(() => parseGitHubUrl("http://github.com/a/b"), /Only clean/);
  assert.throws(() => parseGitHubUrl("https://example.com/a/b"), /Only clean/);
  assert.throws(() => parseGitHubUrl("https://github.com/a/b/issues"), /must look like/);
});
