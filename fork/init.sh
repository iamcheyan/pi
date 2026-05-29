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

# Extension repos
PI_MINIMAL_REPO="https://github.com/iamcheyan/pi-minimal.git"
PI_OPENCODE_CONFIG_READER_REPO="https://github.com/iamcheyan/pi-opencode-config-reader.git"

# PI_REPO env var for different machines (set in ~/.zshrc or ~/.bashrc)
# export PI_REPO="$HOME/Development/pi"

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
# 2. Install extensions
#    - If source repos exist locally → symlink (edits in dev dir = live)
#    - Otherwise → clone from GitHub and copy
# =============================================================================
echo ""
echo -e "${BOLD}Installing extensions...${RESET}"

EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
THEMES_DIR="$HOME/.pi/agent/themes"
mkdir -p "$EXTENSIONS_DIR" "$THEMES_DIR"

# --- pi-minimal (extension + theme) ---
PI_MINIMAL_SRC="$SCRIPT_DIR/pi-minimal"

if [ -d "$PI_MINIMAL_SRC/.git" ]; then
    # Dev mode: symlink to local source
    ln -sfn "$PI_MINIMAL_SRC/extensions/index.ts" "$EXTENSIONS_DIR/pi-minimal.ts"
    echo -e "  ${GREEN}✓${RESET} pi-minimal → symlinked to $PI_MINIMAL_SRC"

    if [ -f "$PI_MINIMAL_SRC/themes/minimal.json" ]; then
        ln -sfn "$PI_MINIMAL_SRC/themes/minimal.json" "$THEMES_DIR/minimal.json"
        echo -e "  ${GREEN}✓${RESET} minimal theme → symlinked"
    fi
else
    # Remote mode: clone and copy
    echo -e "  ${DIM}cloning pi-minimal...${RESET}"
    TMPDIR_DL=$(mktemp -d)
    if git clone --depth 1 "$PI_MINIMAL_REPO" "$TMPDIR_DL/pi-minimal" 2>/dev/null; then
        cp "$TMPDIR_DL/pi-minimal/extensions/index.ts" "$EXTENSIONS_DIR/pi-minimal.ts"
        cp "$TMPDIR_DL/pi-minimal/themes/minimal.json" "$THEMES_DIR/minimal.json"
        echo -e "  ${GREEN}✓${RESET} pi-minimal → copied"
    else
        echo -e "  ${YELLOW}⚠ failed to clone pi-minimal, skipping${RESET}"
    fi
    rm -rf "$TMPDIR_DL"
fi

# --- pi-opencode-config-reader ---
PI_OPENCODE_SRC="$SCRIPT_DIR/pi-opencode-config-reader"

if [ -d "$PI_OPENCODE_SRC/.git" ]; then
    ln -sfn "$PI_OPENCODE_SRC/opencode-config-reader.ts" "$EXTENSIONS_DIR/opencode-config-reader.ts"
    echo -e "  ${GREEN}✓${RESET} pi-opencode-config-reader → symlinked to $PI_OPENCODE_SRC"
else
    echo -e "  ${DIM}cloning pi-opencode-config-reader...${RESET}"
    TMPDIR_DL=$(mktemp -d)
    if git clone --depth 1 "$PI_OPENCODE_CONFIG_READER_REPO" "$TMPDIR_DL/pi-opencode-config-reader" 2>/dev/null; then
        cp "$TMPDIR_DL/pi-opencode-config-reader/opencode-config-reader.ts" "$EXTENSIONS_DIR/opencode-config-reader.ts"
        echo -e "  ${GREEN}✓${RESET} pi-opencode-config-reader → copied"
    else
        echo -e "  ${YELLOW}⚠ failed to clone pi-opencode-config-reader, skipping${RESET}"
    fi
    rm -rf "$TMPDIR_DL"
fi

# =============================================================================
# 3. Create pi wrapper in PATH (subagent child processes need a real executable)
# =============================================================================
echo ""
echo -e "${BOLD}Creating pi wrapper in PATH...${RESET}"

WRAPPER_DIR="$HOME/.local/bin"
WRAPPER="$WRAPPER_DIR/pi"

if [ -f "$WRAPPER" ] && grep -q "PI_BIN_PATH" "$WRAPPER" 2>/dev/null; then
    echo -e "  ${DIM}already exists, skipping${RESET}"
else
    mkdir -p "$WRAPPER_DIR"
    cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/bin/bash
# Resolve pi binary: use PI_REPO env var, or auto-detect
PI_BIN_PATH=""

find_pi() {
    local root="$1"
    [ -d "$root/.git" ] || return 1
    local path
    path=$(find "$root/fork/dist/" -path "*/bin/pi" -type f 2>/dev/null | head -1)
    [ -n "$path" ] && [ -x "$path" ] && echo "$path"
}

