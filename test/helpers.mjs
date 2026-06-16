import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const FIXTURE_DIR = path.join(ROOT_DIR, "test", "fixtures", "components");
export const TMP_DIR = path.join(ROOT_DIR, "test", "tmp");

export function ensureTmpDir(name) {
  const dir = path.join(TMP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function parseToolTextResult(result) {
  assert.ok(result, "Expected MCP call result");
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text content in MCP result");
  return JSON.parse(text);
}

export function cleanDir(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  fs.rmSync(targetDir, { recursive: true, force: true });
}
