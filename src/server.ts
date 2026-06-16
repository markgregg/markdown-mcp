import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import vm from "vm";
import { z } from "zod";
import {
  getMarkdownFilesFromFolders,
  loadMarkdownSourcesFromListFile,
  readFileSafe,
} from "./markdown-loader.js";
import { parseComponentMarkdown } from "./component-parser.js";
import type { ComponentDefinition } from "./types.js";
import { EmbeddingStore } from "./embedding-store.js";
import {
  composeUiLayout,
  ensureMarkdownFile,
  generateComponentMarkdown,
  generatePreviewHtml,
  generatePropVariations,
  lintMarkdownText,
  renderComponentByFormat,
  validateComponent,
  type OutputFormat,
} from "./feature-tools.js";

const server = new McpServer({
  name: "markdown-component-mcp-server",
  version: "1.0.0",
});

const COMPONENT_FOLDERS_ENV = "COMPONENT_MD_FOLDERS";
const COMPONENT_SOURCES_LIST_ENV = "COMPONENT_MD_SOURCES_LIST_FILE";
const EMBEDDING_DB_PATH_ENV = "COMPONENT_EMBEDDINGS_DB_PATH";
const EMBEDDING_DIMENSIONS_ENV = "COMPONENT_EMBEDDING_DIMENSIONS";
const COMPONENT_INDEX_PATH_ENV = "COMPONENT_INDEX_PATH";
const ENABLE_FILE_WATCH_ENV = "ENABLE_COMPONENT_FILE_WATCH";
const MCP_AUTH_TOKEN_ENV = "MCP_AUTH_TOKEN";
const MCP_ENV_PROFILE_ENV = "MCP_ENV_PROFILE";

const envProfile = process.env[MCP_ENV_PROFILE_ENV] || "development";
const authToken = process.env[MCP_AUTH_TOKEN_ENV] || "";
const enableFileWatch = (process.env[ENABLE_FILE_WATCH_ENV] || "true").toLowerCase() !== "false";
const componentIndexPath = process.env[COMPONENT_INDEX_PATH_ENV] || ".mcp/component-index.json";

const embeddingStore = new EmbeddingStore(
  process.env[EMBEDDING_DB_PATH_ENV] || ".mcp/components.sqlite",
  Number(process.env[EMBEDDING_DIMENSIONS_ENV] || 64)
);

let cacheSignature = "";
let cacheUpdatedAt: string | null = null;
let cachedComponents: ComponentDefinition[] = [];
let cacheHits = 0;
let cacheMisses = 0;
let watchInitialized = false;
let watchReloadFlag = false;
let parseErrorCount = 0;

const activeWatchers = new Map<string, fs.FSWatcher>();

// In-memory cache with file-signature invalidation and optional watch-based refresh
async function loadComponents(): Promise<ComponentDefinition[]> {
  const folders = getComponentFolders();
  const sourceListFilePath = getSourcesListFilePath();

  if (folders.length === 0 && !sourceListFilePath) {
    cacheSignature = "";
    cachedComponents = [];
    return [];
  }

  if (enableFileWatch && !watchInitialized) {
    initializeFileWatchers(folders);
  }

  const files = getMarkdownFilesFromFolders(folders);
  const folderSignature = createFileSignature(files);

  if (!watchReloadFlag && !sourceListFilePath && folderSignature === cacheSignature && cachedComponents.length > 0) {
    cacheHits += 1;
    return cachedComponents;
  }

  cacheMisses += 1;
  const components: ComponentDefinition[] = [];
  parseErrorCount = 0;
  const signatureParts: string[] = [folderSignature];

  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;

    let parsed: ComponentDefinition | null = null;
    try {
      parsed = await parseComponentMarkdown(content, file);
    } catch {
      parseErrorCount += 1;
      parsed = null;
    }

    if (parsed) components.push(parsed);
  }

  if (sourceListFilePath) {
    const sourceItems = await loadMarkdownSourcesFromListFile(sourceListFilePath);
    signatureParts.push(
      ...sourceItems.map((s) => `${s.sourceRef}:${s.fingerprint}`)
    );

    for (const source of sourceItems) {
      let parsed: ComponentDefinition | null = null;
      try {
        parsed = await parseComponentMarkdown(source.content, source.sourceRef);
      } catch {
        parseErrorCount += 1;
        parsed = null;
      }

      if (parsed) components.push(parsed);
    }
  }

  const uniqueByName = new Map<string, ComponentDefinition>();
  for (const component of components) {
    uniqueByName.set(component.name.toLowerCase(), component);
  }
  const dedupedComponents = [...uniqueByName.values()];

  embeddingStore.syncComponents(dedupedComponents);
  persistComponentIndex(dedupedComponents, files.length);

  cachedComponents = dedupedComponents;
  cacheSignature = signatureParts.join("|");
  cacheUpdatedAt = new Date().toISOString();
  watchReloadFlag = false;

  return dedupedComponents;
}

