import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseComponentMarkdown } from "../dist/component-parser.js";
import { getMarkdownFilesFromFolders, readFileSafe } from "../dist/markdown-loader.js";
import { EmbeddingStore } from "../dist/embedding-store.js";
import {
  buildPropsObject,
  composeUiLayout,
  generateComponentMarkdown,
  generatePropVariations,
  lintMarkdownText,
  renderComponentByFormat,
  validateComponent,
} from "../dist/feature-tools.js";
import { authorizeRequest, canExecuteExamples, canWriteFiles, getExecutionProfile } from "../dist/security.js";
import { FIXTURE_DIR, ensureTmpDir } from "./helpers.mjs";

async function loadFixture(name) {
  const filePath = path.join(FIXTURE_DIR, name);
  const markdown = fs.readFileSync(filePath, "utf8");
  const component = await parseComponentMarkdown(markdown, filePath);
  assert.ok(component, `Failed to parse fixture ${name}`);
  return component;
}

test("parses frontmatter metadata and warnings", async () => {
  const button = await loadFixture("Button.md");
  assert.equal(button.name, "Button");
  assert.equal(button.author, "design-team");
  assert.equal(button.version, "1.2.0");
  assert.equal(button.deprecated, false);
  assert.ok(button.tags.includes("input"));

  const brokenMd = fs.readFileSync(path.join(FIXTURE_DIR, "BrokenThing.md"), "utf8");
  const broken = await parseComponentMarkdown(brokenMd, "BrokenThing.md");
  assert.ok(broken);
  assert.ok(broken.warnings.length > 0);
});

test("loader discovers markdown files recursively", () => {
  const files = getMarkdownFilesFromFolders([FIXTURE_DIR]);
  assert.ok(files.some((f) => f.endsWith("Button.md")));
  assert.equal(readFileSafe(path.join(FIXTURE_DIR, "Button.md")) !== null, true);
});

test("embedding store indexes and searches components", async () => {
  const dbDir = ensureTmpDir("module-store");
  const dbPath = path.join(dbDir, "components.sqlite");

  const store = new EmbeddingStore(dbPath, 64);
  const components = await Promise.all([
    loadFixture("Button.md"),
    loadFixture("Card.md"),
    loadFixture("DangerBanner.md"),
  ]);

  store.syncComponents(components);

  const status = store.getStatus();
  assert.equal(status.indexedCount, 3);

  const semantic = store.semanticSearch("click action", 5);
  assert.ok(semantic.length > 0);

  const similar = store.similarComponents("Button", 5);
  assert.ok(Array.isArray(similar));
});

test("feature helpers render and compose expected output", async () => {
  const button = await loadFixture("Button.md");
  const card = await loadFixture("Card.md");

  const props = buildPropsObject(button);
  assert.ok(Object.prototype.hasOwnProperty.call(props, "label"));

  const jsx = renderComponentByFormat(button, "jsx");
  assert.equal(typeof jsx, "string");
  assert.ok(String(jsx).includes("<Button"));

  const html = renderComponentByFormat(button, "html");
  assert.ok(String(html).includes("data-component"));

  const schema = renderComponentByFormat(button, "json_schema");
  assert.equal(typeof schema, "object");

  const layout = composeUiLayout([button, card], "dashboard", "jsx");
  assert.ok(layout.includes("<main"));

  const variations = generatePropVariations(button, 3);
  assert.equal(variations.length, 3);

  const validation = validateComponent(button);
  assert.equal(validation.valid, true);

  const lint = lintMarkdownText("# X\n\n## Description\nA");
  assert.ok(lint.length > 0);

  const generated = generateComponentMarkdown({
    name: "Table",
    description: "Data table",
    category: "display",
    props: [{ name: "rows", type: "array", description: "Row list" }],
    tags: ["data"],
  });
  assert.ok(generated.includes("# Table"));
});

test("security helper behavior follows profile and auth configuration", () => {
  const previousToken = process.env.MCP_AUTH_TOKEN;
  const previousProfile = process.env.MCP_EXECUTION_PROFILE;

  process.env.MCP_AUTH_TOKEN = "secret";
  process.env.MCP_EXECUTION_PROFILE = "strict";

  const denied = authorizeRequest();
  assert.equal(denied.authorized, false);
  assert.equal(denied.profile, "strict");
  assert.equal(canExecuteExamples("strict"), false);
  assert.equal(canWriteFiles("strict"), false);

  const allowed = authorizeRequest("secret");
  assert.equal(allowed.authorized, true);

  process.env.MCP_EXECUTION_PROFILE = "open";
  assert.equal(getExecutionProfile(), "open");

  process.env.MCP_AUTH_TOKEN = previousToken;
  process.env.MCP_EXECUTION_PROFILE = previousProfile;
});