if [ -n "${PI_REPO:-}" ]; then
    PI_BIN_PATH=$(find_pi "$PI_REPO" 2>/dev/null || true)
fi

if [ -z "$PI_BIN_PATH" ]; then
    for candidate in "$HOME/Development/pi" "$HOME/pi" "$HOME/repos/pi"; do
        PI_BIN_PATH=$(find_pi "$candidate" 2>/dev/null || true)
        [ -n "$PI_BIN_PATH" ] && break
    done
fi

# Fallback to system pi
if [ -z "$PI_BIN_PATH" ]; then
    PI_BIN_PATH=$(command -v pi 2>/dev/null || true)
fi

if [ -z "$PI_BIN_PATH" ]; then
    echo "Error: cannot find pi binary. Set PI_REPO or build first." >&2
    exit 1
fi

exec "$PI_BIN_PATH" "$@"
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

# Hint about PI_REPO
if [ -z "${PI_REPO:-}" ]; then
    echo ""
    echo -e "  ${DIM}Tip: export PI_REPO=\"\$HOME/Development/pi\" in ~/.zshrc${RESET}"
    echo -e "  ${DIM}    to avoid auto-detection overhead on startup.${RESET}"
fi

# =============================================================================
# 4. Remove old example symlinks (conflict with npm version)
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
# 5. Install pi-subagents (npm)
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
# 6. Install pi-mcp-adapter (npm)
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
# 7. Install context-mode (npm + MCP config)
# =============================================================================
echo ""
echo -e "${BOLD}Installing context-mode...${RESET}"

# 7a. Global npm install (needed for MCP server binary)
if command -v context-mode &>/dev/null; then
    echo -e "  ${DIM}context-mode binary already installed, skipping${RESET}"
else
    if command -v npm &>/dev/null; then
        npm install -g context-mode 2>/dev/null && \
            echo -e "  ${GREEN}✓${RESET} context-mode installed globally" || \
            echo -e "  ${YELLOW}⚠ failed to install context-mode globally${RESET}"
    else
        echo -e "  ${YELLOW}⚠ npm not found, skipping global install${RESET}"
        echo -e "  ${DIM}Run manually: npm install -g context-mode${RESET}"
    fi
fi

# 7b. Pi package install
if [ -f "$SETTINGS" ] && grep -q '"npm:context-mode"' "$SETTINGS" 2>/dev/null; then
    echo -e "  ${DIM}context-mode pi package already installed, skipping${RESET}"
else
    if [ -f "$PI_BIN" ]; then
        "$PI_BIN" install npm:context-mode
        echo -e "  ${GREEN}✓${RESET} context-mode pi package installed"
    else
        echo -e "  ${YELLOW}⚠ pi binary not found, skipping${RESET}"
        echo -e "  ${DIM}Run manually: pi install npm:context-mode${RESET}"
    fi
fi

# 7c. MCP server config
MCP_JSON="$HOME/.pi/agent/mcp.json"
if [ -f "$MCP_JSON" ] && grep -q '"context-mode"' "$MCP_JSON" 2>/dev/null; then
    echo -e "  ${DIM}context-mode MCP config already exists, skipping${RESET}"
else
    mkdir -p "$(dirname "$MCP_JSON")"
    if [ -f "$MCP_JSON" ]; then
        # Merge into existing config
        TMP_MCP=$(mktemp)
        if command -v node &>/dev/null; then
            node -e "
              const fs = require('fs');
              const cfg = JSON.parse(fs.readFileSync('$MCP_JSON','utf-8'));
              cfg.mcpServers = cfg.mcpServers || {};
              cfg.mcpServers['context-mode'] = { command: 'context-mode' };
              fs.writeFileSync('$TMP_MCP', JSON.stringify(cfg, null, 2));
            " 2>/dev/null && mv "$TMP_MCP" "$MCP_JSON"
        fi
    else
        cat > "$MCP_JSON" << 'MCP_EOF'
{
  "mcpServers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
MCP_EOF
    fi
    echo -e "  ${GREEN}✓${RESET} context-mode MCP config → $MCP_JSON"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}${BOLD}Done!${RESET}"
echo ""
echo -e "  Extensions:  ${CYAN}~/.pi/agent/extensions/${RESET}"
echo -e "  Packages:    ${CYAN}pi-subagents, pi-mcp-adapter, context-mode${RESET}"
echo -e "  Subagents:   ${CYAN}/run, /chain, /parallel, /subagents-doctor${RESET}"
echo -e "  MCP:         ${CYAN}~/.pi/agent/mcp.json${RESET}"
echo -e "  Settings:    ${CYAN}~/.pi/agent/settings.json${RESET}"
echo ""
echo -e "  ${DIM}Extensions auto-load from ~/.pi/agent/extensions/ — no --extension flags needed.${RESET}"
echo -e "  ${DIM}Restart Pi to load all extensions and MCP servers.${RESET}"
echo ""
