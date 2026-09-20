import { mkdir, readFile, readdir, rename, writeFile, unlink, link } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Label, Run } from "../types.js";

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const relativePath = (value: unknown): value is string => nonempty(value) && !isAbsolute(value) && !value.includes("\\") && !value.split("/").includes("..");
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const probability = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);

function validCalibrationRow(value: Record<string, unknown>): boolean {
  const { valid, invalid, prioritized, high, pValid, pHigh } = value;
  if (!count(valid) || !count(invalid) || !count(prioritized) || !count(high)
    || !probability(pValid) || !probability(pHigh)
    || high > prioritized || prioritized > valid) return false;
  const validityCount = valid + invalid;
  if (!Number.isSafeInteger(validityCount)) return false;
  const expectedPValid = validityCount === 0 ? null : valid / validityCount;
  const expectedPHigh = prioritized === 0 ? null : high / prioritized;
  return pValid === expectedPValid && pHigh === expectedPHigh;
}

export async function readLabels(filename: string, optional = true): Promise<Label[]> {
  let text: string;
  try { text = await readFile(filename, "utf8"); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read labels");
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const row: unknown = JSON.parse(line);
      if (!object(row) || !nonempty(row.fingerprint) || !nonempty(row.propositionVersion) || !nonempty(row.subjectRevision)
        || !["valid", "invalid", "unknown"].includes(String(row.validity))
        || !["human", "agent", "execution"].includes(String(row.source))
        || (row.priority !== undefined && !["high", "medium", "low"].includes(String(row.priority)))
        || (row.resolution !== undefined && !["fix", "accept", "defer", "dismiss"].includes(String(row.resolution)))
        || !Array.isArray(row.evidenceSources) || row.evidenceSources.length === 0
        || row.evidenceSources.some(x => !object(x) || !relativePath(x.file) || !nonempty(x.hash))) throw new Error("Invalid label");
      return [row as unknown as Label];
    } catch { throw new Error(`Invalid label at line ${index + 1}; expected a revision-bound label with provenance`); }
  });
}

export function validateRun(value: unknown): asserts value is Run {
  if (!object(value) || value.schema !== 1 || !object(value.run) || !nonempty(value.run.id)
    || !nonempty(value.run.at) || !Number.isFinite(Date.parse(value.run.at)) || typeof value.run.complete !== "boolean"
    || !object(value.scope) || !nonempty(value.scope.id) || !nonempty(value.scope.repositoryId)
    || !Array.isArray(value.scope.files) || typeof value.scope.enumerationComplete !== "boolean"
    || !Array.isArray(value.aspects) || !Array.isArray(value.targets) || !Array.isArray(value.findings)
    || !object(value.snapshots) || !object(value.topFindings) || !Array.isArray(value.resolved)
    || !Array.isArray(value.pendingComparisons) || !object(value.total) || !object(value.usage) || !object(value.unmeasured)) throw new Error("Unsupported or invalid run.json");
  for (const aspect of value.aspects) {
    if (!object(aspect) || !nonempty(aspect.id) || !nonempty(aspect.condition) || !object(aspect.definition)
      || !object(aspect.calibration) || !object(aspect.calibration.byContextMode) || !object(aspect.bandsByContextMode) || !object(aspect.comparison)
      || !Number.isSafeInteger(aspect.evaluated) || Number(aspect.evaluated) < 0) throw new Error("Invalid aspect in run.json");
    for (const mode of ["focus", "focusprod"]) {
      const cal = aspect.calibration.byContextMode[mode];
      if (!object(cal) || !object(cal.table) || !object(cal.labelsBySource) || !object(aspect.bandsByContextMode[mode])) throw new Error("Invalid calibration in run.json");
      for (const band of ["0..0.05", "0.05..0.15", "0.15..0.30", ">=0.30"]) {
        const row = cal.table[band];
        if (!object(row) || !validCalibrationRow(row)
          || !count((aspect.bandsByContextMode[mode] as Record<string, unknown>)[band])) throw new Error("Invalid calibration band in run.json");
      }
    }
  }
  for (const target of value.targets) {
    if (!object(target) || !nonempty(target.fingerprint) || !object(target.location) || !relativePath(target.location.file)
      || !count(target.location.startLine) || target.location.startLine < 1 || !count(target.location.endLine) || target.location.endLine < target.location.startLine
      || !object(target.target) || typeof target.target.name !== "string" || !["focus", "focusprod"].includes(String(target.contextMode))
      || !["finding", "clean", "cannot_tell", "not_judged", "unjudgeable", "unevaluated"].includes(String(target.outcome))) throw new Error("Invalid target in run.json");
  }
  for (const finding of value.findings) {
    if (!object(finding) || !nonempty(finding.fingerprint) || !object(finding.evidence) || !object(finding.evidence.answers)
      || !nonempty(finding.evidence.inputHash) || !object(finding.labelTemplate)
      || !probability(finding.evidence.pValid) || !probability(finding.evidence.pHigh)
      || typeof finding.evidence.suspicion !== "number" || !Number.isFinite(finding.evidence.suspicion)) throw new Error("Invalid finding in run.json");
  }
}

export async function readRun(filename: string): Promise<Run> {
  let value: unknown;
  try { value = JSON.parse(await readFile(filename, "utf8")); }
  catch { throw new Error("Could not read a valid run.json"); }
  validateRun(value);
  return value;
}

export async function readHistory(directory?: string): Promise<Run[]> {
  if (!directory) return [];
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read history directory");
  }
  return Promise.all(names.filter(n => n.endsWith(".json")).sort().map(n => readRun(resolve(directory, n))));
}

export async function writeRun(filename: string, run: Run, immutable = false): Promise<void> {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = resolve(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (immutable) await link(temporary, filename);
    else await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => undefined); }
}
