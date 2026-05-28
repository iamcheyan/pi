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
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pi binary (use fork build if available, otherwise system pi)
PI_BIN="$REPO_DIR/fork/dist/pi-darwin-arm64/bin/pi"
if [ ! -f "$PI_BIN" ]; then
    PI_BIN="pi"
fi

echo -e "${BOLD}${CYAN}Initializing Pi extensions...${RESET}"
echo ""

# =============================================================================
# 1. Create directories
# =============================================================================
echo -e "${DIM}Creating directories...${RESET}"
mkdir -p ~/.pi/agent/extensions
mkdir -p ~/.pi/agent/agents
mkdir -p ~/.pi/agent/prompts
echo -e "  ${GREEN}✓${RESET} ~/.pi/agent/{extensions,agents,prompts}"

# =============================================================================
# 2. Create pi wrapper in PATH (subagent child processes need a real executable)
# =============================================================================
echo ""
echo -e "${BOLD}Creating pi wrapper in PATH...${RESET}"

WRAPPER_DIR="$HOME/.local/bin"
WRAPPER="$WRAPPER_DIR/pi"

if [ -f "$WRAPPER" ] && grep -q "REPO_ROOT" "$WRAPPER" 2>/dev/null; then
    echo -e "  ${DIM}already exists, skipping${RESET}"
else
    mkdir -p "$WRAPPER_DIR"
    cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/bin/bash
# Auto-detect pi repo root
REPO_ROOT=""
for candidate in "$HOME/Development/pi" "$HOME/pi" "$HOME/repos/pi"; do
    if [ -d "$candidate/.git" ] && [ -f "$candidate/package.json" ]; then
        REPO_ROOT="$candidate"
        break
    fi
done

if [ -z "$REPO_ROOT" ]; then
    echo "Error: cannot find pi repo root" >&2
    exit 1
fi

exec "$REPO_ROOT/fork/dist/pi-darwin-arm64/bin/pi" \
  --extension "$REPO_ROOT/fork/pi-minimal/extensions/index.ts" \
  --extension "$REPO_ROOT/fork/pi-opencode-config-reader/opencode-config-reader.ts" \
  "$@"
WRAPPER_EOF
    chmod +x "$WRAPPER"
    echo -e "  ${GREEN}✓${RESET} created $WRAPPER"
fi

# Check PATH
if echo "$PATH" | tr ':' '\n' | grep -q "$WRAPPER_DIR"; then
    echo -e "  ${GREEN}✓${RESET} $WRAPPER_DIR is in PATH"
else
    echo -e "  ${YELLOW}⚠ $WRAPPER_DIR is NOT in PATH${RESET}"
    echo -e "  ${DIM}Add to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
fi

# =============================================================================
# 3. Remove old example symlinks (conflict with npm version)
# =============================================================================
echo ""
echo -e "${BOLD}Cleaning up old example symlinks...${RESET}"

REMOVED=0
if [ -L ~/.pi/agent/extensions/subagent ]; then
    rm -rf ~/.pi/agent/extensions/subagent
    echo -e "  ${GREEN}✓${RESET} removed example symlink ~/.pi/agent/extensions/subagent"
    REMOVED=1
fi

# Remove symlinked agents/prompts from example (npm version provides its own)
for f in ~/.pi/agent/agents/*.md; do
    [ -L "$f" ] || continue
    rm -f "$f"
    REMOVED=1
done
for f in ~/.pi/agent/prompts/*.md; do
    [ -L "$f" ] || continue
    rm -f "$f"
    REMOVED=1
done

if [ "$REMOVED" -eq 0 ]; then
    echo -e "  ${DIM}nothing to clean up${RESET}"
fi

# =============================================================================
# 4. Install pi-subagents (npm)
# =============================================================================
echo ""
echo -e "${BOLD}Installing pi-subagents...${RESET}"

SETTINGS="$HOME/.pi/agent/settings.json"
if [ -f "$SETTINGS" ] && grep -q '"npm:pi-subagents"' "$SETTINGS" 2>/dev/null; then
    echo -e "  ${DIM}already installed, skipping${RESET}"
else
    if [ -f "$PI_BIN" ]; then
        "$PI_BIN" install npm:pi-subagents
        echo -e "  ${GREEN}✓${RESET} pi-subagents installed"
    else
        echo -e "  ${YELLOW}⚠ pi binary not found, skipping${RESET}"
        echo -e "  ${DIM}Run manually: pi install npm:pi-subagents${RESET}"
    fi
fi

# =============================================================================
# 5. Install pi-mcp-adapter (npm)
# =============================================================================
echo ""
echo -e "${BOLD}Installing pi-mcp-adapter...${RESET}"

if [ -f "$SETTINGS" ] && grep -q '"npm:pi-mcp-adapter"' "$SETTINGS" 2>/dev/null; then
    echo -e "  ${DIM}already installed, skipping${RESET}"
else
    if [ -f "$PI_BIN" ]; then
        "$PI_BIN" install npm:pi-mcp-adapter
        echo -e "  ${GREEN}✓${RESET} pi-mcp-adapter installed"
    else
        echo -e "  ${YELLOW}⚠ pi binary not found, skipping${RESET}"
        echo -e "  ${DIM}Run manually: pi install npm:pi-mcp-adapter${RESET}"
    fi
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}${BOLD}Done!${RESET}"
echo ""
echo -e "  Subagents: ${CYAN}/run, /chain, /parallel, /subagents-doctor${RESET}"
echo -e "  Agents:    ${CYAN}scout, planner, reviewer, worker, oracle, researcher, ...${RESET}"
echo -e "  Settings:  ${CYAN}~/.pi/agent/settings.json${RESET}"
echo ""
echo -e "  ${DIM}Restart Pi to load extensions.${RESET}"
echo ""
