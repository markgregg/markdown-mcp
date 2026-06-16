import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface MarkdownSource {
  sourceRef: string;
  content: string;
  fingerprint: string;
}

export function getMarkdownFilesFromFolders(folders: string[]): string[] {
  const files: string[] = [];

  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    const entries = fs.readdirSync(folder, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        files.push(...getMarkdownFilesFromFolders([full]));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }

  return files;
}

export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function loadMarkdownSourcesFromListFile(listFilePath: string): Promise<MarkdownSource[]> {
  const raw = readFileSafe(listFilePath);
  if (!raw) return [];

  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const sources: MarkdownSource[] = [];

  for (const entry of entries) {
    if (isHttpUrl(entry)) {
      const remote = await readRemoteMarkdown(entry);
      if (remote) sources.push(remote);
      continue;
    }

    const resolved = resolvePathEntry(entry, listFilePath);
    if (!resolved) continue;

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const files = getMarkdownFilesFromFolders([resolved]);
      for (const file of files) {
        const content = readFileSafe(file);
        if (!content) continue;
        sources.push({
          sourceRef: file,
          content,
          fingerprint: hashContent(content),
        });
      }
      continue;
    }

    const content = readFileSafe(resolved);
    if (!content) continue;
    sources.push({
      sourceRef: resolved,
      content,
      fingerprint: hashContent(content),
    });
  }

  return sources;
}

function resolvePathEntry(entry: string, listFilePath: string): string | null {
  if (entry.startsWith("file://")) {
    try {
      return new URL(entry).pathname;
    } catch {
      return null;
    }
  }

  if (path.isAbsolute(entry)) return entry;
  return path.resolve(path.dirname(listFilePath), entry);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function readRemoteMarkdown(url: string): Promise<MarkdownSource | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const content = await res.text();
    return {
      sourceRef: url,
      content,
      fingerprint: hashContent(content),
    };
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
