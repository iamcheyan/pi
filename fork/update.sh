#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[90m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STASH_NAME="fork-update-$(date +%Y%m%d%H%M%S)"
STASH_REF=""
STASHED=false

cd "$ROOT_DIR"

restore_stash() {
  if [ "$STASHED" != true ] || [ -z "$STASH_REF" ]; then
    return
  fi

  echo ""
  echo -e "${DIM}Restoring stashed worktree changes...${RESET}"
  if git stash apply "$STASH_REF" >/dev/null 2>&1; then
    git stash drop "$STASH_REF" >/dev/null 2>&1 || true
    echo -e "${GREEN}Restored stashed worktree changes.${RESET}"
    return
  fi

  echo -e "${YELLOW}Stashed changes could not be auto-restored cleanly.${RESET}"
  echo -e "Resolve current state first, then restore manually:"
  echo -e "  ${CYAN}git stash apply $STASH_REF${RESET}"
}

restore_root_agents() {
  if [ ! -f "fork/AGENTS.md" ]; then
    echo -e "${YELLOW}fork/AGENTS.md not found; keeping current root AGENTS.md.${RESET}"
    return
  fi

  echo ""
  echo -e "${DIM}Restoring root AGENTS.md from fork/AGENTS.md...${RESET}"
  cp fork/AGENTS.md AGENTS.md
  git add AGENTS.md fork/AGENTS.md
  echo -e "  ${GREEN}✓${RESET} AGENTS.md refreshed from fork/AGENTS.md"
}

restore_git_hooks() {
  # No custom hooks to restore currently
  :
}


stage_fork_readme() {
  echo ""
  echo -e "${DIM}Refreshing fork README...${RESET}"

  if [ ! -f "fork/README.md" ]; then
    echo -e "${YELLOW}fork/README.md not found; keeping current README.${RESET}"
    return
  fi

  if [ -f "README.md" ]; then
    rm -f README.md
  fi

  cp fork/README.md README.md
  git add README.md
  echo -e "  ${GREEN}✓${RESET} README.md refreshed from fork/README.md"
}

remove_upstream_github_dir() {
  if [ ! -d ".github" ]; then
    return
  fi

  echo ""
  echo -e "${DIM}Removing upstream .github directory...${RESET}"
  git rm -r --ignore-unmatch .github >/dev/null 2>&1 || rm -rf .github
}

remove_upstream_files() {
  echo ""
  echo -e "${DIM}Removing upstream files we don't need...${RESET}"

  # Files and dirs to remove (upstream-only, not needed for build)
  REMOVE_TARGETS=(
    ".claude"
    ".husky"
    ".pi"
    "docs"
    "AGENTS.md"
    "CONTRIBUTING.md"
    "README.md"
    "pi-test.bat"
    "pi-test.ps1"
    "pi-test.sh"
    "context.md"
    "progress.md"
  )

  REMOVED=0
  for target in "${REMOVE_TARGETS[@]}"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      git rm -rf --ignore-unmatch "$target" >/dev/null 2>&1 || rm -rf "$target"
      echo -e "  ${GREEN}✓${RESET} removed $target"
      REMOVED=$((REMOVED + 1))
    fi
  done

  # Also clean up untracked dirs that upstream may recreate
  for target in "${REMOVE_TARGETS[@]}"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      rm -rf "$target"
      echo -e "  ${GREEN}✓${RESET} removed $target (untracked)"
      REMOVED=$((REMOVED + 1))
    fi
  done

  if [ "$REMOVED" -eq 0 ]; then
    echo -e "  ${DIM}nothing to remove${RESET}"
  else
    echo -e "  ${DIM}removed $REMOVED file(s)/dir(s)${RESET}"
  fi
}

update_models_snapshot() {
  echo ""
  echo -e "${DIM}Refreshing models snapshot...${RESET}"
  if [ -f "packages/ai/scripts/generate-models.ts" ]; then
    bun run packages/ai/scripts/generate-models.ts
    if [ -f "packages/ai/src/models.generated.ts" ]; then
      git add packages/ai/src/models.generated.ts
    else
      echo -e "  ${YELLOW}⚠ models.generated.ts not found; skipping git add${RESET}"
    fi
  fi
}

