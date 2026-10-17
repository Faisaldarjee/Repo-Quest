#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(packageRoot, "src", "cli.ts");

if (!existsSync(tsx) || !existsSync(cli)) {
  console.error("RepoQuest installation is incomplete: runtime files are missing.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
