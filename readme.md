📦 Markdown Component MCP Server

A Model Context Protocol server for discovering, searching, and composing UI components defined in Markdown files.

🚀 Overview

This MCP server turns a folder of Markdown files into a queryable design‑system knowledge base. Each Markdown file represents a UI component, including:

Component name

Description

Props

Category

Example usage

The server parses these files, indexes them, and exposes a set of MCP tools that allow AI assistants to:

List available components

Retrieve full component definitions

Search for components by keyword

Browse components by category

This enables an AI assistant to construct user interfaces by discovering and assembling components defined in your Markdown library.

🧠 How It Works

1. Markdown as the Source of Truth

Each component is defined in a .md file using a simple structure:

# Button

## Description
A clickable button for triggering actions.

## Props
- label: string — Text displayed inside the button
- onClick: function — Callback when clicked

## Category
input

## Example
```jsx
<Button label="Save" onClick={handleSave} />


The server parses these sections into a structured `ComponentDefinition` object.

---

### 2. Component Parsing
The server extracts:

- Title → component name
- Description section
- Props list
- Category
- Example code block

Malformed or missing sections are handled gracefully.

---

### 3. Dynamic Loading
The server reads Markdown files from one or more folders specified via:


COMPONENT_MD_FOLDERS="./components,./more-components"


Files are re‑read on each request to ensure freshness.

You can also pass a source-list file that contains one entry per line. Each entry can be:

- A local file path to a Markdown component file
- A local directory path (all `*.md` files are loaded recursively)
- An `http://` or `https://` URL to a Markdown file

Lines starting with `#` are treated as comments.

Use one of these options:

- CLI arg: `--component-sources-file ./component-sources.txt`
- Env var: `COMPONENT_MD_SOURCES_LIST_FILE="./component-sources.txt"`

Example `component-sources.txt`:

./components/Button.md
./components/forms
https://example.com/components/Card.md

---

### 4. MCP Tools Exposed
The server exposes six core tools:

#### `list_components`
Returns all components with name, category, and file path.

#### `get_component`
Returns the full parsed definition for a given component name.

#### `search_components`
Performs keyword search across names, descriptions, props, and categories.

#### `list_categories`
Returns all categories and the components within them.

#### `semantic_search_components`
Runs embedding-based similarity search over indexed components.

#### `similar_components`
Returns components similar to a given component name.

---

### 5. Embedded Semantic Index (SQLite + sqlite-vss)
The server now stores embeddings in an embedded SQLite database and uses `sqlite-vss`
for vector search when available.

- Database path is configurable with `COMPONENT_EMBEDDINGS_DB_PATH` (default: `.mcp/components.sqlite`)
- Embedding vector size is configurable with `COMPONENT_EMBEDDING_DIMENSIONS` (default: `64`)
- Components are re-indexed during normal load cycles

If `sqlite-vss` is unavailable on the current platform, the server keeps using SQLite and
falls back to in-process cosine similarity over stored embeddings.

---

## 🛠️ Running the Server

### Install dependencies

npm install


### Build

npm run build


### Run

COMPONENT_MD_FOLDERS="./components" npm start


You can specify multiple folders separated by commas.

Optional semantic-index settings:

COMPONENT_EMBEDDINGS_DB_PATH="./.mcp/components.sqlite"
COMPONENT_EMBEDDING_DIMENSIONS="64"

Optional source-list setting:

COMPONENT_MD_SOURCES_LIST_FILE="./component-sources.txt"

Run with CLI argument instead of env var:

node dist/server.js --component-sources-file ./component-sources.txt

---

## 📁 Folder Structure

src/ server.ts types.ts markdown-loader.ts component-parser.ts components/ Button.md Card.md ...


---

## 🧩 What This Enables
With this server running, an AI assistant can:

- Discover components
- Ask for components matching a description
- Retrieve props and examples
- Build UI layouts using your component library
- Generate new components based on patterns

This is the foundation for a **component‑aware UI builder**.

---

# 🧭 To‑Do: Planned Improvements

## 🔍 Semantic Search & Embeddings
- Done: Add embedding generation for each component
- Done: Add an embedded vector database
- Done: Add `semantic_search_components` tool
- Done: Add `similar_components` tool
- Done: Add tag‑based semantic filtering

## 🧱 Component Composition
- Done: Add `compose_ui` tool to generate JSX/HTML layouts
- Done: Add layout templates
- Done: Add automatic prop suggestion

## 🧪 Validation & Quality
- Done: Validate Markdown structure
- Done: Validate example code blocks
- Done: Add `validate_components` tool
- Done: Add warnings for deprecated or incomplete components

## ⚡ Performance & Indexing
- Done: Add a persistent component index
- Done: Cache parsed components
- Done: Cache embeddings
- Done: Add a `stats` tool
- Done: Add file‑watching for auto‑updates

## 🏷️ Metadata Enhancements
- Done: Add YAML frontmatter support
- Done: Add tags for richer search
- Done: Add versioning
- Done: Add authorship metadata

## 🧪 Component Playground
- Done: Add a tool to render example code into HTML
- Done: Add a tool to generate prop variations
- Done: Add a preview generator

## 🔧 Multi‑Format Output
- Done: Support JSX, HTML, JSON schema, and React props object output
- Done: Add `render_component` tool

## 📝 Component Authoring
- Done: Add `generate_component_markdown` tool
- Done: Add automatic file creation
- Done: Add linting for component Markdown files

## 🔐 Security & Deployment
- Done: Add optional authentication
- Done: Add sandboxing for example code execution
- Done: Add environment‑based configuration profiles