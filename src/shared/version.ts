import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
}

// The relative path is the same from src/shared/version.ts under tsx and from
// dist/shared/version.js after the TypeScript build.
const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as PackageMetadata;
if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json version is missing");
}

export const VERSION = packageMetadata.version;
