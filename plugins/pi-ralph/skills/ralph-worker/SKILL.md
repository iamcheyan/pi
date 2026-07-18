---
name: ralph-worker
description: "Worker instructions for the Ralph autonomous agent loop. Implements one user story per iteration."
disable-model-invocation: true
---

# Ralph Worker Instructions

You are an autonomous coding agent implementing a single user story from a PRD.

## Your Task

1. Read `prd.json` in the current working directory
2. Find the user story with `passes: false` and the **lowest priority number** (highest priority)
3. If no stories have `passes: false`, all work is done — skip to Stop Condition
4. Implement that single user story
5. Run quality checks
6. Commit and update state files

## Implementation Steps

### 1. Read State

- Read `prd.json` to find the next story
- Read `progress.txt` — check the **Codebase Patterns** section at the top for reusable patterns from previous iterations

### 2. Branch Check

- Verify you are on the branch specified in `prd.json` → `branchName`
- If not, create or checkout that branch from main

### 3. Implement the Story

- Work on **ONE story only**
- Follow existing code patterns in the codebase
- Make minimal, focused changes
- Do NOT refactor unrelated code

### 4. Quality Checks

Run the project's quality checks. The standard checks are:

```bash
npm run check
```

If `npm run check` fails or does not exist, try in this order:
1. `npx tsc --noEmit` (typecheck)
2. `npx biome check .` (lint)
3. `npm test` (tests, if available)

**ALL checks must pass before committing.**

### 5. Commit

If checks pass, commit all changes:

```bash
git add -A
git commit -m "feat: [Story ID] - [Story Title]"
```

### 6. Update State Files

**Update `prd.json`:** Set the completed story's `passes` to `true`.

**Append to `progress.txt`** (never replace, always append):

```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the settings panel is in component X")
---
```

### 7. Update AGENTS.md

If you discovered reusable patterns, update the relevant `AGENTS.md` files:
- Patterns or conventions specific to that module
- Gotchas or non-obvious requirements
- Dependencies between files

Do NOT add story-specific implementation details.

## Stop Condition

After completing a user story, check if ALL stories in `prd.json` have `passes: true`.

If ALL stories are complete, reply with exactly:

```
<promise>COMPLETE</promise>
```

If stories remain with `passes: false`, end your response normally (the next iteration will pick up the next story).

## Codebase Patterns

Before starting work, read the **Codebase Patterns** section at the top of `progress.txt`. These are consolidated learnings from previous iterations that apply broadly. Use them to avoid repeating mistakes and follow established conventions.
