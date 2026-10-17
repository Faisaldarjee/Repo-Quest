import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { parseQuestManifest, type QuestManifest } from "../core/quest-manifest.ts";
import { planLocalMissions } from "../core/mission-planner.ts";
import { runSafeCommand } from "../core/command-runner.ts";
import { scanRepository } from "../core/repository-scanner.ts";

const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}

export interface GitHubPreviewWorkspace {
  readonly ref: GitHubRepositoryRef;
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: QuestManifest;
  readonly scan: Awaited<ReturnType<typeof scanRepository>>;
  readonly planner: ReturnType<typeof planLocalMissions>;
  readonly cleanup: () => Promise<void>;
}

export function parseGitHubUrl(input: string): GitHubRepositoryRef {
  const value = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Paste a valid HTTPS GitHub repository URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) {
    throw new TypeError("Only clean https://github.com/owner/repository URLs are supported");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 && !(parts.length === 2 && parts[1]?.endsWith(".git"))) {
    throw new TypeError("GitHub URL must look like https://github.com/owner/repository");
  }
  const owner = parts[0] ?? "";
  const name = (parts[1] ?? "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new TypeError("GitHub owner and repository names contain unsupported characters");
  }
  return { owner, name, url: `https://github.com/${owner}/${name}.git` };
}

async function measureRepository(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
        if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) {
          throw new Error("Repository preview is limited to 5,000 files and 25 MB of source data");
        }
      }
    }
  }
  await visit(root);
}

function buildPreviewManifest(ref: GitHubRepositoryRef, plan: ReturnType<typeof planLocalMissions>): QuestManifest {
  return parseQuestManifest({
    schemaVersion: 1,
    id: `preview-${ref.owner}-${ref.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    title: `${ref.name} Community Preview`,
    description: "Generated from a public repository. Not reviewed by the repository maintainer.",
    missions: plan.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      objective: candidate.objective,
      tags: [candidate.concept, "community preview"],
    })),
  });
}

/** Clone, scan, and prepare an unreviewed read-only preview of a public GitHub repository. */
export async function createGitHubPreview(input: string): Promise<GitHubPreviewWorkspace> {
  const ref = parseGitHubUrl(input);
  const parent = await mkdtemp(join(tmpdir(), "repoquest-preview-"));
  const cloneName = "source";
  const cleanup = async () => rm(parent, { recursive: true, force: true });
  try {
    const cloneResult = await runSafeCommand(
      { executable: "git", args: ["clone", "--depth", "1", "--no-tags", "--single-branch", ref.url, cloneName], timeoutMs: 45_000 },
      { repoRoot: parent, defaultTimeoutMs: 45_000, maxOutputBytes: 12_000 },
    );
    if (cloneResult.status !== "passed") throw new Error(cloneResult.error ?? cloneResult.stderr ?? "GitHub clone failed");
    const root = join(parent, cloneName);
    await measureRepository(root);
    const scan = await scanRepository(root);
    const planner = planLocalMissions(scan);
    const manifest = buildPreviewManifest(ref, planner);
    const manifestPath = join(parent, "preview.quest.yml");
    await writeFile(manifestPath, stringify(manifest), "utf8");
    return { ref, root, manifestPath, manifest, scan, planner, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