print_conflict_help() {
  local remaining="$1"

  echo ""
  echo -e "${RED}${BOLD}Merge conflict!${RESET}"
  echo ""
  echo -e "Unresolved conflicts:"
  echo "$remaining" | while IFS= read -r f; do
    echo -e "  ${RED}✗${RESET} $f"
  done
  echo ""
  echo -e "${BOLD}Suggested resolution:${RESET}"
  echo -e "  1. Inspect status:        ${CYAN}git status${RESET}"
  echo -e "  2. Open conflicted diff:  ${CYAN}git diff --name-only --diff-filter=U${RESET}"
  echo -e "  3. Prefer upstream for protected ${CYAN}packages/*/src/**${RESET} files unless a fork migration is intentional"
  echo -e "  4. Prefer fork side for ${CYAN}fork/**${RESET} files unless upstream changes should be adopted manually"
  echo -e "  5. After resolving:       ${CYAN}git add <files> && git commit --no-edit${RESET}"
  echo -e "  ${DIM}Or abort: git merge --abort${RESET}"
  if [ "$STASHED" = true ] && [ -n "$STASH_REF" ]; then
    echo -e "  ${DIM}Stashed worktree is preserved as $STASH_REF; restore it after the merge is finished.${RESET}"
  fi
  echo ""
}

echo -e "${BOLD}${CYAN}Syncing upstream changes${RESET}"
echo ""

# ─── 1. Check remote ─────────────────────────────────────────────────────────
if ! git remote get-url upstream &>/dev/null; then
  echo -e "${YELLOW}'upstream' remote not found. Adding it...${RESET}"
  git remote add upstream https://github.com/earendil-works/pi.git
  echo -e "  ${GREEN}✓${RESET} Added upstream: https://github.com/earendil-works/pi.git"
fi

# ─── 2. Fetch upstream ───────────────────────────────────────────────────────
echo -e "${DIM}Fetching upstream...${RESET}"
git fetch upstream

UPSTREAM_BRANCH="upstream/main"
LOCAL_BRANCH="$(git branch --show-current)"
if [ -z "$LOCAL_BRANCH" ]; then
  echo -e "${RED}Detached HEAD is not supported. Check out a branch first.${RESET}"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo -e "${DIM}Stashing local worktree changes...${RESET}"
  git stash push --include-untracked -m "$STASH_NAME" >/dev/null
  STASH_REF="$(git stash list --format='%gd %s' | awk -v name="$STASH_NAME" 'index($0, name) { print $1; exit }')"
  if [ -n "$STASH_REF" ]; then
    STASHED=true
  else
    echo -e "${YELLOW}No stash was created. Continuing with the current worktree state.${RESET}"
  fi
fi

# ─── 3. Check for new commits ────────────────────────────────────────────────
LOCAL_HEAD="$(git rev-parse HEAD)"
UPSTREAM_HEAD="$(git rev-parse $UPSTREAM_BRANCH)"

# Find merge base
MERGE_BASE="$(git merge-base HEAD $UPSTREAM_BRANCH 2>/dev/null || echo "")"

# Check if upstream has commits that HEAD doesn't have
UPSTREAM_COUNT="$(git rev-list --count HEAD..$UPSTREAM_HEAD 2>/dev/null || echo "0")"

if [ "$UPSTREAM_COUNT" -eq 0 ]; then
  echo -e "${GREEN}Already up to date with upstream.${RESET}"
  echo ""

  # Still commit any local fork/ changes
  restore_stash
  remove_upstream_files
  stage_fork_readme
  restore_root_agents

  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo -e "${DIM}No local changes to commit.${RESET}"
    exit 0
  fi

  git add -A
  git commit -m "Update fork files"
  echo -e "${GREEN}✓ Committed local changes.${RESET}"
  exit 0
