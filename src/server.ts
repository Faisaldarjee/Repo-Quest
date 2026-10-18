import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { planLocalMissions } from "./core/index.ts";
import {
  applyInvalidLoginFix,
  DEMO_FIXTURE_ROOT,
  seedInvalidLoginBug,
} from "./demo/demo-repository.ts";
import { createPlaySession, type PlaySession, type PlayState } from "./play/index.ts";
import { createGitHubPreview } from "./preview/github-preview.ts";
import {
  readCandidateDocument,
  reviewCandidates,
  validateCandidateEvidence,
} from "./core/maintainer-workflow.ts";

const ROOT = process.cwd();
const PUBLIC_ROOT = join(ROOT, "public");
const DEFAULT_QUEST_PATH = join(ROOT, "quests", "quest-shop.yml");

export interface RepoQuestServerOptions {
  readonly port?: number;
  readonly repositoryRoot?: string;
  readonly questManifestPath?: string;
}

export interface RunningRepoQuestServer {
  readonly server: Server;
  readonly session: PlaySession;
  readonly port: number;
  close(): Promise<void>;
}

interface DemoCompatibilityState {
  seededBug: boolean;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function configuredPort(value = process.env.PORT): number {
  if (value === undefined || value.trim() === "") return 4000;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new TypeError("PORT must be an integer between 0 and 65535");
  }
  return parsed;
}

