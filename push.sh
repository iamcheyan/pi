#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[90m'
RESET='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

echo -e "${CYAN}=== Starting Full Push (${TIMESTAMP}) ===${RESET}"

# 1. Push Sub-repositories first using the fork/push.sh script
if [ -f "$ROOT_DIR/fork/push.sh" ]; then
    echo -e "${CYAN}Pushing sub-repositories...${RESET}"
    (bash "$ROOT_DIR/fork/push.sh")
else
    echo -e "${YELLOW}Warning: fork/push.sh not found, skipping sub-repos${RESET}"
fi

# 2. Push Main repository
echo -e "\n${CYAN}Pushing main repository...${RESET}"
cd "$ROOT_DIR"

# Check for changes in the main repo
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo -e "${DIM}Main repo: no changes to commit${RESET}"
else
    echo -e "${DIM}Main repo: committing changes...${RESET}"
    git add -A
    git commit -m "Auto-commit: ${TIMESTAMP}"
fi

echo -e "${DIM}Pushing main repo to remote...${RESET}"
git push origin main

echo -e "\n${GREEN}${BOLD}✓ All repositories successfully pushed!${RESET}"
