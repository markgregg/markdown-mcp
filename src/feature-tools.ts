import fs from "fs";
import path from "path";
import type { ComponentDefinition, ComponentProp } from "./types.js";

export type OutputFormat = "jsx" | "html" | "json_schema" | "react_props_object";

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
  component: string;
  filePath: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function suggestPropValue(prop: ComponentProp): string | number | boolean | null {
  const t = prop.type.toLowerCase();
  if (t.includes("string")) {
    if (/email/i.test(prop.name)) return "user@example.com";
    if (/label|title|text|name/i.test(prop.name)) return "Sample";
    return "value";
  }
  if (t.includes("number") || t.includes("int") || t.includes("float")) return 0;
  if (t.includes("boolean") || t.includes("bool")) return false;
  if (t.includes("array") || t.includes("[]")) return [] as unknown as null;
  if (t.includes("function") || t.includes("callback") || /on[A-Z]/.test(prop.name)) return "() => {}";
  if (t.includes("object")) return "{}";
  return null;
}

export function buildPropsObject(component: ComponentDefinition): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const prop of component.props) {
    props[prop.name] = suggestPropValue(prop);
  }
  return props;
}

export function renderComponentByFormat(
  component: ComponentDefinition,
  format: OutputFormat,
  providedProps?: Record<string, unknown>
): unknown {
  const props = {
    ...buildPropsObject(component),
    ...(providedProps ?? {}),
  };

  if (format === "react_props_object") {
    return props;
  }

  if (format === "json_schema") {
    return {
      title: component.name,
      type: "object",
      properties: Object.fromEntries(
        component.props.map((prop) => [
          prop.name,
          {
            type: mapTypeToJsonType(prop.type),
            description: prop.description,
          },
        ])
      ),
      required: component.props.map((p) => p.name),
    };
  }

  if (format === "html") {
    const attrs = Object.entries(props)
      .map(([k, v]) => `${k}="${escapeHtml(String(v ?? ""))}"`)
      .join(" ");
    return `<div data-component="${escapeHtml(component.name)}" ${attrs}></div>`;
  }

  const jsxProps = Object.entries(props)
    .map(([k, v]) => `${k}={${toJsxLiteral(v)}}`)
    .join(" ");
  return `<${component.name}${jsxProps ? ` ${jsxProps}` : ""} />`;
}

export function composeUiLayout(
  components: ComponentDefinition[],
  template: "dashboard" | "form" | "list" | "hero",
  format: "jsx" | "html"
): string {
  const selected = components.slice(0, 6);
  if (selected.length === 0) return "";

  if (format === "html") {
    const items = selected
      .map((c) => `<section class="slot"><div data-component="${escapeHtml(c.name)}"></div></section>`)
      .join("\n");
    return wrapTemplateHtml(template, items);
  }

  const items = selected
    .map((c) => `<${c.name} ${renderAsJsxProps(buildPropsObject(c))} />`)
    .join("\n");
  return wrapTemplateJsx(template, items);
}

export function generatePropVariations(component: ComponentDefinition, count: number): Record<string, unknown>[] {
  const max = Math.max(1, Math.min(20, Math.floor(count)));
  const base = buildPropsObject(component);
  const variations: Record<string, unknown>[] = [];

  for (let i = 0; i < max; i += 1) {
    const next: Record<string, unknown> = { ...base };
    for (const prop of component.props) {
      const key = prop.name;
      const t = prop.type.toLowerCase();

      if (t.includes("string")) next[key] = `${String(base[key] ?? "value")}-${i + 1}`;
      else if (t.includes("number")) next[key] = i;
      else if (t.includes("boolean")) next[key] = i % 2 === 0;
    }
    variations.push(next);
  }

  return variations;
}

