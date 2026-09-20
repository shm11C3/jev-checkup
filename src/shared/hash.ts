import { createHash } from "node:crypto";
import type { EvidenceSource } from "../types.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("Cannot hash an undefined value");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hash(value: unknown): string { return hashText(canonical(value)); }

export function subjectRevision(propositionVersion: string, sources: EvidenceSource[]): string {
  return hash({ propositionVersion, evidenceSources: [...sources].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0) });
}
