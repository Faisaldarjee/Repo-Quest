import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateMissionCandidate,
  type MissionValidationState,
} from "./mission-validation.ts";
import type { MissionCandidate } from "./mission-planner.ts";
import { scanRepository, type RepositoryScanResult } from "./repository-scanner.ts";
import {
  type CommandResult,
  type MissionEvidence,
  type MissionEvidenceStage,
  createCommandResult,
  createSafeCommand,
  createVerificationResult,
  type SafeCommand,
  type VerificationResult,
  validateSafeCommand,
} from "./result-model.ts";
import {
  runSafeCommand,
  type CommandRunnerOptions,
} from "./command-runner.ts";
import type { MissionValidationPlan, QuestMission } from "./quest-manifest.ts";

/** Evidence adapters implemented by the offline compiler. */
export const SUPPORTED_MISSION_EVIDENCE = Object.freeze(["command", "test", "trace"] as const);
export type SupportedMissionEvidence = (typeof SUPPORTED_MISSION_EVIDENCE)[number];

export interface MissionCompilationSuccess {
  readonly valid: true;
  readonly mission: QuestMission;
  readonly plan: MissionValidationPlan;
  readonly adapter: SupportedMissionEvidence;
  readonly reasons: readonly [];
}

export interface MissionCompilationFailure {
  readonly valid: false;
  readonly missionId: string;
  readonly reasons: readonly string[];
}

export type MissionCompilationResult = MissionCompilationSuccess | MissionCompilationFailure;

export type MissionPipelineStatus = "verified" | "rejected" | "pending";

export interface MissionValidationPipelineResult {
  readonly missionId: string;
  readonly status: MissionPipelineStatus;
  /** The normalized mission is present when compilation succeeded. */
  readonly mission?: QuestMission;
  /** Every executed stage remains visible, including failed commands. */
  readonly evidence: readonly MissionEvidence[];
  readonly reasons: readonly string[];
  /** True only when baseline, solver, and verifier all passed. */
  readonly solverPassed: boolean;
  /** The temporary copy has been removed before this result is returned. */
  readonly workspaceDisposed: true;
}

export interface DisposableRepositoryCopy {
  readonly root: string;
  dispose(): Promise<void>;
}

export type MissionCommandRunner = (
  command: SafeCommand,
  options: CommandRunnerOptions,
) => Promise<CommandResult>;

export interface MissionValidationPipelineOptions {
  /** Reuse a scan when the caller already has one; otherwise scan the source. */
  readonly scan?: RepositoryScanResult;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly allowedExecutables?: ReadonlySet<string>;
  readonly env?: Readonly<Record<string, string>>;
  /** Injectable only for deterministic tests; the default is runSafeCommand. */
  readonly runCommand?: MissionCommandRunner;
}

type ValidationStage = "baseline" | "solver" | "verifier";
const VALIDATION_STAGES: readonly ValidationStage[] = ["baseline", "solver", "verifier"];
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const SCRIPT_PREFERENCE: readonly string[] = ["test", "verify", "check", "build", "lint"];

