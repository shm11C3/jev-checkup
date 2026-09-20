import type { AspectDefinition, Config } from "../types.js";
import { testQuestionsTemplate } from "./questions.js";

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

/** Build the immutable test-honesty definition used by selection and observation. */
export function getTestAspectDefinition(config: Config): AspectDefinition {
  return {
    id: "test-honesty",
    propositionVersion: "test-title-honesty@1",
    model: config.model || DEFAULT_MODEL,
    selector: "tests@2",
    parser: "@ast-grep/napi@0.45.3",
    contextPolicy: "focusprod-or-focus@2",
    composition: "test-honesty@1",
    weights: { core: 0.6, partial: 0.25, weak: 0.4, weakMid: 0.5 },
    thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
    bandEdges: [0, 0.05, 0.15, 0.3],
    questions: JSON.parse(JSON.stringify(testQuestionsTemplate)) as AspectDefinition["questions"],
  };
}

export { testQuestionsTemplate } from "./questions.js";
