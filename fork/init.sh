#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pi Installer — works in two modes:
#   Local:   bash fork/init.sh          (inside pi repo, uses local binary)
#   Remote:  curl -fsSL <url> | bash    (standalone, downloads everything)
# =============================================================================

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

# Extension repos
PI_MINIMAL_REPO="https://github.com/iamcheyan/pi-minimal.git"
PI_OPENCODE_CONFIG_READER_REPO="https://github.com/iamcheyan/pi-opencode-config-reader.git"

# Upstream releases (for remote install)
UPSTREAM_REPO="earendil-works/pi"
UPSTREAM_API="https://api.github.com/repos/$UPSTREAM_REPO"

# =============================================================================
# Detect mode: local (inside pi repo) or remote (standalone)
# =============================================================================
IS_LOCAL=false
if [ -d "$REPO_DIR/.git" ] && [ -f "$REPO_DIR/package.json" ]; then
    IS_LOCAL=true
fi

# =============================================================================
# Platform detection (for remote install)
# =============================================================================
detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux)  PLATFORM_OS="linux" ;;
        Darwin) PLATFORM_OS="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM_OS="windows" ;;
        *) echo -e "${RED}Unsupported OS: $os${RESET}"; exit 1 ;;
    esac

    case "$arch" in
        x86_64|amd64)  PLATFORM_ARCH="x64" ;;
        aarch64|arm64) PLATFORM_ARCH="arm64" ;;
        *) echo -e "${RED}Unsupported arch: $arch${RESET}"; exit 1 ;;
    esac
}

# =============================================================================
# Resolve pi binary
# =============================================================================
resolve_pi_bin() {
    PI_BIN=""

    # 1. Local mode: use fork build
    if [ "$IS_LOCAL" = true ]; then
        local local_bin="$REPO_DIR/fork/dist/pi-${PLATFORM_OS:-darwin}-${PLATFORM_ARCH:-arm64}/bin/pi"
        if [ -f "$local_bin" ]; then
            PI_BIN="$local_bin"
            return
        fi
        # Fallback: any platform build
        PI_BIN=$(find "$REPO_DIR/fork/dist/" -path "*/bin/pi" -type f 2>/dev/null | head -1)
        if [ -n "$PI_BIN" ] && [ -x "$PI_BIN" ]; then
            return
        fi
    fi

    # 2. Check ~/.local/bin/pi (installed by this script)
    if [ -x "$HOME/.local/bin/pi" ]; then
        PI_BIN="$HOME/.local/bin/pi"
        return
    fi

    # 3. Check PATH
    PI_BIN=$(command -v pi 2>/dev/null || true)
    if [ -n "$PI_BIN" ]; then
        return
    fi

    # 4. Not found
    PI_BIN=""
}

