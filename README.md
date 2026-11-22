# mend

[![Bounty](https://img.shields.io/badge/make.fun-bounty-blue?logo=github)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Repository](https://img.shields.io/badge/repo-arianda17/mend-green?logo=github)](https://github.com/arianda17/mend)

**mend** is a single command-line tool that applies the edits AI models write — in every format they use — to a tree of files. Unified diffs, git-apply style patches, SEARCH/REPLACE blocks, V4A patches, and JSON edits are all handled by one tool. Node 22 standard library only, no dependencies.

## What it does

- **Unified diff** — applies `--- a/file` / `+++ b/file` hunks with line-number guidance and three-tier fuzzy line matching (exact, trailing-whitespace, trimmed)
- **git-apply style** — handles `diff --git` headers, renames, deletions, and new files
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` format with path discovery and occurrence selection
- **V4A patches** — `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` sections with `@@` context headers
- **JSON edits** — programmatic edits via JSON input for tool integration
- **All-or-nothing writes** — applies every edit atomically; if any fails, no files are modified
- **Safe paths** — rejects traversal attempts and unsafe file operations
- **Format detection** — auto-detects the patch format from content

## Usage

```bash
node main.ts [options] [PATCH]
```

### Options

| Flag | Description |
|------|-------------|
| `--strict` | Use exact line matching only (no fuzzy fallback) |
| `--check` | Dry-run: report what would change without writing |

### Examples

```bash
# Apply a unified diff from a file
node main.ts patch.diff

# Apply from stdin
cat patch.diff | node main.ts

# Apply a SEARCH/REPLACE patch
node main.ts search-replace.txt
```

### Running practice checks

```bash
# Run all practice checks
node check.ts ../program/generator/practice.json

# Run a specific family
node check.ts ../program/generator/practice.json v-eof u-fenced-bare
```

## Supported formats

1. **Unified diff** — standard `diff -u` output with `---`/`+++` headers and `@@` hunks
2. **git-apply** — extended unified diff with `diff --git`, `rename from/to`, `new file mode`, `deleted file mode`
3. **SEARCH/REPLACE** — Aider-style blocks with `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` markers
4. **V4A** — Codex-style patches with `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`
5. **JSON** — structured edit operations for programmatic use

## Requirements

- Node.js 22 (standard library only, no npm install needed)

## License

MIT — see [LICENSE](LICENSE) for details.