const TRACE_CHECK_SOURCE =
  "const fs=require('node:fs');const files=process.argv.slice(1);if(files.length===0||files.some((file)=>!fs.existsSync(file)))process.exit(1);";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedEvidence(value: unknown): value is SupportedMissionEvidence {
  return typeof value === "string" && (SUPPORTED_MISSION_EVIDENCE as readonly string[]).includes(value);
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isRepositoryRelativePath(value: string): boolean {
  const normalized = portablePath(value);
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((part) => part === "..") &&
    !normalized.split("/").some((part) => part.length === 0);
}

function missionIdOf(candidate: unknown): string {
  return isRecord(candidate) && typeof candidate.id === "string" && candidate.id.trim().length > 0
    ? candidate.id.trim()
    : "unknown-mission";
}

function failure(missionId: string, ...reasons: string[]): MissionCompilationFailure {
  return { valid: false, missionId, reasons: Object.freeze(reasons) };
}

function validateCandidateMetadata(candidate: MissionCandidate): readonly string[] {
  const reasons: string[] = [];
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) reasons.push("Mission id must be a non-empty string");
  if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) reasons.push("Mission title must be a non-empty string");
  if (typeof candidate.objective !== "string" || candidate.objective.trim().length === 0) reasons.push("Mission objective must be a non-empty string");
  if (!Array.isArray(candidate.targetFiles)) reasons.push("Mission targetFiles must be an array");
  if (typeof candidate.concept !== "string") reasons.push("Mission concept must be a string");
  if (candidate.difficulty !== "beginner" && candidate.difficulty !== "intermediate") reasons.push("Mission difficulty must be beginner or intermediate");
  if (!isSupportedEvidence(candidate.evidence)) {
    reasons.push(`Unsupported evidence type: ${String(candidate.evidence)}; supported evidence types are command, test, trace`);
  }
  return Object.freeze(reasons);
}

function validateTargetFiles(candidate: MissionCandidate, scan: RepositoryScanResult): readonly string[] {
  const reasons: string[] = [];
  for (const rawFile of candidate.targetFiles) {
    if (typeof rawFile !== "string" || !isRepositoryRelativePath(rawFile)) {
      reasons.push(`Target file is not a repository-relative path: ${String(rawFile)}`);
      continue;
    }
    const file = portablePath(rawFile);
    if (!scan.files.includes(file)) reasons.push(`Target file is not present in the repository scan: ${file}`);
  }
  return Object.freeze(reasons);
}

function freezePlan(plan: MissionValidationPlan): MissionValidationPlan {
  return Object.freeze({
    baseline: plan.baseline,
    solver: plan.solver,
    verifier: plan.verifier,
  });
}

function validateExplicitPlan(candidate: MissionCandidate): MissionCompilationResult | MissionValidationPlan {
  if (candidate.validation === undefined) return failure(candidate.id, "Mission does not provide an executable validation plan");

  const reasons: string[] = [];
  const plan: Partial<Record<ValidationStage, SafeCommand>> = {};
  for (const stage of VALIDATION_STAGES) {
    const command = candidate.validation[stage];
    if (command === undefined) {
      reasons.push(`${stageLabel(stage)} command is required for a compiled mission`);
      continue;
    }
    const checked = validateSafeCommand(command);
    if (!checked.valid) {
      reasons.push(...checked.errors.map((error) => `${stage} command ${error.path}: ${error.message}`));
      continue;
    }
    plan[stage] = checked.value;
  }
  return reasons.length > 0
    ? failure(candidate.id, ...reasons)
    : freezePlan({ baseline: plan.baseline, solver: plan.solver, verifier: plan.verifier });
}

