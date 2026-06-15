# Fork Maintenance Rules

Scope: `fork/**` and repository-level maintenance for the iamcheyan/pi fork.

## Ownership

- Keep fork features under `fork/**` whenever possible.
- Keep root `AGENTS.md` from upstream.
- `fork/README.md` is the canonical source for root `README.md`.
- The only permitted upstream source modifications are listed in
  `fork/upstream-seams.allowlist`.
- Mark each upstream modification with `FORK-SEAM(pi)`.

## Upstream Sync

- `fork/update.sh` is the authoritative sync command.
- The fork uses a linear patch queue rebased onto `upstream/main`.
- Require a clean worktree before syncing. Do not auto-stash.
- Stop on conflicts. Never delete a conflicted file automatically.
- Do not remove upstream `.github`, `.pi`, docs, tests, or contributor files.
- Push rebased history only with `--force-with-lease`.
- Keep a backup branch before rewriting published history.

## Validation

After changing fork code or rebasing:

```bash
bash fork/check-upstream-seams.sh
bash -n fork/update.sh fork/init.sh fork/build.sh fork/push.sh
npm run check
```

Run focused tests for any modified behavior.

## Submodules

- `fork/pi-minimal` and `fork/pi-opencode-config-reader` are registered
  submodules.
- Clone with `--recurse-submodules`, or run:

```bash
git submodule update --init --recursive
```

- `fork/pi-ralph`, `fork/pi-spawn`, `fork/pi-debug`, and `fork/pi-telegram`
  are maintained directly in this repository.

## Commits

- Keep the patch queue small and thematic.
- Do not create merge commits for upstream synchronization.
- Do not commit regenerated model files unless their generator or model data
  intentionally changed.
- Do not use generic messages such as `Auto-commit` or `Update fork files`.
