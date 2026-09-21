import type { AspectDefinition, Config } from "../types.js";
import { namingQuestionsTemplate, testQuestionsTemplate } from "./questions.js";

const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_THRESHOLDS = {
  strong: 0.8,
  unseen: 0.7,
  midLow: 0.35,
  midHigh: 0.65,
  confidence: 0.5,
  finding: 0.3,
  control: 0.5,
} as const;

// Naming is deliberately independent from the test-honesty overrides until
// the aspect has empirical calibration. Keep this provisional definition
// stable so a test threshold change cannot silently change naming history.
const NAMING_THRESHOLDS = {
  strong: 0.8,
  unseen: 0.7,
  midLow: 0.35,
  midHigh: 0.65,
  confidence: 0.5,
  finding: 0.5,
  control: 0.5,
} as const;

/** Build the immutable test-honesty definition used by selection and observation. */
export function getTestAspectDefinition(config: Config): AspectDefinition {
  return {
    id: "test-honesty",
    propositionVersion: "test-title-honesty@1",
    model: config.model || DEFAULT_MODEL,
    selector: "tests@3",
    parser: "@ast-grep/napi@0.45.3",
    contextPolicy: "focusprod-or-focus@3",
    composition: "test-honesty@1",
    weights: { core: 0.6, partial: 0.25, weak: 0.4, weakMid: 0.5 },
    thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
    bandEdges: [0, 0.05, 0.15, 0.3],
    questions: JSON.parse(JSON.stringify(testQuestionsTemplate)) as AspectDefinition["questions"],
  };
}

/** Build the fixed provisional naming-honesty definition. */
export function getNamingAspectDefinition(config: Config): AspectDefinition {
  return {
    id: "naming-honesty",
    propositionVersion: "naming-honesty@1",
    model: config.model || DEFAULT_MODEL,
    selector: "naming@1",
    parser: "@ast-grep/napi@0.45.3",
    contextPolicy: "declaration@1",
    composition: "naming-max@1",
    weights: { core: 1, partial: 0, weak: 0, weakMid: 0 },
    thresholds: { ...NAMING_THRESHOLDS },
    bandEdges: [0, 0.05, 0.15, 0.3],
    questions: JSON.parse(JSON.stringify(namingQuestionsTemplate)) as AspectDefinition["questions"],
  };
}

/** Return definitions in the configured aspect order, defaulting to tests. */
export function getAspectDefinitions(config: Config): AspectDefinition[] {
  const ids = config.aspects ?? ["test-honesty"];
  if (ids.length === 0) throw new Error("At least one aspect must be configured");
  return ids.map(id => {
    if (id === "test-honesty") return getTestAspectDefinition(config);
    if (id === "naming-honesty") return getNamingAspectDefinition(config);
    throw new Error(`Unsupported aspect: ${String(id)}`);
  });
}

export { namingQuestionsTemplate, testQuestionsTemplate } from "./questions.js";
