import type { RepositoryScanResult } from "./repository-scanner.ts";
import type { MissionValidationPlan } from "./quest-manifest.ts";

export type PlannerMode = "local-rules" | "openai-compatible";

export interface MissionCandidate {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly concept: string;
  readonly difficulty: "beginner" | "intermediate";
  readonly evidence: "command" | "trace" | "test";
  readonly targetFiles: readonly string[];
  readonly source: "local-rules" | "ai";
  readonly validation?: MissionValidationPlan;
}

export interface MissionPlan {
  readonly mode: PlannerMode;
  readonly candidates: readonly MissionCandidate[];
}

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly fetcher?: typeof fetch;
}

function first(items: readonly string[], fallback: string): string {
  return items[0] ?? fallback;
}

/** Produce reliable candidates without a network call. Candidates publish only after verification. */
export function planLocalMissions(scan: RepositoryScanResult): MissionPlan {
  const candidates: MissionCandidate[] = [];
  const testScript = scan.packageScripts.test;
  if (testScript !== undefined) {
    const npmTest = { executable: "npm", args: ["test"], timeoutMs: 60_000 } as const;
    candidates.push({
      id: "boot-the-project",
      title: "Boot the Project",
      objective: `Run the repository test script (${testScript}) and confirm the baseline is healthy.`,
      concept: "Project setup",
      difficulty: "beginner",
      evidence: "command",
      targetFiles: ["package.json"],
      source: "local-rules",
      validation: { baseline: npmTest, solver: npmTest, verifier: npmTest },
    });
  }

  if (scan.exportedSymbols.length > 0) {
    const symbol = first(scan.exportedSymbols, "the main entry point");
    candidates.push({
      id: "trace-an-entry-point",
      title: "Trace an Entry Point",
      objective: `Follow execution into the exported symbol ${symbol} and prove the path with a runtime check.`,
      concept: "Code navigation",
      difficulty: "beginner",
      evidence: "trace",
      targetFiles: scan.files.filter((file) => file.endsWith(".js") || file.endsWith(".ts")).slice(0, 2),
      source: "local-rules",
    });
  }

  if (scan.tests.length > 0) {
    candidates.push({
      id: "add-a-regression-test",
      title: "Add a Regression Test",
      objective: `Extend ${first(scan.tests, "the test suite")} with a boundary case and keep the suite green.`,
      concept: "Testing",
      difficulty: "intermediate",
      evidence: "test",
      targetFiles: scan.tests.slice(0, 2),
      source: "local-rules",
    });
  }

  if (scan.likelyRoutes.length > 0) {
    candidates.push({
      id: "map-a-request-flow",
      title: "Map a Request Flow",
      objective: `Trace ${first(scan.likelyRoutes, "a route")} from its boundary to the service that handles it.`,
      concept: "Runtime behavior",
      difficulty: "intermediate",
      evidence: "trace",
      targetFiles: scan.files.filter((file) => /route|controller|service/i.test(file)).slice(0, 3),
      source: "local-rules",
    });
  }

  return { mode: "local-rules", candidates: Object.freeze(candidates) };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? text).trim());
}

function normalizeAiCandidate(value: unknown, scan: RepositoryScanResult): MissionCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const strings = [item.id, item.title, item.objective, item.concept];
  if (strings.some((part) => typeof part !== "string" || part.trim().length === 0)) return undefined;
  const evidence = item.evidence;
  if (evidence !== "command" && evidence !== "trace" && evidence !== "test") return undefined;
  const difficulty = item.difficulty === "intermediate" ? "intermediate" : item.difficulty === "beginner" ? "beginner" : undefined;
  if (difficulty === undefined) return undefined;
  const targetFiles = Array.isArray(item.targetFiles)
    ? item.targetFiles.filter((file): file is string => typeof file === "string" && scan.files.includes(file))
    : [];
  return {
    id: (item.id as string).trim().replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    title: (item.title as string).trim(),
    objective: (item.objective as string).trim(),
    concept: (item.concept as string).trim(),
    difficulty,
    evidence,
    targetFiles: Object.freeze(targetFiles),
    source: "ai",
  };
}

/** Ask an OpenAI-compatible endpoint for structured candidates and validate file references locally. */
export async function planWithOpenAICompatible(scan: RepositoryScanResult, options: OpenAICompatibleOptions): Promise<MissionPlan> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON with candidates. Each candidate must have id, title, objective, concept, difficulty beginner/intermediate, evidence command/trace/test, and targetFiles." },
        { role: "user", content: JSON.stringify({ repository: scan }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI planner request failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) throw new Error("AI planner returned an invalid response");
  const choices = (payload as Record<string, unknown>).choices;
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  if (typeof content !== "string") throw new Error("AI planner did not return message content");
  const decoded = extractJson(content);
  const rawCandidates = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? (decoded as Record<string, unknown>).candidates : undefined;
  if (!Array.isArray(rawCandidates)) throw new Error("AI planner response is missing candidates");
  const candidates = rawCandidates.map((candidate) => normalizeAiCandidate(candidate, scan)).filter((candidate): candidate is MissionCandidate => candidate !== undefined);
  return { mode: "openai-compatible", candidates: Object.freeze(candidates) };
}