function scriptCommand(scan: RepositoryScanResult, required: readonly string[]): SafeCommand | undefined {
  const scriptName = required.find((name) => scan.packageScripts[name] !== undefined);
  if (scriptName === undefined) return undefined;
  return createSafeCommand("npm", scriptName === "test" ? ["test"] : ["run", scriptName], {
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
}

function traceCommand(targetFiles: readonly string[]): SafeCommand {
  return createSafeCommand("node", ["-e", TRACE_CHECK_SOURCE, "--", ...targetFiles], {
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
}

function derivedPlan(candidate: MissionCandidate, scan: RepositoryScanResult): MissionCompilationResult | MissionValidationPlan {
  if (candidate.validation !== undefined) return validateExplicitPlan(candidate);

  if (candidate.evidence === "test") {
    const command = scriptCommand(scan, ["test"]);
    if (command === undefined) return failure(candidate.id, "Test missions require a repository package test script");
    return freezePlan({ baseline: command, solver: command, verifier: command });
  }

  if (candidate.evidence === "trace") {
    if (candidate.targetFiles.length === 0) return failure(candidate.id, "Trace missions require at least one scanned target file");
    const command = traceCommand(candidate.targetFiles.map(portablePath));
    const baseline = scriptCommand(scan, ["test", "verify", "check"]) ?? command;
    return freezePlan({ baseline, solver: command, verifier: command });
  }

  const command = scriptCommand(scan, SCRIPT_PREFERENCE);
  if (command === undefined) {
    return failure(candidate.id, "Command missions require one of the repository scripts: test, verify, check, build, or lint");
  }
  return freezePlan({ baseline: command, solver: command, verifier: command });
}

/**
 * Compile a local or AI candidate into a fully executable QuestMission.
 *
 * Package script contents are never copied into a command. The compiler emits
 * only argv commands such as `npm test`, `npm run check`, or a fixed Node file
 * existence check, all of which remain subject to runSafeCommand's allow-list.
 */
export function compileMissionCandidate(
  candidate: MissionCandidate,
  scan: RepositoryScanResult,
): MissionCompilationResult {
  const missionId = missionIdOf(candidate);
  const metadataReasons = validateCandidateMetadata(candidate);
  if (metadataReasons.length > 0) return failure(missionId, ...metadataReasons);

  const targetReasons = validateTargetFiles(candidate, scan);
  if (targetReasons.length > 0) return failure(missionId, ...targetReasons);

  const planResult = derivedPlan(candidate, scan);
  if ("valid" in planResult) return planResult;

  const plan = freezePlan(planResult);
  const mission: QuestMission = Object.freeze({
    id: candidate.id.trim(),
    title: candidate.title.trim(),
    objective: candidate.objective.trim(),
    validation: plan,
    ...(candidate.concept.trim().length > 0 ? { concept: candidate.concept.trim() } : {}),
    ...(candidate.difficulty === undefined ? {} : { difficulty: candidate.difficulty }),
  });
  return {
    valid: true,
    mission,
    plan,
    adapter: candidate.evidence,
    reasons: Object.freeze([]),
  };
}

/** Descriptive alias for callers that prefer the target type in the name. */
export const compileCandidateToQuestMission = compileMissionCandidate;

async function disposableCopy(repositoryRoot: string): Promise<DisposableRepositoryCopy> {
  const source = resolve(repositoryRoot);
  const workspace = await mkdtemp(join(tmpdir(), "repoquest-verify-"));
  try {
    await cp(source, workspace, { recursive: true, force: true });
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    root: workspace,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/** Create a copy whose lifetime can be explicitly bounded by an integration. */
export const createDisposableRepositoryCopy = disposableCopy;

function stageLabel(stage: MissionEvidenceStage): string {
  return `${stage[0]?.toUpperCase() ?? stage}${stage.slice(1)}`;
}

function commandFailureReason(stage: ValidationStage, result: CommandResult): string | undefined {
  if (result.status === "passed") return undefined;
  const detail = result.error ?? result.stderr.trim();
  return `${stageLabel(stage)} command ${result.status}${detail.length > 0 ? `: ${detail}` : ""}`;
}

function verifierResult(result: CommandResult): VerificationResult {
  const passed = result.status === "passed";
  const detail = (result.error ?? result.stderr.trim()) || result.stdout.trim();
  return createVerificationResult({
    outcome: passed ? "passed" : "failed",
    summary: passed ? "Verifier command passed" : `Verifier command ${result.status}`,
    checks: [{
      name: "verifier command",
      outcome: passed ? "passed" : "failed",
      ...(detail.length > 0 ? { detail } : {}),
    }],
    commandResult: result,
  });
}

function pendingReasons(state: MissionValidationState): readonly string[] {
  return state.reasons.length > 0 ? state.reasons : Object.freeze(["Awaiting baseline, solver, and verifier evidence"]);
}

function resultFor(
  missionId: string,
  mission: QuestMission | undefined,
  evidence: readonly MissionEvidence[],
  state: MissionValidationState,
  extraReasons: readonly string[] = [],
): MissionValidationPipelineResult {
  const status: MissionPipelineStatus = state.status === "verified" ? "verified" : state.status === "rejected" ? "rejected" : "pending";
  const reasons = status === "pending" ? pendingReasons(state) : [...state.reasons, ...extraReasons];
  return Object.freeze({
    missionId,
    status,
    ...(mission === undefined ? {} : { mission }),
    evidence: Object.freeze([...evidence]),
    reasons: Object.freeze([...reasons]),
    // Solver acceptance is deliberately derived from the final state. A
    // passing solver command alone can never make this flag true.
    solverPassed: status === "verified",
    workspaceDisposed: true as const,
  });
}

function rejectedPipelineResult(missionId: string, reasons: readonly string[], mission?: QuestMission): MissionValidationPipelineResult {
  return Object.freeze({
    missionId,
    status: "rejected" as const,
    ...(mission === undefined ? {} : { mission }),
    evidence: Object.freeze([]) as readonly MissionEvidence[],
    reasons: Object.freeze([...reasons]),
    solverPassed: false,
    workspaceDisposed: true as const,
  });
}

/**
 * Compile and validate a candidate in a disposable copy of a repository.
 * Baseline, solver, and verifier are always executed in order and retained as
 * evidence. The verifier is represented by an explicit VerificationResult,
 * and only an all-stage pass can produce `status: "verified"`.
 */
export async function validateMissionCandidate(
  repositoryRoot: string,
  candidate: MissionCandidate,
  options: MissionValidationPipelineOptions = {},
): Promise<MissionValidationPipelineResult> {
  const missionId = missionIdOf(candidate);
  let scan: RepositoryScanResult;
  try {
    scan = options.scan ?? await scanRepository(repositoryRoot);
  } catch (error: unknown) {
    return rejectedPipelineResult(missionId, [`Repository scan failed: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const compilation = compileMissionCandidate(candidate, scan);
  if (!compilation.valid) return rejectedPipelineResult(compilation.missionId, compilation.reasons);

  let copy: DisposableRepositoryCopy;
  try {
    copy = await disposableCopy(repositoryRoot);
  } catch (error: unknown) {
    return rejectedPipelineResult(missionId, [`Disposable repository copy failed: ${error instanceof Error ? error.message : String(error)}`], compilation.mission);
  }

  const evidence: MissionEvidence[] = [];
  let state = evaluateMissionCandidate(missionId, evidence);
  const runner = options.runCommand ?? runSafeCommand;
  const extraReasons: string[] = [];
  try {
    for (const stage of VALIDATION_STAGES) {
      const command = compilation.plan[stage];
      if (command === undefined) {
        extraReasons.push(`${stageLabel(stage)} command is missing from the compiled validation plan`);
        continue;
      }
      const runnerOptions: CommandRunnerOptions = {
        repoRoot: copy.root,
        ...(options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.allowedExecutables === undefined ? {} : { allowedExecutables: options.allowedExecutables }),
        ...(options.env === undefined ? {} : { env: options.env }),
      };
      let commandResult: CommandResult;
      try {
        commandResult = await runner(command, runnerOptions);
      } catch (error: unknown) {
        commandResult = createCommandResult({
          command,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const result: CommandResult | VerificationResult = stage === "verifier" ? verifierResult(commandResult) : commandResult;
      const item: MissionEvidence = Object.freeze({
        stage,
        result,
        note: `Executed in disposable repository copy (${portablePath(relative(copy.root, resolve(copy.root, command.cwd ?? "."))) || "."})`,
      });
      evidence.push(item);
      state = evaluateMissionCandidate(missionId, evidence);
      const detail = commandFailureReason(stage, commandResult);
      if (detail !== undefined) extraReasons.push(detail);
    }
  } finally {
    await copy.dispose();
  }

  return resultFor(missionId, compilation.mission, evidence, state, extraReasons);
}

/** Descriptive alias for integrations that call the operation a pipeline run. */
export const runMissionValidation = validateMissionCandidate;
