import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  evaluateMissionCandidate,
  type MissionValidationStatus,
} from "./mission-validation.ts";
import {
  planLocalMissions,
  type MissionCandidate,
  type MissionPlan,
} from "./mission-planner.ts";
import { scanRepository } from "./repository-scanner.ts";
import type { MissionEvidence } from "./result-model.ts";

export const REPOQUEST_DIRECTORY = ".repoquest" as const;
export const QUEST_FILE_NAME = "quest.yml" as const;
export const CONFIG_FILE_NAME = "config.json" as const;
export const CANDIDATES_FILE_NAME = "candidates.json" as const;
export const EVIDENCE_FILE_NAME = "evidence.json" as const;

export type ReviewStatus = "verified" | "rejected" | "pending";

export interface InitResult {
  readonly repositoryRoot: string;
  readonly questPath: string;
  readonly configPath: string;
  readonly questCreated: boolean;
  readonly configCreated: boolean;
}

export interface CandidateRecord extends MissionCandidate {
  readonly status?: MissionValidationStatus | "pending" | "approved";
  readonly approval?: "approved" | "rejected";
  readonly approved?: boolean;
  readonly evidenceResults?: readonly MissionEvidence[];
  readonly reasons?: readonly string[];
}

export interface CandidateDocument {
  readonly mode: MissionPlan["mode"];
  readonly candidates: readonly CandidateRecord[];
}

export interface MissionReview {
  readonly id: string;
  readonly title: string;
  readonly status: ReviewStatus;
  readonly reasons: readonly string[];
}

export interface ReviewSummary {
  readonly verified: number;
  readonly rejected: number;
  readonly pending: number;
  readonly missions: readonly MissionReview[];
}

export interface ExportResult {
  readonly filePath: string;
  readonly missionCount: number;
}

export const QUEST_TEMPLATE = `schemaVersion: 1
id: my-repository
title: My Repository Quest
description: A verified onboarding path for this repository.
missions: []
`;

export const CONFIG_TEMPLATE = `{
  "schemaVersion": 1,
  "planner": "local-rules",
  "repository": ".",
  "evidence": ".repoquest/evidence.json"
}
`;

function repositoryDirectory(repositoryRoot: string): string {
  return resolve(repositoryRoot);
}

export function repoquestDirectory(repositoryRoot: string): string {
  return join(repositoryDirectory(repositoryRoot), REPOQUEST_DIRECTORY);
}

export function questPath(repositoryRoot: string): string {
  return join(repoquestDirectory(repositoryRoot), QUEST_FILE_NAME);
}

export function configPath(repositoryRoot: string): string {
  return join(repoquestDirectory(repositoryRoot), CONFIG_FILE_NAME);
}

export function candidatesPath(repositoryRoot: string): string {
  return join(repoquestDirectory(repositoryRoot), CANDIDATES_FILE_NAME);
}

export function evidencePath(repositoryRoot: string): string {
  return join(repoquestDirectory(repositoryRoot), EVIDENCE_FILE_NAME);
}

async function createIfMissing(path: string, contents: string): Promise<boolean> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/** Create the local workspace without replacing maintainer-authored files. */
export async function initializeWorkspace(repositoryRoot: string): Promise<InitResult> {
  const root = repositoryDirectory(repositoryRoot);
  const directory = repoquestDirectory(root);
  await mkdir(directory, { recursive: true });
  const [questCreated, configCreated] = await Promise.all([
    createIfMissing(questPath(root), QUEST_TEMPLATE),
    createIfMissing(configPath(root), CONFIG_TEMPLATE),
  ]);
  return {
    repositoryRoot: root,
    questPath: questPath(root),
    configPath: configPath(root),
    questCreated,
    configCreated,
  };
}

/** Scan and persist the offline local-rule planner output. */
export async function generateCandidatePlan(repositoryRoot: string): Promise<MissionPlan> {
  const root = repositoryDirectory(repositoryRoot);
  const plan = planLocalMissions(await scanRepository(root));
  await mkdir(repoquestDirectory(root), { recursive: true });
  await writeFile(candidatesPath(root), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissionValidationStatus(value: unknown): value is MissionValidationStatus {
  return value === "candidate" || value === "verified" || value === "rejected";
}

function isPortablePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((part) => part === "..")
  );
}

