#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UPSTREAM_URL="https://github.com/earendil-works/pi.git"
UPSTREAM_REF="upstream/main"
PUSH=true
RUN_CHECK=true

usage() {
  cat <<'EOF'
Usage: bash fork/update.sh [--no-push] [--skip-check]

Rebase the fork patch queue onto upstream/main.

  --no-push     Leave the rebased branch local for review.
  --skip-check  Skip npm run check (the seam check still runs).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-push)
      PUSH=false
      ;;
    --skip-check)
      RUN_CHECK=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

cd "$ROOT_DIR"

MERGE_HEAD_PATH="$(git rev-parse --git-path MERGE_HEAD)"
REBASE_MERGE_PATH="$(git rev-parse --git-path rebase-merge)"
REBASE_APPLY_PATH="$(git rev-parse --git-path rebase-apply)"
if [ -f "$MERGE_HEAD_PATH" ] || [ -d "$REBASE_MERGE_PATH" ] || [ -d "$REBASE_APPLY_PATH" ]; then
  echo "A merge or rebase is already in progress. Finish or abort it first." >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  echo "Detached HEAD is not supported." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "The worktree is not clean. Commit or move local changes before updating." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

echo "Fetching origin and upstream..."
git fetch origin
git fetch upstream

ORIGIN_REF="origin/$BRANCH"
ORIGIN_SHA=""
if git rev-parse --verify "$ORIGIN_REF" >/dev/null 2>&1; then
  ORIGIN_SHA="$(git rev-parse "$ORIGIN_REF")"
  if ! git merge-base --is-ancestor "$ORIGIN_REF" HEAD; then
    echo "$ORIGIN_REF contains commits not present locally." >&2
    echo "Integrate or inspect those commits before rebasing." >&2
    exit 1
  fi
fi

if [ "$(git rev-list --count "HEAD..$UPSTREAM_REF")" -eq 0 ]; then
  echo "Already based on the latest $UPSTREAM_REF."
  bash fork/check-upstream-seams.sh
  exit 0
fi

BACKUP_BRANCH="backup/pre-upstream-rebase-$(date +%Y%m%d%H%M%S)"
git branch "$BACKUP_BRANCH" HEAD
echo "Created local backup: $BACKUP_BRANCH"

echo "Rebasing $BRANCH onto $UPSTREAM_REF..."
if ! git rebase "$UPSTREAM_REF"; then
  cat >&2 <<EOF

Rebase stopped on a conflict.

  Inspect:   git status
  Continue:  git add <resolved-files> && git rebase --continue
  Abort:     git rebase --abort
  Backup:    $BACKUP_BRANCH
EOF
  exit 1
fi

bash fork/check-upstream-seams.sh
bash -n fork/update.sh fork/init.sh fork/build.sh fork/push.sh

if [ "$RUN_CHECK" = true ]; then
  npm run check
fi

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Validation modified the worktree. Review and commit those changes before pushing." >&2
  git status --short >&2
  exit 1
fi

if [ "$PUSH" = false ]; then
  echo "Rebase complete. Review the branch before pushing:"
  echo "  git log --oneline $UPSTREAM_REF..HEAD"
  echo "  git diff --stat $UPSTREAM_REF..HEAD"
  exit 0
fi

if [ -n "$ORIGIN_SHA" ]; then
  echo "Pushing $BRANCH with force-with-lease..."
  git push \
    --force-with-lease="refs/heads/$BRANCH:$ORIGIN_SHA" \
    origin "HEAD:$BRANCH"
else
  echo "Publishing new branch $BRANCH..."
  git push -u origin "HEAD:$BRANCH"
fi

echo "Upstream sync complete."
echo "Base:  $(git rev-parse --short "$UPSTREAM_REF")"
echo "Head:  $(git rev-parse --short HEAD)"
echo "Patch commits: $(git rev-list --count "$UPSTREAM_REF"..HEAD)"
