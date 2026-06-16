import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { ComponentDefinition, ComponentProp, ComponentCategory } from "./types.js";

interface SectionMap {
  [key: string]: string;
}

const DEFAULT_CATEGORY: ComponentCategory = "other";

export async function parseComponentMarkdown(
  markdown: string,
  filePath: string
): Promise<ComponentDefinition | null> {
  const { body, frontmatter } = splitFrontmatter(markdown);
  const tree = unified().use(remarkParse).parse(body);

  let title: string | null = null;
  const sections: SectionMap = {};

  // Collect headings and their content
  let currentSection: string | null = null;
  const linesBySection: Record<string, string[]> = {};

  visit(tree, (node: any) => {
    if (node.type === "heading") {
      const text = node.children
        .filter((c: any) => c.type === "text" || c.type === "inlineCode")
        .map((c: any) => c.value)
        .join(" ")
        .trim();

      if (node.depth === 1 && !title) {
        title = text;
      } else if (node.depth === 2) {
        currentSection = text.toLowerCase();
        const section = currentSection;
        if (section && !linesBySection[section]) {
          linesBySection[section] = [];
        }
      }
    } else if (currentSection && node.position) {
      const raw = body.slice(node.position.start.offset, node.position.end.offset);
      linesBySection[currentSection].push(raw);
    }
  });

  for (const key of Object.keys(linesBySection)) {
    sections[key] = linesBySection[key].join("\n").trim();
  }

  if (!title) {
    return null;
  }

  const description = (sections["description"] || "").trim();

  const props = parsePropsSection(sections["props"] || "");
  const category = parseCategorySection(sections["category"] || "");
  const example = parseExampleSection(sections["example"] || "");
  const tags = parseTagsSection(sections["tags"] || "", frontmatter.tags);
  const version = parseVersionSection(sections["version"] || "", frontmatter.version);
  const author = parseAuthorSection(sections["author"] || "", frontmatter.author);
  const deprecated = parseDeprecated(sections["deprecated"] || "", frontmatter.deprecated);
  const warnings = collectWarnings({ title, description, props, category, example, version, author, deprecated });

  return {
    name: title,
    description,
    props,
    category,
    example,
    filePath,
    tags,
    version,
    author,
    deprecated,
    warnings,
  };
}

function parsePropsSection(raw: string): ComponentProp[] {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const props: ComponentProp[] = [];

  for (const line of lines) {
    // - propName: type — description
    const cleaned = line.replace(/^[-*]\s*/, "");
    const [left, ...rest] = cleaned.split("—");
    const description = rest.join("—").trim();

    const [namePart, typePart] = left.split(":").map(s => s.trim());
    if (!namePart) continue;

    props.push({
      name: namePart,
      type: typePart || "any",
      description: description || "",
    });
  }

  return props;
}

function parseCategorySection(raw: string): ComponentCategory {
  const value = raw.split("\n")[0]?.trim().toLowerCase() as ComponentCategory | undefined;
  const allowed: ComponentCategory[] = [
    "form",
    "layout",
    "input",
    "display",
    "navigation",
    "other",
  ];
  if (value && allowed.includes(value)) return value;
  return DEFAULT_CATEGORY;
}

function parseExampleSection(raw: string): string | null {
  if (!raw.trim()) return null;

  // Try to extract fenced code block first
  const fenceMatch = raw.match(/```[\s\S]*?```/);
  if (fenceMatch) {
    return fenceMatch[0].trim();
  }

  return raw.trim();
}

function splitFrontmatter(markdown: string): { body: string; frontmatter: ParsedFrontmatter } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { body: markdown, frontmatter: {} };
  }

  const frontmatter = parseFrontmatter(match[1]);
  const body = markdown.slice(match[0].length);
  return { body, frontmatter };
}

interface ParsedFrontmatter {
  tags?: string[];
  version?: string;
  author?: string;
  deprecated?: boolean;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};
  let inTags = false;
  const tags: string[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^tags\s*:/i.test(line)) {
      inTags = true;
      const inline = line.split(":")[1]?.trim();
      if (inline) {
        inline.split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => tags.push(x));
      }
      continue;
    }

    if (inTags && /^-\s+/.test(line)) {
      tags.push(line.replace(/^-\s+/, "").trim());
      continue;
    }

    inTags = false;

    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    const normalized = key.trim().toLowerCase();

    if (normalized === "version") result.version = value;
    if (normalized === "author") result.author = value;
    if (normalized === "deprecated") result.deprecated = ["true", "yes", "1"].includes(value.toLowerCase());
  }

  if (tags.length > 0) result.tags = dedupeLower(tags);
  return result;
}

function parseTagsSection(raw: string, fallback?: string[]): string[] {
  const fromSection = raw
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .flatMap((line) => line.split(",").map((x) => x.trim()).filter(Boolean));

  return dedupeLower(fromSection.length > 0 ? fromSection : (fallback ?? []));
}

function parseVersionSection(raw: string, fallback?: string): string | null {
  const value = firstMeaningfulLine(raw, ["version"]);
  if (value) return value;
  return fallback?.trim() || null;
}

function parseAuthorSection(raw: string, fallback?: string): string | null {
  const value = firstMeaningfulLine(raw, ["author"]);
  if (value) return value;
  return fallback?.trim() || null;
}

function parseDeprecated(raw: string, fallback?: boolean): boolean {
  const value = raw.split("\n")[0]?.trim().toLowerCase();
  if (!value) return Boolean(fallback);
  return ["true", "yes", "1", "deprecated"].includes(value);
}

function collectWarnings(input: {
  title: string;
  description: string;
  props: ComponentProp[];
  category: ComponentCategory;
  example: string | null;
  version: string | null;
  author: string | null;
  deprecated: boolean;
}): string[] {
  const warnings: string[] = [];

  if (!input.description) warnings.push("Missing description section");
  if (input.props.length === 0) warnings.push("Missing props section or props list");
  if (!input.example) warnings.push("Missing example section");
  if (!input.version) warnings.push("Missing version metadata");
  if (!input.author) warnings.push("Missing author metadata");
  if (input.category === "other") warnings.push("Category defaulted to 'other'");
  if (input.deprecated) warnings.push("Component marked as deprecated");

  if (!/^[A-Za-z][A-Za-z0-9_\- ]{1,}$/.test(input.title)) {
    warnings.push("Component name format looks unusual");
  }

  return warnings;
}

function dedupeLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const v of values) {
    const normalized = v.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function firstMeaningfulLine(raw: string, skipLabels: string[]): string | null {
  const skip = new Set(skipLabels.map((s) => s.toLowerCase()));
  for (const line of raw.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    if (skip.has(value.toLowerCase())) continue;
    return value;
  }
  return null;
}
