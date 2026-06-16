import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { Database as SQLiteDatabase } from "better-sqlite3";
import * as sqliteVss from "sqlite-vss";
import type { ComponentDefinition } from "./types.js";
import {
  cosineSimilarity,
  componentToEmbeddingText,
  generateTextEmbedding,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from "./embeddings.js";

interface StoredComponentRow {
  id: number;
  name: string;
  category: string;
  file_path: string;
  embedding_json: string;
}

export interface SemanticResult {
  name: string;
  category: string;
  filePath: string;
  score: number;
}

export interface EmbeddingStoreStatus {
  dbPath: string;
  dimensions: number;
  vssEnabled: boolean;
  vssError: string | null;
  indexedCount: number;
}

export class EmbeddingStore {
  private readonly db: SQLiteDatabase;
  private readonly dbPath: string;
  private readonly dimensions: number;
  private vssEnabled = false;
  private vssError: string | null = null;

  constructor(dbPath: string, dimensions?: number) {
    this.dbPath = dbPath;
    this.dimensions = sanitizeDimensions(dimensions);
    ensureParentDirExists(dbPath);

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.initSchema();
    this.tryEnableVss();
  }

  syncComponents(components: ComponentDefinition[]): void {
    const tx = this.db.transaction((all: ComponentDefinition[]) => {
      const incoming = new Set(all.map((component) => component.name.toLowerCase()));

      const existing = this.db
        .prepare("SELECT id, name FROM components")
        .all() as Array<{ id: number; name: string }>;

      for (const row of existing) {
        if (!incoming.has(row.name.toLowerCase())) {
          if (this.vssEnabled) {
            this.db
              .prepare("DELETE FROM vss_component_embeddings WHERE rowid = ?")
              .run(row.id);
          }
          this.db.prepare("DELETE FROM components WHERE id = ?").run(row.id);
        }
      }

      const upsert = this.db.prepare(`
        INSERT INTO components (name, category, file_path, content_hash, embedding_json, updated_at)
        VALUES (@name, @category, @filePath, @hash, @embeddingJson, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
          category = excluded.category,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          embedding_json = excluded.embedding_json,
          updated_at = CURRENT_TIMESTAMP
      `);

      const selectId = this.db.prepare("SELECT id FROM components WHERE name = ?");

      for (const component of all) {
        const text = componentToEmbeddingText(component);
        const hash = sha256(text);
        const embedding = generateTextEmbedding(text, this.dimensions);
        const embeddingJson = JSON.stringify(embedding);

        upsert.run({
          name: component.name,
          category: component.category,
          filePath: component.filePath,
          hash,
          embeddingJson,
        });

        if (!this.vssEnabled) continue;

        const row = selectId.get(component.name) as { id: number } | undefined;
        if (!row) continue;

        this.db
          .prepare("DELETE FROM vss_component_embeddings WHERE rowid = ?")
          .run(row.id);

        this.db
          .prepare("INSERT INTO vss_component_embeddings(rowid, embedding) VALUES (?, ?)")
          .run(row.id, embeddingJson);
      }
    });

    tx(components);
  }

  semanticSearch(query: string, limit = 10): SemanticResult[] {
    const capped = sanitizeLimit(limit);
    const queryEmbedding = generateTextEmbedding(query, this.dimensions);

    if (this.vssEnabled) {
      const rows = this.db.prepare(`
        SELECT c.name, c.category, c.file_path, v.distance
        FROM vss_component_embeddings v
        JOIN components c ON c.id = v.rowid
        WHERE vss_search(v.embedding, vss_search_params(?, ?))
        LIMIT ?
      `).all(JSON.stringify(queryEmbedding), capped, capped) as Array<{
        name: string;
        category: string;
        file_path: string;
        distance: number;
      }>;

      return rows.map((row) => ({
        name: row.name,
        category: row.category,
        filePath: row.file_path,
        score: distanceToScore(row.distance),
      }));
    }

    return this.fallbackSearch(queryEmbedding, capped);
  }

  similarComponents(name: string, limit = 10): SemanticResult[] {
    const source = this.db.prepare(
      "SELECT id, embedding_json FROM components WHERE lower(name) = lower(?)"
    ).get(name) as { id: number; embedding_json: string } | undefined;

    if (!source) return [];

    const capped = sanitizeLimit(limit);

    if (this.vssEnabled) {
      const rows = this.db.prepare(`
        SELECT c.name, c.category, c.file_path, v.distance
        FROM vss_component_embeddings v
        JOIN components c ON c.id = v.rowid
        WHERE vss_search(v.embedding, vss_search_params(?, ?))
          AND c.id != ?
        LIMIT ?
      `).all(source.embedding_json, capped + 1, source.id, capped + 1) as Array<{
        name: string;
        category: string;
        file_path: string;
        distance: number;
      }>;

      return rows
        .slice(0, capped)
        .map((row) => ({
          name: row.name,
          category: row.category,
          filePath: row.file_path,
          score: distanceToScore(row.distance),
        }));
    }

    const sourceEmbedding = parseEmbedding(source.embedding_json);
    if (!sourceEmbedding) return [];

    return this.fallbackSearch(sourceEmbedding, capped, source.id);
  }

  getStatus(): EmbeddingStoreStatus {
    const indexed = this.db.prepare("SELECT COUNT(*) AS count FROM components").get() as { count: number };
    return {
      dbPath: this.dbPath,
      dimensions: this.dimensions,
      vssEnabled: this.vssEnabled,
      vssError: this.vssError,
      indexedCount: indexed.count,
    };
  }

  private fallbackSearch(queryEmbedding: number[], limit: number, excludeId?: number): SemanticResult[] {
    const rows = this.db.prepare(
      "SELECT id, name, category, file_path, embedding_json FROM components"
    ).all() as StoredComponentRow[];

    return rows
      .filter((row) => excludeId == null || row.id !== excludeId)
      .map((row) => {
        const embedding = parseEmbedding(row.embedding_json);
        const score = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
        return {
          name: row.name,
          category: row.category,
          filePath: row.file_path,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_components_category ON components(category);
    `);
  }

  private tryEnableVss(): void {
    try {
      sqliteVss.load(this.db);
    } catch {
      try {
        const getLoadablePath = (sqliteVss as unknown as { getLoadablePath: () => string }).getLoadablePath;
        this.db.loadExtension(getLoadablePath());
      } catch (error) {
        this.vssEnabled = false;
        this.vssError = error instanceof Error ? error.message : String(error);
        return;
      }
    }

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vss_component_embeddings
        USING vss0(embedding(${this.dimensions}));
      `);
      this.vssEnabled = true;
      this.vssError = null;
    } catch (error) {
      this.vssEnabled = false;
      this.vssError = error instanceof Error ? error.message : String(error);
    }
  }
}

function ensureParentDirExists(filePath: string): void {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function sanitizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(50, Math.floor(limit)));
}

function sanitizeDimensions(dimensions?: number): number {
  if (!Number.isFinite(dimensions) || dimensions == null || dimensions <= 0) {
    return DEFAULT_EMBEDDING_DIMENSIONS;
  }
  return Math.max(8, Math.min(2048, Math.floor(dimensions)));
}

function parseEmbedding(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((n) => typeof n === "number")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function distanceToScore(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return 1 / (1 + Math.max(0, distance));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
