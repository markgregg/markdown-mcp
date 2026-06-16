import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURE_DIR, ROOT_DIR, ensureTmpDir, parseToolTextResult, cleanDir } from "./helpers.mjs";

const AUTH_TOKEN = "integration-secret";

async function createClient(runDirName) {
  const runDir = ensureTmpDir(runDirName);
  const env = {
    ...process.env,
    COMPONENT_MD_FOLDERS: FIXTURE_DIR,
    COMPONENT_EMBEDDINGS_DB_PATH: path.join(runDir, "components.sqlite"),
    COMPONENT_INDEX_PATH: path.join(runDir, "component-index.json"),
    ENABLE_COMPONENT_FILE_WATCH: "false",
    MCP_AUTH_TOKEN: AUTH_TOKEN,
    MCP_ENV_PROFILE: "test",
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT_DIR, "dist", "server.js")],
    cwd: ROOT_DIR,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "copilot-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return { client, transport, runDir };
}

async function createClientFromSourcesList(runDirName, sourcesListPath) {
  const runDir = ensureTmpDir(runDirName);
  const env = {
    ...process.env,
    COMPONENT_MD_FOLDERS: "",
    COMPONENT_EMBEDDINGS_DB_PATH: path.join(runDir, "components.sqlite"),
    COMPONENT_INDEX_PATH: path.join(runDir, "component-index.json"),
    ENABLE_COMPONENT_FILE_WATCH: "false",
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(ROOT_DIR, "dist", "server.js"),
      "--component-sources-file",
      sourcesListPath,
    ],
    cwd: ROOT_DIR,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "copilot-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return { client, transport, runDir };
}

async function call(client, name, args = undefined) {
  const result = await client.callTool({ name, arguments: args });
  return {
    raw: result,
    data: parseToolTextResult(result),
  };
}

test("mcp server supports copilot-style discovery and tool usage", async () => {
  const { client, transport, runDir } = await createClient("mcp-e2e");

  try {
    const listed = await client.listTools();
    const toolNames = (listed.tools ?? []).map((t) => t.name);

    const expectedTools = [
      "list_components",
      "get_component",
      "search_components",
      "list_categories",
      "semantic_search_components",
      "similar_components",
      "validate_components",
      "stats",
      "compose_ui",
      "render_component",
      "render_example_html",
      "generate_prop_variations",
      "generate_preview",
      "generate_component_markdown",
      "lint_component_markdown",
    ];

    for (const tool of expectedTools) {
      assert.ok(toolNames.includes(tool), `Missing tool: ${tool}`);
    }

    const components = await call(client, "list_components");
    assert.ok(components.data.components.length >= 3);

    const one = await call(client, "get_component", { name: "Button" });
    assert.equal(one.data.component.name, "Button");

    const keyword = await call(client, "search_components", { query: "click action" });
    assert.ok(Array.isArray(keyword.data.results));

    const categories = await call(client, "list_categories");
    assert.ok(Array.isArray(categories.data.categories));

    const semantic = await call(client, "semantic_search_components", { query: "warning", tags: ["alert"] });
    assert.ok(Array.isArray(semantic.data.results));

    const similar = await call(client, "similar_components", { name: "Button" });
    assert.ok(Array.isArray(similar.data.results));

    const validation = await call(client, "validate_components");
    assert.ok(validation.data.totals.components >= 3);

    const stats = await call(client, "stats");
    assert.equal(typeof stats.data.components.total, "number");

    const composed = await call(client, "compose_ui", { template: "dashboard", format: "jsx" });
    assert.ok(String(composed.data.layout).includes("<main"));

    const renderFormats = ["jsx", "html", "json_schema", "react_props_object"];
    for (const format of renderFormats) {
      const rendered = await call(client, "render_component", { name: "Button", format });
      assert.equal(rendered.data.format, format);
    }

    const exampleHtml = await call(client, "render_example_html", { name: "DangerBanner", sandboxRun: true });
    assert.ok(String(exampleHtml.data.html).includes("DangerBanner"));

    const variations = await call(client, "generate_prop_variations", { name: "Button", count: 4 });
    assert.equal(variations.data.variations.length, 4);

    const previewUnauthorized = await client.callTool({
      name: "generate_preview",
      arguments: { name: "Button", writeToFile: true },
    });
    assert.equal(previewUnauthorized.isError, true);

    const previewAuthorized = await call(client, "generate_preview", {
      name: "Button",
      writeToFile: true,
      outputPath: path.join(runDir, "button.preview.html"),
      authToken: AUTH_TOKEN,
    });
    assert.ok(previewAuthorized.data.savedPath);
    assert.equal(fs.existsSync(previewAuthorized.data.savedPath), true);

    const generatedUnauthorized = await client.callTool({
      name: "generate_component_markdown",
      arguments: {
        name: "NewBadge",
        description: "Badge",
        writeToFile: true,
      },
    });
    assert.equal(generatedUnauthorized.isError, true);

    const generatedAuthorized = await call(client, "generate_component_markdown", {
      name: "NewBadge",
      description: "Badge",
      category: "display",
      props: [{ name: "text", type: "string", description: "Badge text" }],
      writeToFile: true,
      outputFolder: runDir,
      authToken: AUTH_TOKEN,
    });
    assert.ok(generatedAuthorized.data.filePath);
    assert.equal(fs.existsSync(generatedAuthorized.data.filePath), true);

    const lint = await call(client, "lint_component_markdown", {
      markdown: "# X\n\n## Description\nA"
    });
    assert.equal(lint.data.valid, false);

    const indexPath = path.join(runDir, "component-index.json");
    assert.equal(fs.existsSync(indexPath), true);
  } finally {
    await client.close();
    await transport.close();
    cleanDir(runDir);
  }
});

test("mcp server loads components from --component-sources-file with local paths and URLs", async () => {
  const runDir = ensureTmpDir("mcp-sources-file");
  const remoteMarkdown = fs.readFileSync(path.join(FIXTURE_DIR, "RemoteChip.md"), "utf8");

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/RemoteChip.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(remoteMarkdown);
      return;
    }

    res.writeHead(404);
    res.end("not-found");
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const remoteUrl = `http://127.0.0.1:${address.port}/RemoteChip.md`;

  const localPath = path.join(FIXTURE_DIR, "Button.md");
  const listPath = path.join(runDir, "component-sources.txt");
  fs.writeFileSync(listPath, `${localPath}\n${remoteUrl}\n`, "utf8");

  const { client, transport } = await createClientFromSourcesList("mcp-sources-file-run", listPath);

  try {
    const listed = await call(client, "list_components");
    const names = listed.data.components.map((c) => c.name);
    assert.ok(names.includes("Button"));
    assert.ok(names.includes("RemoteChip"));

    const remote = await call(client, "get_component", { name: "RemoteChip" });
    assert.equal(remote.data.component.name, "RemoteChip");
    assert.equal(remote.data.component.filePath, remoteUrl);

    const search = await call(client, "search_components", { query: "remote compact tag" });
    assert.ok(search.data.results.some((r) => r.name === "RemoteChip"));
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => httpServer.close(resolve));
    cleanDir(runDir);
  }
});