function candidateFromUnknown(value: unknown): CandidateRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const title = value.title;
  const objective = value.objective;
  const concept = value.concept;
  const difficulty = value.difficulty;
  const evidence = value.evidence;
  const source = value.source;
  const targetFiles = value.targetFiles;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof objective !== "string" ||
    typeof concept !== "string" ||
    (difficulty !== "beginner" && difficulty !== "intermediate") ||
    (evidence !== "command" && evidence !== "trace" && evidence !== "test") ||
    source !== "local-rules" && source !== "ai" ||
    !Array.isArray(targetFiles)
  ) {
    return undefined;
  }

  const portableTargetFiles = targetFiles.filter(
    (file): file is string => typeof file === "string" && isPortablePath(file),
  );
  const status = isMissionValidationStatus(value.status) || value.status === "pending" || value.status === "approved"
    ? value.status
    : undefined;
  const approval = value.approval === "approved" || value.approval === "rejected" ? value.approval : undefined;
  return {
    id,
    title,
    objective,
    concept,
    difficulty,
    evidence,
    targetFiles: Object.freeze(portableTargetFiles.map((file) => file.replaceAll("\\", "/"))),
    source,
    ...(status === undefined ? {} : { status }),
    ...(approval === undefined ? {} : { approval }),
    ...(value.approved === true ? { approved: true } : {}),
    ...(Array.isArray(value.evidenceResults) ? { evidenceResults: value.evidenceResults as readonly MissionEvidence[] } : {}),
    ...(Array.isArray(value.reasons) ? { reasons: value.reasons.filter((reason): reason is string => typeof reason === "string") } : {}),
  };
}

export async function readCandidateDocument(repositoryRoot: string): Promise<CandidateDocument> {
  const raw = parse(await readFile(candidatesPath(repositoryRoot), "utf8"));
  if (!isRecord(raw) || (raw.mode !== "local-rules" && raw.mode !== "openai-compatible") || !Array.isArray(raw.candidates)) {
    throw new TypeError(".repoquest/candidates.json must contain a planner mode and candidates array");
  }
  const candidates = raw.candidates.map(candidateFromUnknown);
  if (candidates.some((candidate): candidate is undefined => candidate === undefined)) {
    throw new TypeError(".repoquest/candidates.json contains an invalid candidate");
  }
  return {
    mode: raw.mode,
    candidates: Object.freeze(candidates as CandidateRecord[]),
  };
}

/** Mark one candidate, or every candidate with `--all` semantics, as maintainer-approved. */
export async function approveCandidates(repositoryRoot: string, missionId?: string): Promise<number> {
  const document = await readCandidateDocument(repositoryRoot);
  const approveAll = missionId === undefined || missionId === "--all";
  let approvedCount = 0;
  const candidates = document.candidates.map((candidate) => {
    if (!approveAll && candidate.id !== missionId) return candidate;
    approvedCount += 1;
    return { ...candidate, status: "approved" as const, approval: "approved" as const, approved: true };
  });
  if (!approveAll && approvedCount === 0) throw new Error(`Unknown candidate: ${missionId}`);
  await writeFile(candidatesPath(repositoryRoot), `${JSON.stringify({ mode: document.mode, candidates }, null, 2)}\n`, "utf8");
  return approvedCount;
}

function isMissionEvidence(value: unknown): value is MissionEvidence {
  if (!isRecord(value)) return false;
  if (value.stage !== "baseline" && value.stage !== "solver" && value.stage !== "verifier") return false;
  if (!isRecord(value.result)) return false;
  if (value.result.kind === "command") {
    return value.result.status === "passed" || value.result.status === "failed" || value.result.status === "timed-out" || value.result.status === "blocked" || value.result.status === "error";
  }
  if (value.result.kind === "verification") {
    return value.result.outcome === "passed" || value.result.outcome === "failed" || value.result.outcome === "inconclusive";
  }
  return false;
}

