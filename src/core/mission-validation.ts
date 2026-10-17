import {
  type CommandResult,
  type MissionEvidence,
  type MissionEvidenceStage,
  type VerificationResult,
} from "./result-model.ts";

export type MissionValidationStatus = "candidate" | "verified" | "rejected";
export type EvidenceVerdict = "passed" | "failed" | "inconclusive";

export interface MissionValidationState {
  readonly missionId: string;
  readonly status: MissionValidationStatus;
  readonly evidence: readonly MissionEvidence[];
  readonly reasons: readonly string[];
}

function isCommandResult(result: CommandResult | VerificationResult): result is CommandResult {
  return result.kind === "command";
}

function verdictFor(result: CommandResult | VerificationResult): EvidenceVerdict {
  if (isCommandResult(result)) {
    return result.status === "passed" ? "passed" : "failed";
  }
  return result.outcome;
}

function stageLabel(stage: MissionEvidenceStage): string {
  return `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

function assessEvidence(evidence: readonly MissionEvidence[]): {
  readonly status: MissionValidationStatus;
  readonly reasons: readonly string[];
} {
  const byStage = new Map<MissionEvidenceStage, EvidenceVerdict[]>();
  for (const item of evidence) {
    const values = byStage.get(item.stage) ?? [];
    values.push(verdictFor(item.result));
    byStage.set(item.stage, values);
  }

  const stages = ["baseline", "solver", "verifier"] as const;
  const failedStages = stages.filter((stage) => (byStage.get(stage) ?? []).includes("failed"));
  if (failedStages.length > 0) {
    return {
      status: "rejected",
      reasons: Object.freeze(failedStages.map((stage) => `${stageLabel(stage)} evidence failed`)),
    };
  }

  const complete = stages.every((stage) => (byStage.get(stage) ?? []).includes("passed"));
  return {
    status: complete ? "verified" : "candidate",
    reasons: Object.freeze(complete ? ["Baseline, solver, and verifier evidence passed"] : []),
  };
}

export function createMissionValidationState(missionId: string): MissionValidationState {
  if (typeof missionId !== "string" || missionId.trim().length === 0) {
    throw new TypeError("missionId must be a non-empty string");
  }
  return Object.freeze({
    missionId: missionId.trim(),
    status: "candidate" as const,
    evidence: Object.freeze([]) as readonly MissionEvidence[],
    reasons: Object.freeze([]) as readonly string[],
  });
}

/**
 * Apply one immutable evidence event. Evidence is retained rather than
 * replaced, making the decision independent of event ordering and ensuring a
 * failed check cannot be accidentally hidden by a later passing check.
 */
export function transitionMissionValidation(
  state: MissionValidationState,
  evidence: MissionEvidence,
): MissionValidationState {
  if (evidence.stage !== "baseline" && evidence.stage !== "solver" && evidence.stage !== "verifier") {
    throw new TypeError("evidence.stage must be baseline, solver, or verifier");
  }

  const allEvidence = Object.freeze([...state.evidence, evidence]);
  const assessment = assessEvidence(allEvidence);
  return Object.freeze({
    missionId: state.missionId,
    status: assessment.status,
    evidence: allEvidence,
    reasons: assessment.reasons,
  });
}

export function evaluateMissionCandidate(
  missionId: string,
  evidence: readonly MissionEvidence[],
): MissionValidationState {
  let state = createMissionValidationState(missionId);
  for (const item of evidence) {
    state = transitionMissionValidation(state, item);
  }
  return state;
}

export class MissionValidationStateMachine {
  private current: MissionValidationState;

  public constructor(missionId: string) {
    this.current = createMissionValidationState(missionId);
  }

  public get state(): MissionValidationState {
    return this.current;
  }

  public apply(evidence: MissionEvidence): MissionValidationState {
    this.current = transitionMissionValidation(this.current, evidence);
    return this.current;
  }
}
