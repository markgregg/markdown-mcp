import type { ComponentDefinition } from "./types.js";

export const DEFAULT_EMBEDDING_DIMENSIONS = 64;

export function componentToEmbeddingText(component: ComponentDefinition): string {
  const propsText = component.props
    .map((prop) => `${prop.name} ${prop.type} ${prop.description}`)
    .join(" ");

  return [
    component.name,
    component.description,
    component.category,
    propsText,
    component.example ?? "",
  ]
    .join("\n")
    .trim();
}

export function generateTextEmbedding(text: string, dimensions: number): number[] {
  const safeDimensions = Number.isFinite(dimensions) && dimensions > 0
    ? Math.floor(dimensions)
    : DEFAULT_EMBEDDING_DIMENSIONS;

  const vector = new Array<number>(safeDimensions).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const i = hashToIndex(token, safeDimensions);
    const sign = (hashToIndex(`sign:${token}`, 2) === 0) ? -1 : 1;
    vector[i] += sign;
  }

  return normalize(vector);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hashToIndex(value: string, size: number): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % size;
}

function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const n of vector) sum += n * n;
  if (sum === 0) return vector;

  const scale = 1 / Math.sqrt(sum);
  return vector.map((n) => n * scale);
}