function evaluateEvidence(missionId: string, value: unknown): { status: ReviewStatus; reasons: readonly string[] } | undefined {
  if (!Array.isArray(value) || !value.every(isMissionEvidence)) return undefined;
  const state = evaluateMissionCandidate(missionId, value);
  if (state.status === "verified") return { status: "verified", reasons: state.reasons };
  if (state.status === "rejected") return { status: "rejected", reasons: state.reasons };
  return { status: "pending", reasons: ["Awaiting baseline, solver, and verifier evidence"] };
}

function reviewFromLocalValue(missionId: string, value: unknown): { status: ReviewStatus; reasons: readonly string[] } | undefined {
  const evidence = evaluateEvidence(missionId, value);
  if (evidence !== undefined) return evidence;
  if (value === "verified" || value === "approved") {
    return { status: "verified", reasons: ["Marked approved locally"] };
  }
  if (value === "rejected") {
    return { status: "rejected", reasons: ["Marked rejected locally"] };
  }
  if (value === "pending" || value === "candidate") {
    return { status: "pending", reasons: ["Awaiting local evidence"] };
  }
  if (!isRecord(value)) return undefined;
  if (value.approved === true || value.approval === "approved" || value.status === "approved" || value.status === "verified") {
    return { status: "verified", reasons: ["Marked approved locally"] };
  }
  if (value.approval === "rejected" || value.status === "rejected") {
    const reasons = Array.isArray(value.reasons)
      ? value.reasons.filter((reason): reason is string => typeof reason === "string")
      : ["Marked rejected locally"];
    return { status: "rejected", reasons };
  }
  return reviewFromLocalValue(missionId, value.evidence ?? value.evidenceResults);
}

function explicitReview(candidate: CandidateRecord): { status: ReviewStatus; reasons: readonly string[] } | undefined {
  if (candidate.approved === true || candidate.approval === "approved" || candidate.status === "approved" || candidate.status === "verified") {
    return { status: "verified", reasons: ["Marked approved locally"] };
  }
  if (candidate.approval === "rejected" || candidate.status === "rejected") {
    return { status: "rejected", reasons: candidate.reasons ?? ["Marked rejected locally"] };
  }
  if (candidate.status === "candidate" || candidate.status === "pending") {
    return { status: "pending", reasons: ["Awaiting local evidence"] };
  }
  return undefined;
}