fi

echo -e "${DIM}Upstream has $UPSTREAM_COUNT new commit(s) since last sync.${RESET}"
echo ""

# ─── 4. Show what changed upstream ───────────────────────────────────────────
echo -e "${BOLD}Upstream changes:${RESET}"
git log --oneline "$MERGE_BASE..$UPSTREAM_HEAD" 2>/dev/null | head -20 || true
echo ""

# ─── 5. Check our custom files ───────────────────────────────────────────────
OUR_DIRS=(
  "fork"
)

OUR_FILES=(
  "fork/AGENTS.md"
  "fork/README.md"
)

echo -e "${BOLD}Our custom files:${RESET}"
for d in "${OUR_DIRS[@]}"; do
  if [ -d "$d" ]; then
    echo -e "  ${GREEN}✓${RESET} $d/ (directory)"
  else
    echo -e "  ${RED}✗${RESET} $d/ ${RED}(missing!)${RESET}"
  fi
done
for f in "${OUR_FILES[@]}"; do
  if [ -f "$f" ]; then
    echo -e "  ${GREEN}✓${RESET} $f"
  else
    echo -e "  ${RED}✗${RESET} $f ${RED}(missing!)${RESET}"
  fi
done
echo ""

# ─── 6. Merge ────────────────────────────────────────────────────────────────
echo -e "${YELLOW}Merging upstream into $LOCAL_BRANCH...${RESET}"
echo ""

# Pre-configure git to auto-resolve conflicts: prefer our deletion for .github/
git config --local merge.ours.driver true 2>/dev/null || true

merge_failed=false
if ! git merge "$UPSTREAM_BRANCH" --no-edit --no-commit 2>/dev/null; then
  merge_failed=true
fi

# Auto-resolve: keep our deletion of .github/ files (we don't need upstream CI)
# Also keep our fork versions of AGENTS.md and README.md
UNMERGED=$(git ls-files --unmerged | awk -F'\t' '{print $2}' | sort -u 2>/dev/null || true)
if [ -n "$UNMERGED" ]; then
  GITHUB_CONFLICTS=$(echo "$UNMERGED" | grep "^\.github/" || true)
  if [ -n "$GITHUB_CONFLICTS" ]; then
    echo -e "${YELLOW}Auto-resolving .github/ conflicts (keeping our deletion)...${RESET}"
    echo "$GITHUB_CONFLICTS" | while IFS= read -r f; do
      git rm -f "$f" 2>/dev/null || true
    done
  fi

  # Keep our fork AGENTS.md and README.md
  FORK_CONFLICTS=$(echo "$UNMERGED" | grep -E "^(AGENTS\.md|README\.md)$" || true)
  if [ -n "$FORK_CONFLICTS" ]; then
    echo -e "${YELLOW}Auto-resolving AGENTS.md/README.md conflicts (keeping fork versions)...${RESET}"
    echo "$FORK_CONFLICTS" | while IFS= read -r f; do
      if [ -f "fork/$f" ]; then
        cp "fork/$f" "$f"
        git add "$f"
        echo -e "  ${GREEN}✓${RESET} restored $f from fork/"
      else
        git checkout --ours "$f" 2>/dev/null && git add "$f"
        echo -e "  ${GREEN}✓${RESET} kept our $f"
      fi
    done
  fi
fi

# Check remaining conflicts (after auto-resolving .github/)
REMAINING=$(git ls-files --unmerged | awk -F'\t' '{print $2}' | sort -u 2>/dev/null || true)
if [ -n "$REMAINING" ]; then
  print_conflict_help "$REMAINING"
  exit 1
fi

# If merge command itself failed but we resolved all conflicts, that's OK
if [ "$merge_failed" = true ] && [ -z "$REMAINING" ]; then
  merge_failed=false
fi

if [ "$merge_failed" = true ]; then
  echo -e "${RED}Merge failed before conflicts could be resolved automatically.${RESET}"
  echo -e "Check the repository state with ${CYAN}git status${RESET}."
  exit 1
