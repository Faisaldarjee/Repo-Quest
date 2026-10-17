import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { planLocalMissions, readQuestManifest, scanRepository } from "./core/index.ts";

const QUEST_TEMPLATE = `schemaVersion: 1\nid: my-repository\ntitle: My Repository Quest\ndescription: A verified onboarding path for this repository.\nmissions: []\n`;

function help(): void {
  console.log(`RepoQuest — Duolingo for codebases\n\nCommands:\n  init [path]       Create a .repoquest quest workspace\n  scan [path]       Scan files, scripts, routes, tests, and symbols\n  generate [path]   Generate deterministic mission candidates\n  validate [file]   Validate a quest YAML manifest\n`);
}

async function main(): Promise<void> {
  const [command, value] = process.argv.slice(2);
  const target = resolve(value ?? ".");

  if (command === "init") {
    const directory = join(target, ".repoquest");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "quest.yml"), QUEST_TEMPLATE, "utf8");
    console.log(`Created ${join(directory, "quest.yml")}`);
    return;
  }

  if (command === "scan") {
    console.log(JSON.stringify(await scanRepository(target), null, 2));
    return;
  }

  if (command === "generate") {
    console.log(JSON.stringify(planLocalMissions(await scanRepository(target)), null, 2));
    return;
  }

  if (command === "validate") {
    const manifest = await readQuestManifest(target === resolve(".") ? join(target, ".repoquest", "quest.yml") : target);
    console.log(`Valid quest: ${manifest.title} (${manifest.missions.length} missions)`);
    return;
  }

  help();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