export function generatePreviewHtml(component: ComponentDefinition): string {
  const title = escapeHtml(component.name);
  const desc = escapeHtml(component.description || "No description");
  const tags = component.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
  const props = component.props
    .map((p) => `<li><code>${escapeHtml(p.name)}</code>: ${escapeHtml(p.type)} - ${escapeHtml(p.description)}</li>`)
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title} preview</title>
<style>
body { font-family: Segoe UI, sans-serif; margin: 24px; background: #f5f7fb; color: #10213a; }
.card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
.tags { margin: 8px 0; }
.tag { display: inline-block; background: #e7eefc; color: #24438f; border-radius: 10px; padding: 2px 8px; margin-right: 6px; font-size: 12px; }
pre { background: #111827; color: #e5e7eb; padding: 12px; border-radius: 8px; overflow: auto; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${desc}</p>
    <div class="tags">${tags}</div>
    <h3>Props</h3>
    <ul>${props}</ul>
    <h3>Example</h3>
    <pre>${escapeHtml(component.example ?? "No example")}</pre>
  </div>
</body>
</html>`;
}

export function validateComponent(component: ComponentDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!component.name.trim()) {
    issues.push(issue("error", component, "Missing component title"));
  }
  if (!component.description.trim()) {
    issues.push(issue("warning", component, "Missing description"));
  }
  if (component.props.length === 0) {
    issues.push(issue("warning", component, "Missing props definitions"));
  }
  for (const prop of component.props) {
    if (!prop.name.trim()) issues.push(issue("error", component, "Prop name is empty"));
    if (!prop.type.trim()) issues.push(issue("warning", component, `Prop '${prop.name}' missing type`));
  }

  if (!component.example) {
    issues.push(issue("warning", component, "Missing example section"));
  } else if (!/^```[\w-]*\n[\s\S]*\n```$/.test(component.example.trim())) {
    issues.push(issue("warning", component, "Example should be a fenced code block"));
  }

  if (!component.version) issues.push(issue("warning", component, "Missing version metadata"));
  if (!component.author) issues.push(issue("warning", component, "Missing author metadata"));

  return {
    valid: !issues.some((x) => x.level === "error"),
    issues,
  };
}

export function lintMarkdownText(markdown: string): string[] {
  const warnings: string[] = [];
  if (!/^#\s+/m.test(markdown)) warnings.push("Missing top-level heading (# ComponentName)");
  if (!/^##\s+Description/m.test(markdown)) warnings.push("Missing Description section");
  if (!/^##\s+Props/m.test(markdown)) warnings.push("Missing Props section");
  if (!/^##\s+Category/m.test(markdown)) warnings.push("Missing Category section");
  if (!/^##\s+Example/m.test(markdown)) warnings.push("Missing Example section");
  return warnings;
}

export function generateComponentMarkdown(input: {
  name: string;
  description: string;
  category: string;
  props: Array<{ name: string; type: string; description?: string }>;
  tags?: string[];
  version?: string;
  author?: string;
  example?: string;
}): string {
  const tagBlock = (input.tags ?? []).length > 0
    ? `tags:\n${(input.tags ?? []).map((t) => `  - ${t}`).join("\n")}`
    : "tags: []";

  const frontmatter = [
    "---",
    tagBlock,
    `version: ${input.version ?? "1.0.0"}`,
    `author: ${input.author ?? "unknown"}`,
    "deprecated: false",
    "---",
  ].join("\n");

  const propLines = input.props
    .map((p) => `- ${p.name}: ${p.type} — ${p.description ?? ""}`.trim())
    .join("\n");

  const example = input.example ?? `<${input.name} />`;

  return [
    frontmatter,
    "",
    `# ${input.name}`,
    "",
    "## Description",
    input.description,
    "",
    "## Props",
    propLines,
    "",
    "## Category",
    input.category,
    "",
    "## Tags",
    (input.tags ?? []).join(", "),
    "",
    "## Version",
    input.version ?? "1.0.0",
    "",
    "## Author",
    input.author ?? "unknown",
    "",
    "## Example",
    "```jsx",
    example,
    "```",
    "",
  ].join("\n");
}

export function ensureMarkdownFile(folder: string, componentName: string, content: string): string {
  const safeName = componentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const fullPath = path.join(folder, `${safeName}.md`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function issue(level: "error" | "warning", component: ComponentDefinition, message: string): ValidationIssue {
  return {
    level,
    message,
    component: component.name,
    filePath: component.filePath,
  };
}

function renderAsJsxProps(props: Record<string, unknown>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}={${toJsxLiteral(v)}}`)
    .join(" ");
}

function toJsxLiteral(v: unknown): string {
  if (typeof v === "string") {
    if (v === "() => {}" || v === "{}") return v;
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

function mapTypeToJsonType(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("string")) return "string";
  if (t.includes("number") || t.includes("int") || t.includes("float")) return "number";
  if (t.includes("boolean") || t.includes("bool")) return "boolean";
  if (t.includes("array") || t.includes("[]")) return "array";
  if (t.includes("object")) return "object";
  return "string";
}

function wrapTemplateHtml(template: string, content: string): string {
  const klass = `layout-${template}`;
  return `<main class="${klass}">\n${content}\n</main>`;
}

function wrapTemplateJsx(template: string, content: string): string {
  const klass = `layout-${template}`;
  return `<main className="${klass}">\n${content}\n</main>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