fi

if git diff --staged --quiet 2>/dev/null && git diff --quiet 2>/dev/null; then
  echo -e "${DIM}Already up to date.${RESET}"
  restore_stash
  exit 0
fi

stage_fork_readme
remove_upstream_github_dir
remove_upstream_files
restore_root_agents
restore_git_hooks
update_models_snapshot

# Verify our files still exist
ALL_EXIST=true
for d in "${OUR_DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    echo -e "  ${RED}✗ Missing after merge: $d/${RESET}"
    ALL_EXIST=false
  fi
done
for f in "${OUR_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo -e "  ${RED}✗ Missing after merge: $f${RESET}"
    ALL_EXIST=false
  fi
done

if $ALL_EXIST; then
  echo -e "  ${GREEN}All custom files intact.${RESET}"
fi

# ─── Forked UserMessageComponent sync check ───────────────────────────────────
UPSTREAM_USER_MSG="packages/coding-agent/src/modes/interactive/components/user-message.ts"
FORK_USER_MSG="packages/coding-agent/src/modes/interactive/components/user-message.ts"
if ! diff -q <(git show "$UPSTREAM_BRANCH:$UPSTREAM_USER_MSG") "$FORK_USER_MSG" >/dev/null 2>&1; then
  echo ""
  echo -e "${YELLOW}${BOLD}⚠  Forked UserMessageComponent may need sync${RESET}"
  echo -e "${DIM}The upstream UserMessageComponent changed.${RESET}"
  echo -e "  Upstream: ${CYAN}$UPSTREAM_USER_MSG${RESET}"
  echo -e "  Fork:     ${CYAN}$FORK_USER_MSG${RESET}"
  echo -e ""
  echo -e "  Review differences:"
  echo -e "    ${DIM}diff <(git show $UPSTREAM_BRANCH:$UPSTREAM_USER_MSG) $FORK_USER_MSG${RESET}"
  echo -e ""
  echo -e "  To sync: apply upstream changes to the fork, then re-add custom padding"
  echo -e "  modifications. See ${CYAN}fork/AGENTS.md${RESET} for the expected update flow."
fi

echo ""
echo -e "${DIM}Building fork CLI...${RESET}"
bash fork/build.sh

git add -A
git commit --no-edit

PUSH_REMOTE=""
TRACKING_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$TRACKING_REF" ]; then
  PUSH_REMOTE="${TRACKING_REF%%/*}"
fi
if [ -z "$PUSH_REMOTE" ] && git remote get-url origin >/dev/null 2>&1; then
  PUSH_REMOTE="origin"
fi
if [ -z "$PUSH_REMOTE" ] && git remote get-url local >/dev/null 2>&1; then
  PUSH_REMOTE="local"
fi
if [ -z "$PUSH_REMOTE" ]; then
  echo -e "${RED}No push remote found. Push manually after review.${RESET}"
  restore_stash
  exit 1
fi

echo ""
echo -e "${DIM}Pushing ${LOCAL_BRANCH} to ${PUSH_REMOTE}...${RESET}"
if [ -n "$TRACKING_REF" ]; then
  git push
else
  git push -u "$PUSH_REMOTE" "$LOCAL_BRANCH"
fi

echo ""
echo -e "${GREEN}${BOLD}Sync complete!${RESET}"
echo ""
echo -e "  Upstream merged: ${CYAN}$UPSTREAM_BRANCH${RESET}"
echo -e "  Pushed branch:   ${CYAN}$PUSH_REMOTE/$LOCAL_BRANCH${RESET}"

restore_stash

echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo -e "  1. Verify branch:  ${CYAN}git log --oneline -3${RESET}"
echo -e "  2. Minimal TUI:    ${CYAN}fork/dist/pi-linux-x64/bin/pi --help${RESET}"
echo -e "  3. Review stash:   ${CYAN}git stash list | head${RESET}"
echo ""
