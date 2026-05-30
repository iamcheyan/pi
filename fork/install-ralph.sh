#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# pi-ralph installer — standalone, does not modify init.sh
#
# Usage: bash fork/install-ralph.sh
#
# Installs:
#   1. Extension → ~/.pi/agent/extensions/pi-ralph.ts (symlink)
#   2. Skills    → ~/.pi/agent/skills/{prd,ralph,ralph-worker,ralph-wizard} (symlinks)
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[90m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RALPH_SRC="$SCRIPT_DIR/pi-ralph"
EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
SKILLS_DIR="$HOME/.pi/agent/skills"

echo -e "${BOLD}${CYAN}Installing pi-ralph...${RESET}"

# --- Validate source ---
if [ ! -d "$RALPH_SRC" ]; then
    echo -e "${RED}Error: pi-ralph not found at $RALPH_SRC${RESET}"
    exit 1
fi

# --- Install extension ---
mkdir -p "$EXTENSIONS_DIR"
ln -sfn "$RALPH_SRC/index.ts" "$EXTENSIONS_DIR/pi-ralph.ts"
echo -e "  ${GREEN}✓${RESET} extension → $EXTENSIONS_DIR/pi-ralph.ts"

# --- Install skills ---
for skill in prd ralph ralph-worker ralph-wizard; do
    src="$RALPH_SRC/skills/$skill/SKILL.md"
    if [ -f "$src" ]; then
        mkdir -p "$SKILLS_DIR/$skill"
        ln -sfn "$src" "$SKILLS_DIR/$skill/SKILL.md"
        echo -e "  ${GREEN}✓${RESET} skill/$skill → $SKILLS_DIR/$skill/SKILL.md"
    else
        echo -e "  ${YELLOW}⚠ $skill not found, skipping${RESET}"
    fi
done

echo ""
echo -e "${GREEN}${BOLD}pi-ralph installed!${RESET}"
echo ""
echo -e "  Restart pi to load the extension."
echo -e "  Then run:  ${CYAN}/ralph${RESET}  to get started."
echo ""