// list_components
server.registerTool("list_components", {}, async () => {
  const components = await loadComponents();
  return jsonResult({
    components: components.map(c => ({
      name: c.name,
      category: c.category,
      filePath: c.filePath,
    })),
  });
});

// get_component
server.registerTool(
  "get_component",
  {
    inputSchema: z.object({
      name: z.string(),
    }),
  },
  async ({ name }) => {
    const components = await loadComponents();
    const match = components.find(
      c => c.name.toLowerCase() === name.toLowerCase()
    );

    if (!match) {
      return jsonResult({
        error: `Component '${name}' not found`,
      });
    }

    return jsonResult({
      component: match,
    });
  }
);

// search_components
server.registerTool(
  "search_components",
  {
    inputSchema: z.object({
      query: z.string(),
    }),
  },
  async ({ query }) => {
    const q = query.toLowerCase();
    const components = await loadComponents();

    const scored = components
      .map(c => {
        const haystack = [
          c.name,
          c.description,
          c.category,
          ...c.props.map(p => `${p.name} ${p.type} ${p.description}`),
        ]
          .join(" ")
          .toLowerCase();

        const score = simpleScore(haystack, q);
        return { component: c, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return jsonResult({
      results: scored.map(s => ({
        name: s.component.name,
        category: s.component.category,
        score: s.score,
        filePath: s.component.filePath,
      })),
    });
  }
);

// list_categories
server.registerTool("list_categories", {}, async () => {
  const components = await loadComponents();
  const map: Record<string, string[]> = {};

  for (const c of components) {
    if (!map[c.category]) map[c.category] = [];
    map[c.category].push(c.name);
  }

  return jsonResult({
    categories: Object.entries(map).map(([category, names]) => ({
      category,
      components: names,
    })),
  });
});

// semantic_search_components
server.registerTool(
  "semantic_search_components",
  {
    inputSchema: z.object({
      query: z.string(),
      tags: z.array(z.string()).optional(),
    }),
  },
  async ({ query, tags }) => {
    const components = await loadComponents();
    const status = embeddingStore.getStatus();
    const results = embeddingStore.semanticSearch(query, 20);
    const byName = new Map(components.map((c) => [c.name.toLowerCase(), c]));

    const filtered = (tags && tags.length > 0)
      ? results.filter((result) => {
        const source = byName.get(result.name.toLowerCase());
        if (!source) return false;
        const set = new Set(source.tags.map((t) => t.toLowerCase()));
        return tags.every((tag) => set.has(tag.toLowerCase()));
      })
      : results;

    return jsonResult({
      results: filtered.slice(0, 10),
      backend: {
        type: status.vssEnabled ? "sqlite-vss" : "sqlite-fallback",
        dimensions: status.dimensions,
        dbPath: status.dbPath,
        warning: status.vssEnabled ? null : status.vssError,
      },
    });
  }
);

// similar_components
server.registerTool(
  "similar_components",
  {
    inputSchema: z.object({
      name: z.string(),
    }),
  },
  async ({ name }) => {
    await loadComponents();
    const status = embeddingStore.getStatus();
    const results = embeddingStore.similarComponents(name, 10);

    return jsonResult({
      results,
      backend: {
        type: status.vssEnabled ? "sqlite-vss" : "sqlite-fallback",
        dimensions: status.dimensions,
        dbPath: status.dbPath,
        warning: status.vssEnabled ? null : status.vssError,
      },
    });
  }
);

// validate_components
server.registerTool("validate_components", {}, async () => {
  const components = await loadComponents();
  const results = components.map((component) => ({
    component: component.name,
    filePath: component.filePath,
    validation: validateComponent(component),
    parserWarnings: component.warnings,
  }));

  const totals = {
    components: components.length,
    errors: results.reduce((sum, r) => sum + r.validation.issues.filter((x) => x.level === "error").length, 0),
    warnings: results.reduce((sum, r) => sum + r.validation.issues.filter((x) => x.level === "warning").length, 0),
  };

  return jsonResult({ totals, results });
});

// stats
server.registerTool("stats", {}, async () => {
  const components = await loadComponents();
  const embedding = embeddingStore.getStatus();

  const byCategory: Record<string, number> = {};
  for (const c of components) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  }

  return jsonResult({
    envProfile,
    authEnabled: Boolean(authToken),
    fileWatchEnabled: enableFileWatch,
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
      cachedCount: cachedComponents.length,
      updatedAt: cacheUpdatedAt,
    },
    parseErrors: parseErrorCount,
    components: {
      total: components.length,
      byCategory,
      deprecatedCount: components.filter((c) => c.deprecated).length,
      tagCount: new Set(components.flatMap((c) => c.tags)).size,
    },
    embeddings: embedding,
    indexPath: componentIndexPath,
  });
});

// compose_ui
server.registerTool(
  "compose_ui",
  {
    inputSchema: z.object({
      query: z.string().optional(),
      componentNames: z.array(z.string()).optional(),
      template: z.enum(["dashboard", "form", "list", "hero"]).default("dashboard"),
      format: z.enum(["jsx", "html"]).default("jsx"),
    }),
  },
  async ({ query, componentNames, template, format }) => {
    const components = await loadComponents();
    let selected: ComponentDefinition[] = [];

    if (componentNames && componentNames.length > 0) {
      const set = new Set(componentNames.map((n) => n.toLowerCase()));
      selected = components.filter((c) => set.has(c.name.toLowerCase()));
    } else if (query && query.trim()) {
      const names = new Set(embeddingStore.semanticSearch(query, 6).map((r) => r.name.toLowerCase()));
      selected = components.filter((c) => names.has(c.name.toLowerCase()));
    } else {
      selected = components.slice(0, 6);
    }

    const layout = composeUiLayout(selected, template, format);

    return jsonResult({
      template,
      format,
      selectedComponents: selected.map((c) => ({
        name: c.name,
        category: c.category,
        suggestedProps: Object.fromEntries(c.props.map((p) => [p.name, autoPropValue(p.type)])),
      })),
      layout,
    });
  }
);

// render_component
server.registerTool(
  "render_component",
  {
    inputSchema: z.object({
      name: z.string(),
      format: z.enum(["jsx", "html", "json_schema", "react_props_object"]).default("jsx"),
      props: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  async ({ name, format, props }) => {
    const components = await loadComponents();
    const component = components.find((c) => c.name.toLowerCase() === name.toLowerCase());

    if (!component) {
      return jsonResult({ error: `Component '${name}' not found` });
    }

    const rendered = renderComponentByFormat(component, format as OutputFormat, props);
    return jsonResult({ name: component.name, format, output: rendered });
  }
);

// render_example_html
server.registerTool(
  "render_example_html",
  {
    inputSchema: z.object({
      name: z.string(),
      sandboxRun: z.boolean().default(false),
    }),
  },
  async ({ name, sandboxRun }) => {
    const components = await loadComponents();
    const component = components.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!component) return jsonResult({ error: `Component '${name}' not found` });

    const html = `<article><h1>${escapeHtml(component.name)}</h1><pre>${escapeHtml(component.example ?? "")}</pre></article>`;
    const sandbox = sandboxRun ? runExampleInSandbox(component.example ?? "") : { executed: false, output: null };

    return jsonResult({
      name: component.name,
      html,
      sandbox,
      note: "Sandbox execution is disabled by default and runs in a restricted VM context.",
    });
  }
);

// generate_prop_variations
server.registerTool(
  "generate_prop_variations",
  {
    inputSchema: z.object({
      name: z.string(),
      count: z.number().int().min(1).max(20).default(5),
    }),
  },
  async ({ name, count }) => {
    const components = await loadComponents();
    const component = components.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!component) return jsonResult({ error: `Component '${name}' not found` });

    return jsonResult({
      name: component.name,
      variations: generatePropVariations(component, count),
    });
  }
);

// generate_preview
server.registerTool(
  "generate_preview",
  {
    inputSchema: z.object({
      name: z.string(),
      writeToFile: z.boolean().default(false),
      outputPath: z.string().optional(),
      authToken: z.string().optional(),
    }),
  },
  async ({ name, writeToFile, outputPath, authToken: providedAuth }) => {
    const components = await loadComponents();
    const component = components.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!component) return jsonResult({ error: `Component '${name}' not found` });

    const html = generatePreviewHtml(component);
    let savedPath: string | null = null;

    if (writeToFile) {
      assertAuth(providedAuth);
      const fullPath = outputPath || `.mcp/previews/${sanitizeName(component.name)}.preview.html`;
      ensureParentDir(fullPath);
      fs.writeFileSync(fullPath, html, "utf8");
      savedPath = fullPath;
    }

    return jsonResult({ name: component.name, html, savedPath });
  }
);

// generate_component_markdown
server.registerTool(
  "generate_component_markdown",
  {
    inputSchema: z.object({
      name: z.string(),
      description: z.string(),
      category: z.string().default("other"),
      props: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string().optional(),
      })).default([]),
      tags: z.array(z.string()).optional(),
      version: z.string().optional(),
      author: z.string().optional(),
      example: z.string().optional(),
      writeToFile: z.boolean().default(false),
      outputFolder: z.string().optional(),
      authToken: z.string().optional(),
    }),
  },
  async (args) => {
    const markdown = generateComponentMarkdown(args);
    let filePath: string | null = null;

    if (args.writeToFile) {
      assertAuth(args.authToken);
      const folders = getComponentFolders();
      const target = args.outputFolder || folders[0] || "./components";
      filePath = ensureMarkdownFile(target, args.name, markdown);
      watchReloadFlag = true;
    }

    return jsonResult({ markdown, filePath });
  }
);

