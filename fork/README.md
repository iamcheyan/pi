# Pi (Fork)

This is a fork of [pi](https://github.com/earendil-works/pi) — an AI coding assistant with read, bash, edit, write tools.
Repository: https://github.com/iamcheyan/pi

The fork keeps the upstream source intact and layers our own extensions and build tooling on top.

## What's Included

### Core Extensions

| Extension | Description | Source |
|-----------|-------------|--------|
| [pi-minimal](https://github.com/iamcheyan/pi-minimal) | Minimalist REPL-style TUI — clean interface with `»` prompt, compact spacing, startup header | [iamcheyan/pi-minimal](https://github.com/iamcheyan/pi-minimal) |
| [pi-opencode-config-reader](https://github.com/iamcheyan/pi-opencode-config-reader) | Auto-import providers/models from `opencode.json` config files | [iamcheyan/pi-opencode-config-reader](https://github.com/iamcheyan/pi-opencode-config-reader) |

### Installed Packages

| Package | Description | Source |
|---------|-------------|--------|
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Delegate tasks to specialized agents (scout, planner, reviewer, worker, oracle, ...) with isolated context windows | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Token-efficient MCP adapter — one proxy tool (~200 tokens) instead of hundreds of MCP tools | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) |
| [context-mode](https://pi.dev/packages/context-mode) | 98% context reduction via sandbox execution, FTS5 knowledge base, and session state tracking | [npm:context-mode](https://www.npmjs.com/package/context-mode) |

### Upstream

Base: [earendil-works/pi](https://github.com/earendil-works/pi)

## Quick Start

### One-liner install (no repo needed)

```bash
curl -fsSL https://raw.githubusercontent.com/iamcheyan/pi/main/fork/init.sh | bash
```

This downloads pi + all extensions on a fresh machine.

### From repo

```bash
# 1. Clone the repo and its extension submodules
git clone --recurse-submodules https://github.com/iamcheyan/pi.git && cd pi

# 2. Run init (uses local binary, symlinks extensions)
bash fork/init.sh

# 3. Build the binary (if not built yet)
bash fork/build.sh

# 4. Use pi
pi --help
```

> Extensions auto-load from `~/.pi/agent/extensions/` — no `--extension` flags needed.
> Set `export PI_REPO="$HOME/Development/pi"` in your shell rc for faster binary detection.

## Fork Commands

All scripts live in `fork/`.

| Command | Description |
|---------|-------------|
| `bash fork/init.sh` | Install extensions, create `~/.local/bin/pi` wrapper |
| `bash fork/build.sh` | Build pi binary for current platform → `fork/dist/` |
| `bash fork/update.sh` | Rebase fork patches onto upstream, validate, push |
| `bash fork/check-upstream-seams.sh` | Verify fork ownership boundaries |
| `bash fork/push.sh` | Push sub-repos (pi-minimal, pi-opencode-config-reader) |

### init.sh

Works in two modes:

**Local mode** (inside pi repo):
- Uses the local fork build as pi binary
- Symlinks extensions from `fork/pi-minimal/` and `fork/pi-opencode-config-reader/`
- Creates `~/.local/bin/pi` wrapper with auto-detection

**Remote mode** (standalone, e.g. `curl ... | bash`):
- Downloads pi binary from upstream GitHub releases
- Installs to `~/.local/bin/pi`
- Clones extensions from GitHub

Both modes then:
- Install `npm:pi-subagents`, `npm:pi-mcp-adapter`, `npm:context-mode`
- Configure `~/.pi/agent/mcp.json` for context-mode
- Remove conflicting example symlinks

Run once after clone, or whenever extensions change.

### build.sh

Compiles the pi binary for your current platform using bun:

```
fork/dist/pi-<os>-<arch>/bin/pi
```

Requires: bun, Node.js (via nvm).

### update.sh

Syncs with upstream pi repository:

1. Requires a clean worktree
2. Fetches `origin` and `upstream`
3. Creates a local backup branch
4. Rebases the fork patch queue onto `upstream/main`
5. Stops for manual conflict resolution when needed
6. Checks the two permitted upstream source seams
7. Runs shell validation and `npm run check`
8. Pushes with `--force-with-lease`

Use `bash fork/update.sh --no-push` to review the rebased history locally
before updating GitHub.

The maintenance model and recovery branches are documented in
[`fork/docs/202606152110_rebase-upstream-maintenance-strategy.md`](https://github.com/iamcheyan/pi/blob/main/fork/docs/202606152110_rebase-upstream-maintenance-strategy.md).

### push.sh

Pushes changes in sub-repos:
- `fork/pi-minimal`
- `fork/pi-opencode-config-reader`

## Subagent Usage

Once installed, use subagents in pi interactively:

```
/run scout "find all auth-related code"
/chain scout "find code" -> planner "create plan" -> worker "implement"
/parallel reviewer "review backend" -> reviewer "review frontend"
```

Slash commands: `/run`, `/chain`, `/parallel`, `/subagents-doctor`

## Updating

```bash
bash fork/update.sh
```

This rebases the fork patches, validates the result, and pushes the rewritten
branch with lease protection.

The fork keeps a small linear patch queue on top of `upstream/main`. Most
features live under `fork/`; only two upstream source files are modified and
enforced by `fork/upstream-seams.allowlist`.
