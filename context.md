# Code Context

## Files Retrieved

### Core Subagent Extension
1. `packages/coding-agent/examples/extensions/subagent/index.ts` (lines 2-739) - Main subagent extension implementation; defines `SubagentDetails` interface, `SubagentParams` schema, tool registration, and execution logic
2. `packages/coding-agent/examples/extensions/subagent/README.md` (lines 1-50) - Documentation for the subagent example extension
3. `packages/coding-agent/examples/extensions/subagent/agents/worker.md` (line 3) - Worker agent definition for general-purpose subagent
4. `packages/coding-agent/examples/extensions/subagent/prompts/scout-and-plan.md` (line 4) - Chain workflow prompt
5. `packages/coding-agent/examples/extensions/subagent/prompts/implement-and-review.md` (line 4) - Chain workflow prompt
6. `packages/coding-agent/examples/extensions/subagent/prompts/implement.md` (line 4) - Chain workflow prompt

### Scripts
7. `scripts/session-transcripts.ts` (lines 4-394) - Utility script that optionally spawns subagents to analyze session transcripts; contains `runSubagent()` function (line 78)

### Setup/Init
8. `fork/init.sh` (lines 35-138) - Fork initialization script; installs `pi-subagents` npm package, creates subagent symlink, sets up wrapper in PATH

### Tests
9. `packages/coding-agent/test/interactive-mode-status.test.ts` (lines 372-777) - Tests referencing subagent extensions from `pi-interactive-subagents` git source
10. `packages/coding-agent/test/package-manager.test.ts` (lines 1902-1921) - Tests for subagent extension discovery and loading

### Documentation
11. `packages/coding-agent/docs/extensions.md` (line 2585) - Extensions reference table listing `subagent/` directory
12. `packages/coding-agent/examples/extensions/README.md` (line 42) - Examples overview referencing subagent extension
13. `packages/coding-agent/examples/README.md` (line 13) - Examples index mentioning subagents
14. `fork/pi-extension-guide.md` (line 471) - Extension guide listing `subagent/` directory

### Changelogs
15. `packages/coding-agent/CHANGELOG.md` (lines 112, 778, 1559, 1699, 3067, 3724, 3740) - Historical fixes and features for subagent functionality
16. `packages/tui/CHANGELOG.md` (line 660) - Overlay crash fix related to subagent output ANSI/OSC sequences

## Key Code

### SubagentDetails interface (`subagent/index.ts:157`)
```typescript
interface SubagentDetails {
  // structured output from subagent execution
}
```

### SubagentParams schema (`subagent/index.ts:442`)
```typescript
const SubagentParams = Type.Object({
  // parameters for subagent tool invocation
});
```

### Tool registration (`subagent/index.ts:456-464`)
```typescript
name: "subagent",
label: "Subagent",
description: "Delegate tasks to specialized subagents with isolated context.",
parameters: SubagentParams,
```

### runSubagent helper (`scripts/session-transcripts.ts:78`)
```typescript
function runSubagent(prompt: string, cwd: string): Promise<{ success: boolean }> {
  // spawns a separate pi process for each subagent invocation
}
```

## Architecture

The subagent system is an **example extension** in `packages/coding-agent/examples/extensions/subagent/`. It provides a custom tool that delegates tasks to specialized agents by spawning separate `pi` processes with isolated context windows. The extension supports:

- **Chain mode**: Sequential agent pipelines (scout -> plan -> implement -> review)
- **Parallel mode**: Concurrent task execution with streaming updates
- **Abort support**: Ctrl+C propagates to kill subagent processes

The `fork/init.sh` script installs `pi-subagents` as an npm package and creates symlinks so the extension is available in the user's `~/.pi/agent/extensions/subagent/` directory.

Tests validate that extensions (including subagent) are properly discovered and loaded by the package manager.

## Start Here

`packages/coding-agent/examples/extensions/subagent/index.ts` - This is the main implementation file containing all core subagent logic, interfaces, and tool registration.

## Supervisor coordination

No blockers found. All files are searchable and accessible.
