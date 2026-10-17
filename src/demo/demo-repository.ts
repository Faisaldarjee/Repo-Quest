import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEMO_FIXTURE_ROOT = join(process.cwd(), "fixtures", "quest-shop");
export const DEMO_WORKSPACE_ROOT = join(process.cwd(), ".repoquest", "demo-workspace");
const AUTH_FILE = join("src", "services", "auth-service.js");

export async function resetDemoWorkspace(): Promise<string> {
  await rm(DEMO_WORKSPACE_ROOT, { recursive: true, force: true });
  await mkdir(dirname(DEMO_WORKSPACE_ROOT), { recursive: true });
  await cp(DEMO_FIXTURE_ROOT, DEMO_WORKSPACE_ROOT, { recursive: true });
  return DEMO_WORKSPACE_ROOT;
}

export async function seedInvalidLoginBug(workspaceRoot = DEMO_WORKSPACE_ROOT): Promise<void> {
  const path = join(workspaceRoot, AUTH_FILE);
  const source = await readFile(path, "utf8");
  const correct = "if (!user || user.password !== password)";
  const broken = "if (user && user.password !== password)";
  if (!source.includes(correct) && !source.includes(broken)) {
    throw new Error("Demo mutation target was not found");
  }
  await writeFile(path, source.replace(correct, broken), "utf8");
}

export async function applyInvalidLoginFix(workspaceRoot = DEMO_WORKSPACE_ROOT): Promise<void> {
  const path = join(workspaceRoot, AUTH_FILE);
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace("if (user && user.password !== password)", "if (!user || user.password !== password)"), "utf8");
}
