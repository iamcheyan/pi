# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be direct
- Answer questions before making edits

## Code Quality

- Read files in full before wide-ranging changes
- No `any` unless absolutely necessary
- Inline single-line helpers that have only one call site
- Check node_modules for external API types; don't guess
- No inline imports (`await import()`). Top-level imports only
- Use only erasable TypeScript syntax (Node strip-only mode)
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead

## Commands

- After code changes: `npm run check` (full output, no tail). Fix all errors before committing
- Never run `npm run build` or `npm test` unless requested
- For tests: `./test.sh` from repo root, or specific tests from package root
- Never commit unless the user asks

## Git

- Only commit files YOU changed in THIS session
- Stage explicit paths (`git add <path>`); never `git add -A`
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git commit --no-verify`

## Fork Workflow

- `fork/init.sh` — install extensions, create PATH wrapper
- `fork/build.sh` — compile pi binary
- `fork/update.sh` — sync upstream, merge, rebuild, push
- `fork/push.sh` — push sub-repos

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding.