// lint_component_markdown
server.registerTool(
  "lint_component_markdown",
  {
    inputSchema: z.object({
      markdown: z.string().optional(),
      filePath: z.string().optional(),
    }),
  },
  async ({ markdown, filePath }) => {
    const source = markdown ?? (filePath ? (readFileSafe(filePath) || "") : "");
    if (!source) {
      return jsonResult({ error: "Provide markdown text or a valid filePath" });
    }

    const warnings = lintMarkdownText(source);
    return jsonResult({ warnings, valid: warnings.length === 0 });
  }
);

function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function simpleScore(text: string, query: string): number {
  let score = 0;
  const terms = query.split(/\s+/).filter(Boolean);
  for (const term of terms) {
    if (text.includes(term)) score += 1;
  }
  return score;
}

function createFileSignature(files: string[]): string {
  const parts = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${file}:missing`;
    }
  });
  return parts.sort().join("|");
}

function persistComponentIndex(components: ComponentDefinition[], fileCount: number): void {
  const data = {
    generatedAt: new Date().toISOString(),
    fileCount,
    componentCount: components.length,
    components: components.map((c) => ({
      name: c.name,
      category: c.category,
      filePath: c.filePath,
      tags: c.tags,
      version: c.version,
      author: c.author,
      deprecated: c.deprecated,
    })),
  };

  ensureParentDir(componentIndexPath);
  fs.writeFileSync(componentIndexPath, JSON.stringify(data, null, 2), "utf8");
}

function initializeFileWatchers(folders: string[]): void {
  for (const folder of folders) {
    if (activeWatchers.has(folder)) continue;
    if (!fs.existsSync(folder)) continue;

    const watcher = fs.watch(folder, { recursive: true }, () => {
      watchReloadFlag = true;
    });

    activeWatchers.set(folder, watcher);
  }

  watchInitialized = true;
}

function getComponentFolders(): string[] {
  return (process.env[COMPONENT_FOLDERS_ENV] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSourcesListFilePath(): string | null {
  const args = process.argv.slice(2);
  const argValue = readArgValue(args, "--component-sources-file")
    ?? readArgValue(args, "--components-list-file");

  const fromEnv = process.env[COMPONENT_SOURCES_LIST_ENV];
  const raw = argValue || fromEnv || "";
  const trimmed = raw.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function readArgValue(args: string[], key: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === key) {
      return args[i + 1] ?? null;
    }
    if (item.startsWith(`${key}=`)) {
      return item.slice(key.length + 1);
    }
  }
  return null;
}

function runExampleInSandbox(rawExample: string): { executed: boolean; output: string | null; error?: string } {
  const code = stripCodeFence(rawExample);
  if (!code) return { executed: false, output: null };

  const logs: string[] = [];
  const context = vm.createContext({
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    },
  });

  try {
    vm.runInContext(code, context, { timeout: 120, displayErrors: false });
    return { executed: true, output: logs.join("\n") || null };
  } catch (error) {
    return {
      executed: false,
      output: logs.join("\n") || null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stripCodeFence(raw: string): string {
  const match = raw.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (match) return match[1];
  return raw.trim();
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function ensureParentDir(filePath: string): void {
  const folder = path.dirname(filePath);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
}

function assertAuth(providedToken?: string): void {
  if (!authToken) return;
  if (providedToken === authToken) return;
  throw new Error("Unauthorized: missing or invalid auth token");
}

function autoPropValue(type: string): unknown {
  const t = type.toLowerCase();
  if (t.includes("string")) return "value";
  if (t.includes("number")) return 0;
  if (t.includes("boolean")) return false;
  if (t.includes("function")) return "() => {}";
  return null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Start MCP server over stdio
const transport = new StdioServerTransport();
await server.connect(transport);
