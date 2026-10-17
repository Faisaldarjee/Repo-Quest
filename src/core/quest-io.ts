import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { parseQuestManifest, type QuestManifest } from "./quest-manifest.ts";

export async function readQuestManifest(filePath: string): Promise<QuestManifest> {
  const text = await readFile(filePath, "utf8");
  return parseQuestManifest(parse(text));
}
