# Pi (Fork)

This is a fork of [pi](https://github.com/earendil-works/pi) — an AI coding assistant with read, bash, edit, write tools.
Repository: https://github.com/iamcheyan/pi

The fork keeps the upstream source intact and layers our own extensions and build tooling on top.

## What's Different

- **pi-subagents** — delegate tasks to specialized agents (scout, planner, reviewer, worker, oracle, ...) with isolated context windows
- **pi-mcp-adapter** — MCP server integration
- **context-mode** — 98% context reduction via sandbox execution and FTS5 knowledge base
- **pi-minimal** — minimal TUI overlay
- **pi-opencode-config-reader** — opencode config reader

These are installed via `fork/init.sh`.

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/iamcheyan/pi.git && cd pi

# 2. Run init (downloads extensions + creates PATH wrapper)
bash fork/init.sh

# 3. Build the binary
bash fork/build.sh

# 4. Use pi
pi --help
```

> Extensions are downloaded from their repos and placed in `~/.pi/agent/extensions/` — they auto-load on startup.
> Set `export PI_REPO="$HOME/Development/pi"` in your shell rc for faster binary detection.

## Fork Commands

All scripts live in `fork/`.

| Command | Description |
|---------|-------------|
| `bash fork/init.sh` | Install extensions, create `~/.local/bin/pi` wrapper |
| `bash fork/build.sh` | Build pi binary for current platform → `fork/dist/` |
| `bash fork/update.sh` | Sync upstream changes, merge, rebuild, push |
| `bash fork/push.sh` | Push sub-repos (pi-minimal, pi-opencode-config-reader) |

### init.sh

Sets up everything needed to run pi with our extensions:

- Downloads pi-minimal and pi-opencode-config-reader from GitHub
- Copies extensions to `~/.pi/agent/extensions/` (auto-load, no `--extension` flags)
- Copies theme to `~/.pi/agent/themes/`
- Creates `~/.pi/agent/{extensions,agents,prompts}` directories
- Creates `~/.local/bin/pi` wrapper (uses `$PI_REPO` env var or auto-detects)
- Installs `npm:pi-subagents`, `npm:pi-mcp-adapter`, `npm:context-mode`
- Configures `~/.pi/agent/mcp.json` for context-mode
- Removes conflicting example symlinks

Run once after clone, or whenever extensions change.

### build.sh

Compiles the pi binary for your current platform using bun:

```
fork/dist/pi-<os>-<arch>/bin/pi
```

Requires: bun, Node.js (via nvm).

### update.sh

Syncs with upstream pi repository:

1. Fetches upstream main branch
2. Stashes local changes
3. Merges upstream (auto-resolves .github/ conflicts)
4. Removes upstream files we don't need
5. Copies `fork/README.md` → root `README.md`
6. Restores our custom AGENTS.md and git hooks
7. Rebuilds the binary
8. Commits and pushes

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

This pulls upstream changes, applies our customizations, rebuilds, and pushes.
