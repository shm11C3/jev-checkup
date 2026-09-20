export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Question { type: "noul" | "score" | "choice"; instructions: Json; criteria?: Json }
export type Questions = Record<string, Question>;
export type Answers = Record<string, Record<string, unknown>>;
export type ContextMode = "focus" | "focusprod";
export type Outcome = "finding" | "clean" | "cannot_tell" | "not_judged" | "unjudgeable" | "unevaluated";
export type Band = "0..0.05" | "0.05..0.15" | "0.15..0.30" | ">=0.30";
export interface Location { file: string; startLine: number; endLine: number }
export interface EvidenceSource { file: string; hash: string }
export interface Thresholds { strong: number; unseen: number; midLow: number; midHigh: number; confidence: number; finding: number; control: number }
export interface AspectDefinition {
  id: "test-honesty";
  propositionVersion: string;
  model: string;
  selector: string;
  parser: string;
  contextPolicy: string;
  composition: string;
  weights: { core: number; partial: number; weak: number; weakMid: number };
  thresholds: Thresholds;
  bandEdges: number[];
  questions: Questions;
}
export interface Config {
  model: string;
  include: string[];
  exclude: string[];
  concurrency: number;
  requestsPerMinute: number;
  tokensPerSecond: number;
  top: number;
  repositoryId?: string;
  thresholds: Partial<Thresholds>;
}
export interface PreparedTarget {
  fingerprint: string;
  aspect: "test-honesty";
  location: Location;
  target: { path: string[]; name: string };
  contextMode: ContextMode;
  contextReason?: string;
  inputHash: string;
  subjectRevision: string;
  evidenceSources: EvidenceSource[];
  state: Json;
  questions: Questions;
  controls: { own: "available" | "not_available"; sibling: "available" | "not_available" };
  unjudgeableReason?: string;
}
export interface ScopeFile { file: string; status: "parsed" | "skipped" | "error"; hash?: string; reason?: string }
export interface Scope {
  repositoryId: string;
  id: string;
  paths: string[];
  include: string[];
  exclude: string[];
  languages: string[];
  selectionPolicy: string;
  enumerationComplete: boolean;
  files: ScopeFile[];
}
export interface Selection {
  scope: Scope;
  targets: PreparedTarget[];
  sourceHashes: Record<string, string>;
  errors: string[];
}
export interface Observation {
  fingerprint: string;
  answers?: Answers;
  model?: string;
  outcome?: "unevaluated" | "not_judged" | "unjudgeable";
  reason?: string;
}
export interface Usage { requests: number; inputTokens: number; cacheHits: number }
export interface ObserveResult { observations: Observation[]; usage: Usage }
export interface PlanItem { target: PreparedTarget; cachedAnswers: Answers; missingQuestions: Questions; estimatedTokens: number; blockedReason?: string }
export interface Plan { items: PlanItem[]; requests: number; cacheHits: number; unjudgeable: number }
export interface Label {
  fingerprint: string;
  propositionVersion: string;
  subjectRevision: string;
  evidenceSources: EvidenceSource[];
  validity: "valid" | "invalid" | "unknown";
  priority?: "high" | "medium" | "low";
  resolution?: "fix" | "accept" | "defer" | "dismiss";
  source: "human" | "agent" | "execution";
  note?: string;
}
export interface Judgement {
  outcome: Outcome;
  reason?: string;
  suspicion: number | null;
  signal: number | null;
  band: Band | null;
}
export interface RunTarget extends Judgement {
  fingerprint: string;
  aspect: string;
  location: Location;
  target: { path: string[]; name: string };
  contextMode: ContextMode;
  contextReason?: string;
  inputHash: string;
  subjectRevision: string;
  controls: PreparedTarget["controls"];
}
export interface CalibrationRow { valid: number; invalid: number; high: number; prioritized: number; pValid: number | null; pHigh: number | null }
export interface ModeCalibration {
  source: "local" | "corpus" | "none";
  labelsBySource: Record<Label["source"], number>;
  table: Record<Band, CalibrationRow>;
}
export interface Comparison {
  baselineRun: string | null;
  new: number | null;
  resolved: number | null;
  pending: number;
  reason?: string;
  scoreDelta: null;
  noiseFloor: null;
}
export interface Finding {
  fingerprint: string;
  aspect: string;
  status: "new" | "persisting" | "uncompared";
  rank: number;
  evidence: { inputHash: string; answers: Answers; suspicion: number; signal: number; band: Band; pValid: number | null; pHigh: number | null };
  labelTemplate: Pick<Label, "fingerprint" | "propositionVersion" | "subjectRevision" | "evidenceSources">;
  label: Omit<Label, "note"> | null;
}
export interface RunAspect {
  id: string;
  condition: string;
  definition: AspectDefinition;
  calibration: { validation: "provisional"; byContextMode: Record<ContextMode, ModeCalibration> };
  evaluated: number;
  cannotTell: number;
  notJudged: number;
  unjudgeable: number;
  unevaluated: number;
  bandsByContextMode: Record<ContextMode, Record<Band, number>>;
  open: number;
  score: number | null;
  inTotal: boolean;
  comparison: Comparison;
}
export interface Run {
  schema: 1;
  tool: string;
  run: { id: string; at: string; commit: string | null; dirty: boolean; complete: boolean };
  scope: Scope;
  aspects: RunAspect[];
  targets: RunTarget[];
  findings: Finding[];
  snapshots: Record<string, { state: Json; questions: Questions }>;
  topFindings: Record<string, string[]>;
  resolved: { fingerprint: string; baselineRun: string; reason: "value_dropped" | "target_gone" }[];
  pendingComparisons: { fingerprint: string; baselineRun: string; reason: string }[];
  total: { score: number | null; aspects: number; weights: Record<string, number> };
  unmeasured: { skippedFiles: number; missRate: null; populationPrecisionAtN: null };
  usage: Usage;
}
export interface DeriveInput {
  selection: Selection;
  definition: AspectDefinition;
  observations: Observation[];
  usage: Usage;
  labels: Label[];
  history: Run[];
  metadata: Run["run"];
  top: number;
}
