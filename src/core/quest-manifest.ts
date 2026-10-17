import {
  type MissionEvidenceStage,
  type SafeCommand,
  type ValidationIssue,
  validateSafeCommand,
} from "./result-model.ts";

/** The only manifest format understood by this core slice. */
export const QUEST_MANIFEST_VERSION = 1 as const;

export interface MissionValidationPlan {
  readonly baseline?: SafeCommand;
  readonly solver?: SafeCommand;
  readonly verifier?: SafeCommand;
}

export interface QuestMission {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly validation?: MissionValidationPlan;
  readonly tags?: readonly string[];
}

export interface QuestManifest {
  readonly schemaVersion: typeof QUEST_MANIFEST_VERSION;
  /** `version` is accepted as a compatibility alias when reading manifests. */
  readonly version?: typeof QUEST_MANIFEST_VERSION;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly missions: readonly QuestMission[];
}

export interface ManifestValidationSuccess {
  readonly valid: true;
  readonly value: QuestManifest;
}

export interface ManifestValidationFailure {
  readonly valid: false;
  readonly errors: readonly ValidationIssue[];
}

export type ManifestValidationResult = ManifestValidationSuccess | ManifestValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function addStringIssue(errors: ValidationIssue[], path: string, value: unknown, label: string): value is string {
  if (!nonEmptyString(value)) {
    errors.push({ path, message: `${label} must be a non-empty string` });
    return false;
  }
  return true;
}

function validateMissionValidationPlan(value: unknown, path: string, errors: ValidationIssue[]): MissionValidationPlan | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return undefined;
  }

  const plan: Partial<Record<MissionEvidenceStage, SafeCommand>> = {};
  for (const stage of ["baseline", "solver", "verifier"] as const) {
    const command = value[stage];
    if (command === undefined) {
      continue;
    }
    const checked = validateSafeCommand(command);
    if (!checked.valid) {
      for (const issue of checked.errors) {
        errors.push({ path: `${path}.${stage}${issue.path.slice(1)}`, message: issue.message });
      }
    } else {
      plan[stage] = checked.value;
    }
  }

  return plan;
}

function validateTags(value: unknown, path: string, errors: ValidationIssue[]): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((tag) => !nonEmptyString(tag))) {
    errors.push({ path, message: "must be an array of non-empty strings" });
    return undefined;
  }
  return Object.freeze(value.map((tag) => (tag as string).trim()));
}

/**
 * Validate and normalize untrusted JSON-like data as a version 1 manifest.
 * Unknown fields are ignored so a newer producer can still be inspected by
 * this read-only core slice, while all required fields are checked strictly.
 */
export function validateQuestManifest(input: unknown): ManifestValidationResult {
  if (!isRecord(input)) {
    return { valid: false, errors: [{ path: "$", message: "manifest must be an object" }] };
  }

  const errors: ValidationIssue[] = [];
  const schemaVersion = input.schemaVersion ?? input.version;
  if (schemaVersion !== QUEST_MANIFEST_VERSION) {
    errors.push({ path: "$.schemaVersion", message: `must be ${QUEST_MANIFEST_VERSION}` });
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== QUEST_MANIFEST_VERSION) {
    errors.push({ path: "$.schemaVersion", message: `must be ${QUEST_MANIFEST_VERSION}` });
  }
  if (input.version !== undefined && input.version !== QUEST_MANIFEST_VERSION) {
    errors.push({ path: "$.version", message: `must be ${QUEST_MANIFEST_VERSION}` });
  }

  const id = addStringIssue(errors, "$.id", input.id, "id") ? (input.id as string).trim() : "";
  const title = addStringIssue(errors, "$.title", input.title, "title") ? (input.title as string).trim() : "";
  const description = addStringIssue(errors, "$.description", input.description, "description")
    ? (input.description as string).trim()
    : "";

  const rawMissions = input.missions;
  const missions: QuestMission[] = [];
  if (!Array.isArray(rawMissions) || rawMissions.length === 0) {
    errors.push({ path: "$.missions", message: "must be a non-empty array" });
  } else {
    const ids = new Set<string>();
    rawMissions.forEach((rawMission, index) => {
      const path = `$.missions[${index}]`;
      if (!isRecord(rawMission)) {
        errors.push({ path, message: "must be an object" });
        return;
      }

      const missionId = addStringIssue(errors, `${path}.id`, rawMission.id, "id")
        ? (rawMission.id as string).trim()
        : "";
      const missionTitle = addStringIssue(errors, `${path}.title`, rawMission.title, "title")
        ? (rawMission.title as string).trim()
        : "";
      const objective = addStringIssue(errors, `${path}.objective`, rawMission.objective, "objective")
        ? (rawMission.objective as string).trim()
        : "";

      if (missionId !== "") {
        if (ids.has(missionId)) {
          errors.push({ path: `${path}.id`, message: "must be unique within the manifest" });
        }
        ids.add(missionId);
      }

      const validation = validateMissionValidationPlan(rawMission.validation, `${path}.validation`, errors);
      const tags = validateTags(rawMission.tags, `${path}.tags`, errors);
      missions.push({
        id: missionId,
        title: missionTitle,
        objective,
        ...(validation === undefined ? {} : { validation }),
        ...(tags === undefined ? {} : { tags }),
      });
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors: Object.freeze(errors) };
  }

  const normalized: QuestManifest = {
    schemaVersion: QUEST_MANIFEST_VERSION,
    ...(input.version === undefined ? {} : { version: QUEST_MANIFEST_VERSION }),
    id,
    title,
    description,
    missions: Object.freeze(missions),
  };
  return { valid: true, value: Object.freeze(normalized) };
}

/** Parse a manifest and throw a useful error when the input is invalid. */
export function parseQuestManifest(input: unknown): QuestManifest {
  const result = validateQuestManifest(input);
  if (!result.valid) {
    throw new TypeError(result.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }
  return result.value;
}

export function isQuestManifest(input: unknown): input is QuestManifest {
  return validateQuestManifest(input).valid;
}
