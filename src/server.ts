import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  readQuestManifest,
  planLocalMissions,
  runSafeCommand,
  scanRepository,
  type CommandResult,
  type QuestManifest,
} from "./core/index.ts";
import {
  applyInvalidLoginFix,
  DEMO_WORKSPACE_ROOT,
  resetDemoWorkspace,
  seedInvalidLoginBug,
} from "./demo/demo-repository.ts";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const ROOT = process.cwd();
const PUBLIC_ROOT = join(ROOT, "public");
const QUEST_PATH = join(ROOT, "quests", "quest-shop.yml");
const workspaceReady = resetDemoWorkspace();

interface DemoState {
  readonly passed: Set<string>;
  seededBug: boolean;
  readonly activity: string[];
}

const demoState: DemoState = {
  passed: new Set(),
  seededBug: false,
  activity: ["RepoQuest demo workspace prepared"],
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (Buffer.byteLength(body, "utf8") > 64_000) throw new Error("Request body is too large");
  }
  if (!body.trim()) return {};
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Request body must be an object");
  return parsed as Record<string, unknown>;
}

function addActivity(message: string): void {
  demoState.activity.unshift(message);
  demoState.activity.splice(8);
}

function commandFor(missionId: string): { executable: string; args: string[] } | undefined {
  if (missionId === "boot-the-shop") return { executable: "node", args: ["tests/run-tests.js"] };
  if (missionId === "trace-login-flow") return { executable: "node", args: ["scripts/trace-login.js"] };
  if (missionId === "fix-invalid-login") return { executable: "node", args: ["tests/invalid-login.js"] };
  return undefined;
}

async function verifyMission(missionId: string): Promise<CommandResult | undefined> {
  const command = commandFor(missionId);
  if (command === undefined) return undefined;
  return runSafeCommand(
    { executable: command.executable, args: command.args, cwd: ".", timeoutMs: 5_000 },
    { repoRoot: DEMO_WORKSPACE_ROOT, defaultTimeoutMs: 5_000 },
  );
}

function extractTraceEvents(result: CommandResult): string[] {
  return result.stdout
    .split("\n")
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null && "event" in parsed && typeof parsed.event === "string" ? parsed.event : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is string => event !== undefined);
}

function missionViews(manifest: QuestManifest) {
  const order = manifest.missions.map((mission) => mission.id);
  return manifest.missions.map((mission, index) => {
    const previous = index === 0 || demoState.passed.has(order[index - 1] ?? "");
    const status = demoState.passed.has(mission.id) ? "completed" : previous ? "available" : "locked";
    return { ...mission, status, seeded: mission.id === "fix-invalid-login" && demoState.seededBug };
  });
}

async function statePayload() {
  await workspaceReady;
  const [manifest, scan] = await Promise.all([readQuestManifest(QUEST_PATH), scanRepository(DEMO_WORKSPACE_ROOT)]);
  const planner = planLocalMissions(scan);
  return {
    product: {
      name: "RepoQuest",
      brand: "Faisal Labs",
      tagline: "Duolingo for codebases.",
    },
    manifest: { id: manifest.id, title: manifest.title, description: manifest.description },
    scan: {
      files: scan.files.length,
      tests: scan.tests.length,
      routes: scan.likelyRoutes.length,
      symbols: scan.exportedSymbols.length,
      packageScripts: scan.packageScripts,
    },
    planner: { mode: planner.mode, candidates: planner.candidates.length },
    missions: missionViews(manifest),
    progress: { completed: demoState.passed.size, total: manifest.missions.length },
    activity: demoState.activity,
    seededBug: demoState.seededBug,
  };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, await statePayload());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reset") {
    await resetDemoWorkspace();
    demoState.passed.clear();
    demoState.seededBug = false;
    demoState.activity.splice(0, demoState.activity.length, "Demo workspace reset to a clean checkout");
    sendJson(response, 200, await statePayload());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/seed-bug") {
    await workspaceReady;
    await seedInvalidLoginBug();
    demoState.seededBug = true;
    addActivity("Mutation seeded: invalid users now exercise the broken branch");
    sendJson(response, 200, await statePayload());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/apply-fix") {
    await workspaceReady;
    await applyInvalidLoginFix();
    addActivity("Guided patch applied in the disposable learner workspace");
    sendJson(response, 200, await statePayload());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/verify") {
    const body = await readJsonBody(request);
    const missionId = typeof body.missionId === "string" ? body.missionId : "";
    if (!missionId) {
      sendJson(response, 400, { error: "missionId is required" });
      return;
    }
    if (missionId === "fix-invalid-login" && !demoState.seededBug) {
      sendJson(response, 400, { error: "Seed the mutation before verifying this mission" });
      return;
    }
    const result = await verifyMission(missionId);
    if (result === undefined) {
      sendJson(response, 400, { error: "This mission is presentation-only in the MVP" });
      return;
    }
    const traceEvents = missionId === "trace-login-flow" ? extractTraceEvents(result) : [];
    const passed = result.status === "passed" && (missionId !== "trace-login-flow" || traceEvents.includes("auth-service.login"));
    if (passed) {
      demoState.passed.add(missionId);
      addActivity(`${missionId} verified with a real command run`);
    } else {
      addActivity(`${missionId} failed; learner received the captured output`);
    }
    sendJson(response, 200, {
      passed,
      missionId,
      result,
      traceEvents,
      state: await statePayload(),
    });
    return;
  }

  sendJson(response, 404, { error: "API route not found" });
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^([.][.][\\/])+/, "");
  const filePath = resolve(PUBLIC_ROOT, `.${safePath}`);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${sep}`) && !filePath.startsWith(`${PUBLIC_ROOT}/`)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    sendText(response, 200, content.toString(), MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
  } catch {
    sendText(response, 404, "Not found");
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    sendJson(response, 500, { error: message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RepoQuest running at http://localhost:${PORT}`);
});
