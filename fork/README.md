# Pi (Fork)

This is a fork of [pi](https://github.com/earendil-works/pi) — an AI coding assistant with read, bash, edit, write tools.

The fork keeps the upstream source intact and layers our own extensions and build tooling on top.

## What's Different

- **pi-subagents** — delegate tasks to specialized agents (scout, planner, reviewer, worker, oracle, ...) with isolated context windows
- **pi-mcp-adapter** — MCP server integration
- **pi-minimal** — minimal TUI overlay
- **pi-opencode-config-reader** — opencode config reader

These are installed as npm extensions via `fork/init.sh`.

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url> && cd pi

# 2. Run init (installs extensions + creates PATH wrapper)
bash fork/init.sh

# 3. Build the binary
bash fork/build.sh

# 4. Use pi
pi --help
```

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

- Creates `~/.pi/agent/{extensions,agents,prompts}` directories
- Creates `~/.local/bin/pi` wrapper (auto-detects repo location)
- Installs `npm:pi-subagents` and `npm:pi-mcp-adapter`
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
