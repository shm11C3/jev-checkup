import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type { AspectId, Config, Thresholds } from "../types.js";

export const DEFAULT_CONFIG: Config = {
  model: "jev-1.13.0",
  include: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/.jev-checkup/**", "**/dist/**", "**/coverage/**"],
  concurrency: 4,
  requestsPerMinute: 600,
  tokensPerSecond: 200_000,
  top: 10,
  thresholds: {},
};

const thresholdNames: (keyof Thresholds)[] = ["strong", "unseen", "midLow", "midHigh", "confidence", "finding", "control"];
const keys = new Set([...Object.keys(DEFAULT_CONFIG), "repositoryId", "aspects"]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== "string" || x.length === 0)) throw new Error(`Configuration ${field} must be an array of nonempty strings`);
  return [...new Set(value as string[])];
}

export function parseConfig(value: unknown): Config {
  if (!object(value)) throw new Error("Configuration must be an object");
  if (Object.keys(value).some(k => !keys.has(k))) throw new Error("Configuration has an unsupported field; cost limits and API keys do not belong in configuration");
  const config: Config = structuredClone(DEFAULT_CONFIG);
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !/^jev-\d+\.\d+\.\d+$/.test(value.model)) throw new Error("Configuration model must be a pinned Jev version, for example jev-1.13.0");
    config.model = value.model;
  }
  if (value.include !== undefined) config.include = stringList(value.include, "include");
  if (value.exclude !== undefined) config.exclude = stringList(value.exclude, "exclude");
  for (const key of ["concurrency", "requestsPerMinute", "tokensPerSecond", "top"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) throw new Error(`Configuration ${key} must be a positive integer`);
    config[key] = candidate;
  }
  if (value.repositoryId !== undefined) {
    if (typeof value.repositoryId !== "string" || value.repositoryId.trim().length === 0) throw new Error("Configuration repositoryId must be a nonempty string");
    config.repositoryId = value.repositoryId;
  }
  if (value.aspects !== undefined) {
    const aspects = stringList(value.aspects, "aspects");
    if (aspects.length === 0 || aspects.some(aspect => !["test-honesty", "naming-honesty"].includes(aspect))) throw new Error("Configuration aspects must contain supported aspects: test-honesty or naming-honesty");
    config.aspects = aspects as AspectId[];
  }
  if (value.thresholds !== undefined) {
    if (!object(value.thresholds)) throw new Error("Configuration thresholds must be an object");
    for (const [key, candidate] of Object.entries(value.thresholds)) {
      if (!thresholdNames.includes(key as keyof Thresholds) || typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) throw new Error("Configuration thresholds must contain known threshold names with values from 0 to 1");
      config.thresholds[key as keyof Thresholds] = candidate;
    }
    if ((config.thresholds.midLow ?? 0.35) >= (config.thresholds.midHigh ?? 0.65)) throw new Error("Configuration midLow must be less than midHigh");
  }
  return config;
}

export async function loadConfig(root: string, filename?: string): Promise<Config> {
  const path = resolve(root, filename ?? ".jev-checkup.yml");
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (!filename && (error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error("Could not read the configuration file");
  }
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new Error("Invalid YAML");
    return parseConfig(document.toJS({ maxAliasCount: 20 }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Configuration")) throw error;
    throw new Error("Invalid configuration; expected declarative YAML matching the configuration schema");
  }
}