function configuredPath(value: string | undefined, fallback: string): string {
  return resolve(value && value.trim().length > 0 ? value : fallback);
}

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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function extractTraceEvents(result: { readonly stdout: string }): string[] {
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

function stateWithCompatibility(state: PlayState, demoState: DemoCompatibilityState): PlayState & {
  readonly product: { readonly name: string; readonly brand: string; readonly tagline: string };
  readonly planner: { readonly mode: string; readonly candidates: number };
  readonly seededBug: boolean;
  readonly demo?: { readonly mutationMissionId: string; readonly seeded: boolean };
} {
  const planner = planLocalMissions(state.project.scan);
  return {
    ...state,
    product: {
      name: "RepoQuest",
      brand: "Faisal Labs",
      tagline: "Duolingo for codebases.",
    },
    planner: { mode: planner.mode, candidates: planner.candidates.length },
    seededBug: demoState.seededBug,
    ...(isDefaultDemoRepository(state.project.repositoryRoot)
      ? { demo: { mutationMissionId: "fix-invalid-login", seeded: demoState.seededBug } }
      : {}),
  };
}

function isDefaultDemoRepository(repositoryRoot: string): boolean {
  return resolve(repositoryRoot) === resolve(DEMO_FIXTURE_ROOT);
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

/** Create the generic local RepoQuest HTTP server without binding a port. */
export async function createRepoQuestServer(options: RepoQuestServerOptions = {}): Promise<RunningRepoQuestServer> {
  const repositoryRoot = configuredPath(options.repositoryRoot ?? process.env.REPOQUEST_REPO_ROOT, DEMO_FIXTURE_ROOT);
  const questManifestPath = configuredPath(options.questManifestPath ?? process.env.REPOQUEST_QUEST_PATH, DEFAULT_QUEST_PATH);
  let session = await createPlaySession({ repositoryRoot, questManifestPath });
  const demoState: DemoCompatibilityState = { seededBug: false };
  let defaultDemo = isDefaultDemoRepository(repositoryRoot) && resolve(questManifestPath) === resolve(DEFAULT_QUEST_PATH);
  let previewCleanup: (() => Promise<void>) | undefined;

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (request.method === "GET" && url.pathname === "/api/project") {
      sendJson(response, 200, await session.getProject());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/quest") {
      sendJson(response, 200, { ...session.getQuest(), path: session.questManifestPath });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/preview") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid JSON body" });
        return;
      }
      const githubUrl = typeof body.url === "string" ? body.url : "";
      let preview: Awaited<ReturnType<typeof createGitHubPreview>> | undefined;
      try {
        preview = await createGitHubPreview(githubUrl);
        const nextSession = await createPlaySession({ repositoryRoot: preview.root, questManifestPath: preview.manifestPath });
        const previousSession = session;
        const previousCleanup = previewCleanup;
        session = nextSession;
        previewCleanup = preview.cleanup;
        defaultDemo = false;
        demoState.seededBug = false;
        await previousSession.dispose();
        if (previousCleanup !== undefined) await previousCleanup();
        sendJson(response, 200, {
          preview: {
            url: preview.ref.url,
            owner: preview.ref.owner,
            name: preview.ref.name,
            reviewedByMaintainer: false,
            candidates: preview.planner.candidates.length,
          },
          state: stateWithCompatibility(await session.getState(), demoState),
        });
      } catch (error) {
        if (preview !== undefined) await preview.cleanup();
        sendJson(response, 400, { error: error instanceof Error ? error.message : "GitHub preview failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, stateWithCompatibility(await session.getState(), demoState));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/candidates") {
      try {
        const document = await readCandidateDocument(session.repositoryRoot);
        const review = await reviewCandidates(session.repositoryRoot);
        sendJson(response, 200, { ...document, review });
      } catch (error) {
        sendJson(response, 404, { error: error instanceof Error ? error.message : "No generated candidates found" });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/validate-candidates") {
      try {
        const review = await validateCandidateEvidence(session.repositoryRoot);
        const document = await readCandidateDocument(session.repositoryRoot);
        sendJson(response, 200, { ...document, review });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Candidate validation failed" });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      await session.reset();
      demoState.seededBug = false;
      sendJson(response, 200, stateWithCompatibility(await session.getState(), demoState));
      return;
    }

    // These two routes are retained for the included fixture UI. They operate on
    // the session copy, never on the configured repository itself.
    if (request.method === "POST" && url.pathname === "/api/seed-bug") {
      if (!defaultDemo) {
        sendJson(response, 404, { error: "The demo mutation is only available for the included fixture" });
        return;
      }
      await seedInvalidLoginBug(session.workspaceRoot);
      demoState.seededBug = true;
      sendJson(response, 200, stateWithCompatibility(await session.getState(), demoState));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/apply-fix") {
      if (!defaultDemo) {
        sendJson(response, 404, { error: "The demo mutation is only available for the included fixture" });
        return;
      }
      await applyInvalidLoginFix(session.workspaceRoot);
      sendJson(response, 200, stateWithCompatibility(await session.getState(), demoState));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/verify") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid JSON body" });
        return;
      }
      const missionId = typeof body.missionId === "string" ? body.missionId.trim() : "";
      if (!missionId) {
        sendJson(response, 400, { error: "missionId is required" });
        return;
      }
      // Keep the original fixture's mutation flow intact without making these
      // assumptions part of the generic play engine.
      if (defaultDemo && missionId === "fix-invalid-login" && !demoState.seededBug) {
        sendJson(response, 400, { error: "Seed the mutation before verifying this mission" });
        return;
      }
      try {
        const verification = await session.verifyMission(missionId);
        const traceEvents = extractTraceEvents(verification.result);
        sendJson(response, 200, {
          ...verification,
          traceEvents,
          state: stateWithCompatibility(await session.getState(), demoState),
        });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Mission verification failed" });
      }
      return;
    }

    sendJson(response, 404, { error: "API route not found" });
  };

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

  const close = async (): Promise<void> => {
    await new Promise<void>((resolveClose, reject) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await session.dispose();
    if (previewCleanup !== undefined) await previewCleanup();
  };

  return { server, session, port: options.port ?? configuredPort(), close };
}

/** Create and bind the local server. Port 4000 is the default; PORT and options may override it. */
export async function startRepoQuestServer(options: RepoQuestServerOptions = {}): Promise<RunningRepoQuestServer> {
  const application = await createRepoQuestServer(options);
  const port = options.port ?? configuredPort();
  await new Promise<void>((resolveListen, reject) => {
    application.server.once("error", reject);
    application.server.listen(port, "0.0.0.0", resolveListen);
  });
  const address = application.server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`RepoQuest running at http://localhost:${boundPort}`);
  return { ...application, port: boundPort };
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startRepoQuestServer()
    .then((application) => {
      let stopping = false;
      const shutdown = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        await application.close();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