async function readEvidenceDocument(repositoryRoot: string): Promise<unknown> {
  try {
    return parse(await readFile(evidencePath(repositoryRoot), "utf8"));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function evidenceForCandidate(document: unknown, candidate: CandidateRecord): unknown {
  if (Array.isArray(document)) {
    const matching = document.find((entry) => isRecord(entry) && entry.missionId === candidate.id);
    return isRecord(matching) ? matching.evidence ?? matching.evidenceResults ?? matching.status : undefined;
  }
  if (!isRecord(document)) return undefined;
  const candidates = document.candidates;
  if (isRecord(candidates) && candidate.id in candidates) return candidates[candidate.id];
  if (Array.isArray(document.verified) && document.verified.includes(candidate.id)) return "verified";
  if (Array.isArray(document.rejected) && document.rejected.includes(candidate.id)) return "rejected";
  if (document.missionId === candidate.id) return document.evidence ?? document.evidenceResults ?? document.status;
  return candidate.id in document ? document[candidate.id] : undefined;
}

async function reviewCandidateDocument(repositoryRoot: string, document: CandidateDocument): Promise<ReviewSummary> {
  const evidenceDocument = await readEvidenceDocument(repositoryRoot);
  const missions = document.candidates.map((candidate) => {
    const evidence = reviewFromLocalValue(candidate.id, evidenceForCandidate(evidenceDocument, candidate)) ??
      reviewFromLocalValue(candidate.id, candidate.evidenceResults) ??
      explicitReview(candidate) ?? {
        status: "pending" as const,
        reasons: ["Awaiting local evidence"],
      };
    return {
      id: candidate.id,
      title: candidate.title,
      status: evidence.status,
      reasons: Object.freeze([...evidence.reasons]),
    };
  });
  return Object.freeze({
    verified: missions.filter((mission) => mission.status === "verified").length,
    rejected: missions.filter((mission) => mission.status === "rejected").length,
    pending: missions.filter((mission) => mission.status === "pending").length,
    missions: Object.freeze(missions),
  });
}

export async function reviewCandidates(repositoryRoot: string): Promise<ReviewSummary> {
  return reviewCandidateDocument(repositoryRoot, await readCandidateDocument(repositoryRoot));
}

export function formatReviewSummary(summary: ReviewSummary): string {
  const lines = [
    "RepoQuest review",
    `Verified: ${summary.verified}`,
    `Rejected: ${summary.rejected}`,
    `Pending: ${summary.pending}`,
  ];
  if (summary.missions.length === 0) {
    lines.push("No mission candidates found.");
  } else {
    for (const mission of summary.missions) {
      lines.push(`${mission.status.toUpperCase().padEnd(8)} ${mission.id} — ${mission.reasons.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s,"']+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]");
}

function removeAbsolutePaths(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|workspace|mnt|opt|root)(?:[\\/]|$))[^\s,'"`]+/gi, "[path]")
    .replace(/(^|\s)\/[^\s,'"`]+/g, "$1[path]");
}

function portableText(value: string, fallback: string): string {
  const clean = removeAbsolutePaths(redactSecrets(value).replaceAll("\u0000", "")).trim();
  return clean.length > 0 ? clean : fallback;
}

function portableId(value: string, fallback: string): string {
  const clean = portableText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || fallback;
}

function metadataFromQuest(value: unknown, root: string): { id: string; title: string; description: string } {
  if (!isRecord(value)) {
    const fallback = portableId(basename(root), "my-repository");
    return {
      id: fallback,
      title: "My Repository Quest",
      description: "A verified onboarding path for this repository.",
    };
  }
  const fallbackId = portableId(basename(root), "my-repository");
  return {
    id: portableId(typeof value.id === "string" ? value.id : fallbackId, fallbackId),
    title: portableText(typeof value.title === "string" ? value.title : "My Repository Quest", "My Repository Quest"),
    description: portableText(
      typeof value.description === "string" ? value.description : "A verified onboarding path for this repository.",
      "A verified onboarding path for this repository.",
    ),
  };
}

async function readQuestMetadata(repositoryRoot: string): Promise<{ id: string; title: string; description: string }> {
  const root = repositoryDirectory(repositoryRoot);
  try {
    return metadataFromQuest(parse(await readFile(questPath(root), "utf8")), root);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") throw error;
    return metadataFromQuest(undefined, root);
  }
}

function uniqueMissionId(value: string, used: Set<string>): string {
  const base = portableId(value, "mission");
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

/** Export only locally approved or fully verified candidates as a portable manifest. */
export async function exportQuest(repositoryRoot: string): Promise<ExportResult> {
  const root = repositoryDirectory(repositoryRoot);
  const document = await readCandidateDocument(root);
  const summary = await reviewCandidateDocument(root, document);
  const eligible = document.candidates.filter((candidate) => {
    const mission = summary.missions.find((item) => item.id === candidate.id);
    return mission?.status === "verified";
  });
  if (eligible.length === 0) {
    throw new Error("No approved or verified mission candidates are available to export");
  }

  const metadata = await readQuestMetadata(root);
  const usedIds = new Set<string>();
  const missions = eligible.map((candidate) => ({
    id: uniqueMissionId(candidate.id, usedIds),
    title: portableText(candidate.title, "Repository mission"),
    objective: portableText(candidate.objective, "Complete this repository mission."),
    tags: [candidate.concept, candidate.difficulty, candidate.evidence].map((tag) => portableText(tag, "repoquest")),
  }));
  const manifest = {
    schemaVersion: 1,
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    missions,
  };
  const output = `${stringify(manifest, { lineWidth: 0 })}`;
  await mkdir(repoquestDirectory(root), { recursive: true });
  await writeFile(questPath(root), output.endsWith("\n") ? output : `${output}\n`, "utf8");
  return { filePath: questPath(root), missionCount: missions.length };
}
