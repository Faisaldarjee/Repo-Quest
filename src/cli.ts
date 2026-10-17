import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readQuestManifest, scanRepository } from "./core/index.ts";
import {
  exportQuest,
  formatReviewSummary,
  generateCandidatePlan,
  initializeWorkspace,
  reviewCandidates,
  approveCandidates,
} from "./core/maintainer-workflow.ts";
import { questPath } from "./core/maintainer-workflow.ts";
import { startRepoQuestServer } from "./server.ts";

function help(): void {
  console.log(`RepoQuest — Duolingo for codebases\n\nCommands:\n  init [path]       Create a .repoquest quest workspace\n  scan [path]       Scan files, scripts, routes, tests, and symbols\n  generate [path]   Generate deterministic mission candidates\n  validate [file]   Validate a quest YAML manifest\n  review [path]     Review local mission evidence\n  approve [path]    Approve all candidates (or pass a mission id)\n  export [path]     Export approved missions as quest.yml\n  play [path]       Start a local contributor workspace on port 4000\n`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, value, missionId] = argv;
  const target = resolve(value ?? ".");

  if (command === "init") {
    const result = await initializeWorkspace(target);
    console.log(`${result.questCreated ? "Created" : "Kept"} .repoquest/quest.yml`);
    console.log(`${result.configCreated ? "Created" : "Kept"} .repoquest/config.json`);
    return;
  }

  if (command === "scan") {
    console.log(JSON.stringify(await scanRepository(target), null, 2));
    return;
  }

  if (command === "generate") {
    console.log(JSON.stringify(await generateCandidatePlan(target), null, 2));
    return;
  }

  if (command === "validate") {
    const file = value === undefined || target === resolve(".") ? `${target}/.repoquest/quest.yml` : target;
    const manifest = await readQuestManifest(file);
    console.log(`Valid quest: ${manifest.title} (${manifest.missions.length} missions)`);
    return;
  }

  if (command === "review") {
    console.log(formatReviewSummary(await reviewCandidates(target)));
    return;
  }

  if (command === "approve") {
    const count = await approveCandidates(target, missionId);
    console.log(`Approved ${count} mission candidate${count === 1 ? "" : "s"}`);
    return;
  }

  if (command === "export") {
    const result = await exportQuest(target);
    console.log(`Exported ${result.missionCount} missions to .repoquest/quest.yml`);
    return;
  }

  if (command === "play") {
    const playPort = process.env.PORT === undefined ? 4000 : Number.parseInt(process.env.PORT, 10);
    if (!Number.isInteger(playPort) || playPort < 0 || playPort > 65_535) throw new TypeError("PORT must be an integer between 0 and 65535");
    const application = await startRepoQuestServer({
      repositoryRoot: target,
      questManifestPath: questPath(target),
      port: playPort,
    });
    console.log(`Play mode ready for ${target}`);
    console.log(`Open http://localhost:${application.port} and edit the repository in your normal editor.`);
    await new Promise<void>((resolveWait) => {
      const stop = async () => {
        await application.close();
        resolveWait();
      };
      process.once("SIGINT", () => void stop());
      process.once("SIGTERM", () => void stop());
    });
    return;
  }

  help();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
