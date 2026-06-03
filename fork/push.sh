#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[90m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATE=$(date "+%Y-%m-%d %H:%M:%S")

# Sub-repos to push (must match fork/ directories that are git repos)
REPOS=(
    "pi-minimal"
    "pi-opencode-config-reader"
    "pi-ralph"
    "pi-telegram"
    "ralph"
)

echo -e "${CYAN}Pushing sub-repos...${RESET}"
echo ""

for repo in "${REPOS[@]}"; do
    REPO_DIR="$SCRIPT_DIR/$repo"
    
    if [ ! -d "$REPO_DIR/.git" ]; then
        echo -e "${YELLOW}Skipping $repo (not a git repo)${RESET}"
        continue
    fi
    
    cd "$REPO_DIR"
    
    # Check for changes
    if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
        echo -e "${DIM}$repo: no changes, skipping${RESET}"
        continue
    fi
    
    # Stage and commit
    git add -A
    git commit -m "$DATE"
    
    # Push
    echo -e "${DIM}Pushing $repo...${RESET}"
    git push origin main
    
    echo -e "${GREEN}✓ $repo pushed${RESET}"
done

echo ""
echo -e "${GREEN}${BOLD}Done!${RESET}"