# =============================================================================
# Install pi binary from upstream releases (remote mode only)
# =============================================================================
install_pi_binary() {
    echo ""
    echo -e "${BOLD}Installing pi binary...${RESET}"

    if [ -x "$HOME/.local/bin/pi" ]; then
        echo -e "  ${DIM}pi already installed at ~/.local/bin/pi, skipping${RESET}"
        echo -e "  ${DIM}Run with --force to reinstall${RESET}"
        return
    fi

    detect_platform

    echo -e "  ${DIM}Platform: ${PLATFORM_OS}-${PLATFORM_ARCH}${RESET}"

    # Get latest release tag
    local latest_tag
    latest_tag=$(curl -sL "$UPSTREAM_API/releases/latest" | python3 -c "
import json, sys
print(json.load(sys.stdin).get('tag_name', ''))
" 2>/dev/null || true)

    if [ -z "$latest_tag" ]; then
        echo -e "  ${YELLOW}⚠ could not determine latest release, using v0.77.0${RESET}"
        latest_tag="v0.77.0"
    fi

    local archive_name="pi-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.gz"
    local download_url="https://github.com/${UPSTREAM_REPO}/releases/download/${latest_tag}/${archive_name}"

    echo -e "  ${DIM}Downloading ${latest_tag} (${archive_name})...${RESET}"

    local tmpdir
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' RETURN

    if ! curl -fsSL "$download_url" -o "$tmpdir/$archive_name" 2>/dev/null; then
        echo -e "  ${RED}Failed to download pi binary${RESET}"
        echo -e "  ${DIM}URL: $download_url${RESET}"
        return 1
    fi

    echo -e "  ${DIM}Extracting...${RESET}"
    tar -xzf "$tmpdir/$archive_name" -C "$tmpdir"

    # The tarball extracts to pi/ directory — copy contents to ~/.local/bin/
    local pi_dir="$tmpdir/pi"
    if [ ! -d "$pi_dir" ]; then
        echo -e "  ${RED}Unexpected archive structure — no pi/ directory${RESET}"
        return 1
    fi

    mkdir -p "$HOME/.local/bin"
    # Copy all files from pi/ to ~/.local/bin/ (binary, package.json, wasm, etc.)
    cp "$pi_dir"/pi "$HOME/.local/bin/pi"
    cp "$pi_dir"/package.json "$HOME/.local/bin/package.json" 2>/dev/null || true
    cp "$pi_dir"/photon_rs_bg.wasm "$HOME/.local/bin/photon_rs_bg.wasm" 2>/dev/null || true
    chmod +x "$HOME/.local/bin/pi"

    echo -e "  ${GREEN}✓${RESET} pi ${latest_tag} installed → ~/.local/bin/pi"

    # Cleanup
    rm -rf "$tmpdir"
    trap - RETURN
}

# =============================================================================
# Main
# =============================================================================
echo -e "${BOLD}${CYAN}🥧 Pi Installer${RESET}"
if [ "$IS_LOCAL" = true ]; then
    echo -e "${DIM}Mode: local (inside pi repo)${RESET}"
else
    echo -e "${DIM}Mode: remote (standalone install)${RESET}"
fi
echo ""

# --- 1. Create directories ---
echo -e "${DIM}Creating directories...${RESET}"
mkdir -p ~/.pi/agent/extensions
mkdir -p ~/.pi/agent/agents
mkdir -p ~/.pi/agent/prompts
echo -e "  ${GREEN}✓${RESET} ~/.pi/agent/{extensions,agents,prompts}"

# --- 2. Install pi binary (remote mode only) ---
if [ "$IS_LOCAL" = false ]; then
    install_pi_binary
fi

# --- 3. Resolve pi binary for后续 npm installs ---
detect_platform 2>/dev/null || true
PLATFORM_OS="${PLATFORM_OS:-darwin}"
PLATFORM_ARCH="${PLATFORM_ARCH:-arm64}"
resolve_pi_bin

# --- 4. Install extensions ---
echo ""
echo -e "${BOLD}Installing extensions...${RESET}"

EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
THEMES_DIR="$HOME/.pi/agent/themes"
mkdir -p "$EXTENSIONS_DIR" "$THEMES_DIR"

# --- pi-minimal (extension + theme) ---
PI_MINIMAL_SRC="$SCRIPT_DIR/pi-minimal"

if [ "$IS_LOCAL" = true ] && [ -d "$PI_MINIMAL_SRC/.git" ]; then
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

if [ "$IS_LOCAL" = true ] && [ -d "$PI_OPENCODE_SRC/.git" ]; then
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

# --- 5. Create pi wrapper in PATH ---
echo ""
echo -e "${BOLD}Setting up pi in PATH...${RESET}"

WRAPPER_DIR="$HOME/.local/bin"

if [ "$IS_LOCAL" = true ]; then
    # Local mode: wrapper auto-detects repo binary
    WRAPPER="$WRAPPER_DIR/pi"

    if [ -f "$WRAPPER" ] && grep -q "PI_BIN_PATH" "$WRAPPER" 2>/dev/null; then
        echo -e "  ${DIM}wrapper already exists, skipping${RESET}"
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
else
    # Remote mode: binary is already at ~/.local/bin/pi
    echo -e "  ${GREEN}✓${RESET} pi binary at ~/.local/bin/pi"
fi

# Check PATH
if echo "$PATH" | tr ':' '\n' | grep -q "$WRAPPER_DIR"; then
    echo -e "  ${GREEN}✓${RESET} $WRAPPER_DIR is in PATH"
else
    echo -e "  ${YELLOW}⚠ $WRAPPER_DIR is NOT in PATH${RESET}"
    echo -e "  ${DIM}Add to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
fi

# Hint about PI_REPO (local mode only)
if [ "$IS_LOCAL" = true ] && [ -z "${PI_REPO:-}" ]; then
    echo ""
    echo -e "  ${DIM}Tip: export PI_REPO=\"\$HOME/Development/pi\" in ~/.zshrc${RESET}"
    echo -e "  ${DIM}    to avoid auto-detection overhead on startup.${RESET}"
fi

# --- 6. Remove old example symlinks ---
echo ""
echo -e "${BOLD}Cleaning up old example symlinks...${RESET}"

REMOVED=0
if [ -L ~/.pi/agent/extensions/subagent ]; then
    rm -rf ~/.pi/agent/extensions/subagent
    echo -e "  ${GREEN}✓${RESET} removed example symlink ~/.pi/agent/extensions/subagent"
    REMOVED=1
fi

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

# --- 7. Install npm packages ---
SETTINGS="$HOME/.pi/agent/settings.json"

install_pi_package() {
    local name="$1"
    local display="$2"

    echo ""
    echo -e "${BOLD}Installing ${display}...${RESET}"

    if [ -f "$SETTINGS" ] && grep -q "\"npm:${name}\"" "$SETTINGS" 2>/dev/null; then
        echo -e "  ${DIM}already installed, skipping${RESET}"
        return
    fi

    if [ -n "$PI_BIN" ] && [ -x "$PI_BIN" ]; then
        "$PI_BIN" install "npm:${name}"
        echo -e "  ${GREEN}✓${RESET} ${display} installed"
    else
        echo -e "  ${YELLOW}⚠ pi binary not found, skipping${RESET}"
        echo -e "  ${DIM}Run manually: pi install npm:${name}${RESET}"
    fi
}

install_pi_package "pi-subagents" "pi-subagents"
install_pi_package "pi-mcp-adapter" "pi-mcp-adapter"

# --- 8. Install context-mode (global npm + pi package + MCP config) ---
echo ""
echo -e "${BOLD}Installing context-mode...${RESET}"

# 8a. Global npm install
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

# 8b. Pi package install
if [ -f "$SETTINGS" ] && grep -q '"npm:context-mode"' "$SETTINGS" 2>/dev/null; then
    echo -e "  ${DIM}context-mode pi package already installed, skipping${RESET}"
else
    if [ -n "$PI_BIN" ] && [ -x "$PI_BIN" ]; then
        "$PI_BIN" install npm:context-mode
        echo -e "  ${GREEN}✓${RESET} context-mode pi package installed"
    else
        echo -e "  ${YELLOW}⚠ pi binary not found, skipping${RESET}"
        echo -e "  ${DIM}Run manually: pi install npm:context-mode${RESET}"
    fi
fi

# 8c. MCP server config
MCP_JSON="$HOME/.pi/agent/mcp.json"
if [ -f "$MCP_JSON" ] && grep -q '"context-mode"' "$MCP_JSON" 2>/dev/null; then
    echo -e "  ${DIM}context-mode MCP config already exists, skipping${RESET}"
else
    mkdir -p "$(dirname "$MCP_JSON")"
    if [ -f "$MCP_JSON" ]; then
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
if [ "$IS_LOCAL" = true ]; then
    echo -e "  Mode:        ${CYAN}local (inside pi repo)${RESET}"
else
    echo -e "  Mode:        ${CYAN}remote (standalone install)${RESET}"
    echo -e "  Pi binary:   ${CYAN}~/.local/bin/pi${RESET}"
fi
echo -e "  Extensions:  ${CYAN}~/.pi/agent/extensions/${RESET}"
echo -e "  Packages:    ${CYAN}pi-subagents, pi-mcp-adapter, context-mode${RESET}"
echo -e "  Subagents:   ${CYAN}/run, /chain, /parallel, /subagents-doctor${RESET}"
echo -e "  MCP:         ${CYAN}~/.pi/agent/mcp.json${RESET}"
echo -e "  Settings:    ${CYAN}~/.pi/agent/settings.json${RESET}"
echo ""
echo -e "  ${DIM}Extensions auto-load from ~/.pi/agent/extensions/ — no --extension flags needed.${RESET}"
echo -e "  ${DIM}Restart Pi to load all extensions and MCP servers.${RESET}"
echo ""
