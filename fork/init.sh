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

# Logging helpers
info()    { echo -e "${DIM}$1${RESET}"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; }
section() { echo -e "\n${BOLD}$1${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Extension repos
PI_MINIMAL_REPO="https://github.com/iamcheyan/pi-minimal.git"
PI_OPENCODE_CONFIG_READER_REPO="https://github.com/iamcheyan/pi-opencode-config-reader.git"
PI_RALPH_REPO="https://github.com/iamcheyan/pi-ralph.git"

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
# Check dependencies
# =============================================================================
check_dependencies() {
    local missing=()

    if ! command -v git &>/dev/null; then
        missing+=("git")
    fi

    if [ "$IS_LOCAL" = false ]; then
        # Remote mode needs curl and tar
        if ! command -v curl &>/dev/null; then
            missing+=("curl")
        fi
        if ! command -v tar &>/dev/null; then
            missing+=("tar")
        fi
        # Optional but useful
        if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
            warn "python3 not found — will use fallback for release detection"
        fi
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        fail "Missing required dependencies: ${missing[*]}"
        echo ""
        echo -e "  Install them first:"
        if command -v apt-get &>/dev/null; then
            echo -e "    ${DIM}sudo apt-get install ${missing[*]}${RESET}"
        elif command -v brew &>/dev/null; then
            echo -e "    ${DIM}brew install ${missing[*]}${RESET}"
        elif command -v yum &>/dev/null; then
            echo -e "    ${DIM}sudo yum install ${missing[*]}${RESET}"
        else
            echo -e "    ${DIM}Please install: ${missing[*]}${RESET}"
        fi
        exit 1
    fi
}

# =============================================================================
# Platform detection
# =============================================================================
detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux)  PLATFORM_OS="linux" ;;
        Darwin) PLATFORM_OS="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM_OS="windows" ;;
        *) fail "Unsupported OS: $os"; exit 1 ;;
    esac

    case "$arch" in
        x86_64|amd64)  PLATFORM_ARCH="x64" ;;
        aarch64|arm64) PLATFORM_ARCH="arm64" ;;
        *) fail "Unsupported architecture: $arch"; exit 1 ;;
    esac
}

# =============================================================================
# Resolve pi binary
# =============================================================================
resolve_pi_bin() {
    PI_BIN=""

    # 1. Local mode: use fork build
    if [ "$IS_LOCAL" = true ]; then
        # Try platform-specific build first
        local local_bin="$REPO_DIR/fork/dist/pi-${PLATFORM_OS:-darwin}-${PLATFORM_ARCH:-arm64}/bin/pi"
        if [ -f "$local_bin" ] && [ -x "$local_bin" ]; then
            PI_BIN="$local_bin"
            return 0
        fi

        # Fallback: any platform build
        PI_BIN=$(find "$REPO_DIR/fork/dist/" -path "*/bin/pi" -type f -executable 2>/dev/null | head -1)
        if [ -n "$PI_BIN" ]; then
            return 0
        fi

        # No binary found — try to build
        warn "No compiled pi binary found, attempting to build..."
        if [ -f "$REPO_DIR/fork/build.sh" ]; then
            echo ""
            if bash "$REPO_DIR/fork/build.sh"; then
                # Re-resolve after build
                PI_BIN=$(find "$REPO_DIR/fork/dist/" -path "*/bin/pi" -type f -executable 2>/dev/null | head -1)
                if [ -n "$PI_BIN" ]; then
                    ok "Build successful"
                    return 0
                fi
            fi
            fail "Build failed"
        else
            fail "build.sh not found"
        fi
        echo -e "    ${DIM}Manual build: cd $REPO_DIR && bash fork/build.sh${RESET}"
        PI_BIN=""
        return 1
    fi

    # 2. Check ~/.pi/bin/pi (installed by this script)
    if [ -x "$HOME/.pi/bin/pi" ]; then
        PI_BIN="$HOME/.pi/bin/pi"
        return 0
    fi

    # 3. Check PATH
    PI_BIN=$(command -v pi 2>/dev/null || true)
    if [ -n "$PI_BIN" ]; then
        return 0
    fi

    # 4. Not found
    PI_BIN=""
    return 1
}

# =============================================================================
# Install pi binary from upstream releases (remote mode only)
# =============================================================================
install_pi_binary() {
    section "Installing pi binary..."

    # Detect incomplete installation (binary exists but missing required files)
    if [ -x "$HOME/.pi/bin/pi" ]; then
        if [ -f "$HOME/.pi/bin/package.json" ] && [ -f "$HOME/.pi/bin/theme/dark.json" ]; then
            info "pi already installed at ~/.pi/bin/pi, skipping"
            return 0
        fi
        # Incomplete install — offer to clean up
        warn "pi binary found but installation is incomplete (missing theme/assets)"
        read -rp "  Clean up and reinstall? [Y/n] " choice < /dev/tty
        case "$choice" in
            [nN]|[nN][oO]) info "skipping cleanup" ;;
            *) rm -rf "$HOME/.pi/bin/pi" "$HOME/.pi/bin/package.json" \
                   "$HOME/.pi/bin/theme" "$HOME/.pi/bin/assets" \
                   "$HOME/.pi/bin/photon_rs_bg.wasm" "$HOME/.pi/bin/native" \
                   "$HOME/.pi/bin/export-html" 2>/dev/null
               ok "cleaned up incomplete installation" ;;
        esac
    fi

    detect_platform

    info "Platform: ${PLATFORM_OS}-${PLATFORM_ARCH}"

    # Get latest release tag
    local latest_tag=""
    if command -v python3 &>/dev/null; then
        latest_tag=$(curl -sL "$UPSTREAM_API/releases/latest" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('tag_name', ''))
except:
    print('')
" 2>/dev/null || true)
    elif command -v python &>/dev/null; then
        latest_tag=$(curl -sL "$UPSTREAM_API/releases/latest" | python -c "
import json, sys
try:
    print(json.load(sys.stdin).get('tag_name', ''))
except:
    print('')
" 2>/dev/null || true)
    elif command -v node &>/dev/null; then
        latest_tag=$(curl -sL "$UPSTREAM_API/releases/latest" | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
    try {
        const d = JSON.parse(chunks.join(''));
        console.log(d.tag_name || '');
    } catch {
        console.log('');
    }
});
" 2>/dev/null || true)
    fi

    if [ -z "$latest_tag" ]; then
        warn "Could not determine latest release, using v0.77.0"
        latest_tag="v0.77.0"
    fi

    local archive_name="pi-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.gz"
    local download_url="https://github.com/${UPSTREAM_REPO}/releases/download/${latest_tag}/${archive_name}"

    info "Downloading ${latest_tag} (${archive_name})..."

    local tmpdir
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' RETURN

    if ! curl -fsSL "$download_url" -o "$tmpdir/$archive_name" 2>/dev/null; then
        fail "Failed to download pi binary"
        echo -e "    ${DIM}URL: $download_url${RESET}"
        echo -e "    ${DIM}Check if this release exists for your platform${RESET}"
        return 1
    fi

    info "Extracting..."
    if ! tar -xzf "$tmpdir/$archive_name" -C "$tmpdir" 2>/dev/null; then
        fail "Failed to extract archive"
        return 1
    fi

    # The tarball extracts to pi/ directory — copy contents to ~/.pi/bin/
    local pi_dir="$tmpdir/pi"
    if [ ! -d "$pi_dir" ]; then
        fail "Unexpected archive structure — no pi/ directory found"
        return 1
    fi

    mkdir -p "$HOME/.pi/bin"
    # Copy everything — binary needs theme/, assets/, package.json, wasm, etc.
    cp -a "$pi_dir"/. "$HOME/.pi/bin/"
    chmod +x "$HOME/.pi/bin/pi"

    ok "pi ${latest_tag} installed → ~/.pi/bin/pi"

    # Cleanup
    rm -rf "$tmpdir"
    trap - RETURN
}

# =============================================================================
# Install extensions
# =============================================================================
install_extensions() {
    section "Installing extensions..."

    EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
    THEMES_DIR="$HOME/.pi/agent/themes"
    SKILLS_DIR="$HOME/.pi/agent/skills"
    mkdir -p "$EXTENSIONS_DIR" "$THEMES_DIR" "$SKILLS_DIR"

    # Helper: ensure a sub-repo is populated (clone if empty)
    ensure_subrepo() {
        local dir="$1"
        local repo_url="$2"
        local name="$3"

        # If directory exists but is empty (git pull didn't fetch sub-repos)
        if [ -d "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
            info "Sub-repo $name is empty, cloning..."
            if git clone --depth 1 "$repo_url" "$dir" 2>/dev/null; then
                ok "Cloned $name into $dir"
            else
                warn "Failed to clone $name"
                return 1
            fi
        fi
        return 0
    }

    # --- pi-minimal (extension + theme) ---
    local PI_MINIMAL_SRC="$SCRIPT_DIR/pi-minimal"
    ensure_subrepo "$PI_MINIMAL_SRC" "$PI_MINIMAL_REPO" "pi-minimal"

    if [ -d "$PI_MINIMAL_SRC/.git" ]; then
        # Has .git — symlink to local source
        ln -sfn "$PI_MINIMAL_SRC/extensions/index.ts" "$EXTENSIONS_DIR/pi-minimal.ts"
        ok "pi-minimal → symlinked"

        if [ -f "$PI_MINIMAL_SRC/themes/minimal.json" ]; then
            ln -sfn "$PI_MINIMAL_SRC/themes/minimal.json" "$THEMES_DIR/minimal.json"
            ok "minimal theme → symlinked"
        fi
    elif [ -f "$PI_MINIMAL_SRC/extensions/index.ts" ]; then
        # No .git but has files — copy
        cp "$PI_MINIMAL_SRC/extensions/index.ts" "$EXTENSIONS_DIR/pi-minimal.ts"
        cp "$PI_MINIMAL_SRC/themes/minimal.json" "$THEMES_DIR/minimal.json" 2>/dev/null || true
        ok "pi-minimal → copied"
    else
        warn "pi-minimal not available, skipping"
    fi

    # --- pi-opencode-config-reader ---
    local PI_OPENCODE_SRC="$SCRIPT_DIR/pi-opencode-config-reader"
    ensure_subrepo "$PI_OPENCODE_SRC" "$PI_OPENCODE_CONFIG_READER_REPO" "pi-opencode-config-reader"

    if [ -d "$PI_OPENCODE_SRC/.git" ]; then
        ln -sfn "$PI_OPENCODE_SRC/opencode-config-reader.ts" "$EXTENSIONS_DIR/opencode-config-reader.ts"
        ok "pi-opencode-config-reader → symlinked"
    elif [ -f "$PI_OPENCODE_SRC/opencode-config-reader.ts" ]; then
        cp "$PI_OPENCODE_SRC/opencode-config-reader.ts" "$EXTENSIONS_DIR/opencode-config-reader.ts"
        ok "pi-opencode-config-reader → copied"
    else
        warn "pi-opencode-config-reader not available, skipping"
    fi

    # --- pi-ralph (extension + skills) ---
    local PI_RALPH_SRC="$SCRIPT_DIR/pi-ralph"
    ensure_subrepo "$PI_RALPH_SRC" "$PI_RALPH_REPO" "pi-ralph"

    if [ -d "$PI_RALPH_SRC" ]; then
        ln -sfn "$PI_RALPH_SRC/index.ts" "$EXTENSIONS_DIR/pi-ralph.ts"
        ok "pi-ralph → symlinked"

        for skill_dir in "$PI_RALPH_SRC/skills"/*/; do
            local skill
            skill="$(basename "$skill_dir")"
            local src="$skill_dir/SKILL.md"
            if [ -f "$src" ]; then
                mkdir -p "$SKILLS_DIR/$skill"
                ln -sfn "$src" "$SKILLS_DIR/$skill/SKILL.md"
            fi
        done
        ok "ralph skills → symlinked"
    fi

    # --- pi-spawn (extension + agents) ---
    local PI_SPAWN_SRC="$SCRIPT_DIR/pi-spawn"

    if [ -d "$PI_SPAWN_SRC" ]; then
        ln -sfn "$PI_SPAWN_SRC/index.ts" "$EXTENSIONS_DIR/pi-spawn.ts"
        ok "pi-spawn → symlinked"

        # Copy agents if present
        if [ -d "$PI_SPAWN_SRC/agents" ]; then
            for agent_file in "$PI_SPAWN_SRC/agents"/*.md; do
                [ -f "$agent_file" ] || continue
                local agent_name
                agent_name="$(basename "$agent_file")"
                ln -sfn "$agent_file" "$HOME/.pi/agent/agents/$agent_name"
            done
            ok "pi-spawn agents → symlinked"
        fi
    fi

    # --- pi-debug (extension + skills) ---
    local PI_DEBUG_SRC="$SCRIPT_DIR/pi-debug"

    if [ -d "$PI_DEBUG_SRC" ]; then
        ln -sfn "$PI_DEBUG_SRC/index.ts" "$EXTENSIONS_DIR/pi-debug.ts"
        ok "pi-debug → symlinked"

        # Copy skills if present
        if [ -d "$PI_DEBUG_SRC/skills" ]; then
            for skill_dir in "$PI_DEBUG_SRC/skills"/*/; do
                local skill
                skill="$(basename "$skill_dir")"
                local src="$skill_dir/SKILL.md"
                if [ -f "$src" ]; then
                    mkdir -p "$SKILLS_DIR/$skill"
                    ln -sfn "$src" "$SKILLS_DIR/$skill/SKILL.md"
                fi
            done
            ok "pi-debug skills → symlinked"
        fi
    fi
}

# =============================================================================
# Setup pi wrapper in PATH
# =============================================================================
setup_pi_wrapper() {
    section "Setting up pi in PATH..."

    local WRAPPER_DIR="$HOME/.pi/bin"

    if [ "$IS_LOCAL" = true ]; then
        # Local mode: wrapper auto-detects repo binary
        local WRAPPER="$WRAPPER_DIR/pi"

        if [ -f "$WRAPPER" ] && grep -q "PI_BIN_PATH" "$WRAPPER" 2>/dev/null; then
            info "wrapper already exists, skipping"
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
    # Search common locations (case-insensitive for macOS/Linux)
    for candidate in "$HOME/Development/pi" "$HOME/development/pi" "$HOME/pi" "$HOME/repos/pi"; do
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
            ok "created $WRAPPER"
        fi
    else
        # Remote mode: binary is already at ~/.pi/bin/pi
        ok "pi binary at ~/.pi/bin/pi"
    fi

    # Check PATH
    if echo "$PATH" | tr ':' '\n' | grep -q "$WRAPPER_DIR"; then
        ok "$WRAPPER_DIR is in PATH"
    else
        warn "$WRAPPER_DIR is NOT in PATH"
        echo -e "    ${DIM}Add to ~/.zshrc or ~/.bashrc:${RESET}"
        echo -e "    ${DIM}export PATH=\"\$HOME/.pi/bin:\$PATH\"${RESET}"
    fi

    # Hint about PI_REPO (local mode only)
    if [ "$IS_LOCAL" = true ] && [ -z "${PI_REPO:-}" ]; then
        echo ""
        info "Tip: export PI_REPO=\"\$HOME/Development/pi\" in ~/.zshrc"
        info "    to avoid auto-detection overhead on startup."
    fi
}

# =============================================================================
# Clean up old example symlinks
# =============================================================================
cleanup_old() {
    section "Cleaning up old example symlinks..."

    local REMOVED=0
    if [ -L ~/.pi/agent/extensions/subagent ]; then
        rm -rf ~/.pi/agent/extensions/subagent
        ok "removed example symlink ~/.pi/agent/extensions/subagent"
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
        info "nothing to clean up"
    fi
}

# =============================================================================
# Install npm packages
# =============================================================================
install_pi_packages() {
    local SETTINGS="$HOME/.pi/agent/settings.json"

    install_pi_package() {
        local name="$1"
        local display="$2"

        echo ""
        echo -e "${BOLD}Installing ${display}...${RESET}"

        if [ -f "$SETTINGS" ] && grep -q "\"npm:${name}\"" "$SETTINGS" 2>/dev/null; then
            info "already installed, skipping"
            return 0
        fi

        if [ -n "$PI_BIN" ] && [ -x "$PI_BIN" ]; then
            if "$PI_BIN" install "npm:${name}" 2>/dev/null; then
                ok "${display} installed"
            else
                warn "Failed to install ${display}"
                echo -e "    ${DIM}Run manually: pi install npm:${name}${RESET}"
            fi
        else
            warn "pi binary not available, skipping ${display}"
            echo -e "    ${DIM}Run manually after building: pi install npm:${name}${RESET}"
        fi
    }

    install_pi_package "pi-subagents" "pi-subagents"
    install_pi_package "pi-mcp-adapter" "pi-mcp-adapter"
}

# =============================================================================
# Install context-mode
# =============================================================================
install_context_mode() {
    section "Installing context-mode..."

    local SETTINGS="$HOME/.pi/agent/settings.json"

    # 8a. Global npm install
    if command -v context-mode &>/dev/null; then
        info "context-mode binary already installed, skipping"
    else
        if command -v npm &>/dev/null; then
            # Try without sudo first
            if npm install -g context-mode 2>/dev/null; then
                ok "context-mode installed globally"
            else
                # Failed — likely needs sudo
                warn "Need sudo for global install"
                read -rp "  Install with sudo? [Y/n] " choice < /dev/tty
                case "$choice" in
                    [nN]|[nN][oO])
                        info "skipped — run manually: sudo npm install -g context-mode"
                        ;;
                    *)
                        if sudo npm install -g context-mode 2>/dev/null; then
                            ok "context-mode installed globally (sudo)"
                        else
                            fail "Failed to install context-mode"
                        fi
                        ;;
                esac
            fi
        else
            warn "npm not found, skipping global install"
            echo -e "    ${DIM}Install Node.js first, then run: npm install -g context-mode${RESET}"
        fi
    fi

    # 8b. Pi package install
    if [ -f "$SETTINGS" ] && grep -q '"npm:context-mode"' "$SETTINGS" 2>/dev/null; then
        info "context-mode pi package already installed, skipping"
    else
        if [ -n "$PI_BIN" ] && [ -x "$PI_BIN" ]; then
            "$PI_BIN" install npm:context-mode 2>/dev/null && ok "context-mode pi package installed" || warn "Failed to install context-mode pi package"
        else
            warn "pi binary not available, skipping context-mode pi package"
            echo -e "    ${DIM}Run manually: pi install npm:context-mode${RESET}"
        fi
    fi

    # 8c. MCP server config
    local MCP_JSON="$HOME/.pi/agent/mcp.json"
    if [ -f "$MCP_JSON" ] && grep -q '"context-mode"' "$MCP_JSON" 2>/dev/null; then
        info "context-mode MCP config already exists, skipping"
    else
        mkdir -p "$(dirname "$MCP_JSON")"
        if [ -f "$MCP_JSON" ]; then
            local TMP_MCP
            TMP_MCP=$(mktemp)
            if command -v node &>/dev/null; then
                node -e "
                  const fs = require('fs');
                  try {
                    const cfg = JSON.parse(fs.readFileSync('$MCP_JSON','utf-8'));
                    cfg.mcpServers = cfg.mcpServers || {};
                    cfg.mcpServers['context-mode'] = { command: 'context-mode' };
                    fs.writeFileSync('$TMP_MCP', JSON.stringify(cfg, null, 2));
                  } catch(e) {
                    process.exit(1);
                  }
                " 2>/dev/null && mv "$TMP_MCP" "$MCP_JSON" || {
                    warn "Failed to update MCP config"
                    rm -f "$TMP_MCP"
                }
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
        ok "context-mode MCP config → $MCP_JSON"
    fi
}

# =============================================================================
# Summary
# =============================================================================
print_summary() {
    echo ""
    echo -e "${GREEN}${BOLD}Installation complete!${RESET}"
    echo ""
    if [ "$IS_LOCAL" = true ]; then
        echo -e "  Mode:        ${CYAN}local (inside pi repo)${RESET}"
    else
        echo -e "  Mode:        ${CYAN}remote (standalone install)${RESET}"
        echo -e "  Pi binary:   ${CYAN}~/.pi/bin/pi${RESET}"
    fi
    echo -e "  Extensions:  ${CYAN}~/.pi/agent/extensions/${RESET}"
    echo -e "  Packages:    ${CYAN}pi-subagents, pi-mcp-adapter, context-mode${RESET}"
    echo -e "  Subagents:   ${CYAN}/run, /chain, /parallel, /subagents-doctor${RESET}"
    echo -e "  Ralph:       ${CYAN}/ralph${RESET}"
    echo -e "  MCP:         ${CYAN}~/.pi/agent/mcp.json${RESET}"
    echo -e "  Settings:    ${CYAN}~/.pi/agent/settings.json${RESET}"
    echo ""
    echo -e "  ${DIM}Extensions auto-load from ~/.pi/agent/extensions/ — no --extension flags needed.${RESET}"
    echo -e "  ${DIM}Restart Pi to load all extensions and MCP servers.${RESET}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo -e "${BOLD}${CYAN}🥧 Pi Installer${RESET}"
    if [ "$IS_LOCAL" = true ]; then
        echo -e "${DIM}Mode: local (inside pi repo)${RESET}"
    else
        echo -e "${DIM}Mode: remote (standalone install)${RESET}"
    fi

    # Check dependencies first
    check_dependencies

    # Create directories
    section "Creating directories..."
    mkdir -p ~/.pi/agent/{extensions,agents,prompts,skills}
    ok "~/.pi/agent/{extensions,agents,prompts,skills}"

    # Install pi binary (remote mode only)
    if [ "$IS_LOCAL" = false ]; then
        if ! install_pi_binary; then
            fail "Failed to install pi binary. Cannot continue."
            exit 1
        fi
    fi

    # Detect platform
    detect_platform 2>/dev/null || true
    PLATFORM_OS="${PLATFORM_OS:-darwin}"
    PLATFORM_ARCH="${PLATFORM_ARCH:-arm64}"

    # Resolve pi binary
    if ! resolve_pi_bin; then
        warn "pi binary not found — some steps will be skipped"
    fi

    # Install extensions
    install_extensions

    # Setup PATH wrapper
    setup_pi_wrapper

    # Clean up old files
    cleanup_old

    # Install npm packages
    install_pi_packages

    # Install context-mode
    install_context_mode

    # Print summary
    print_summary
}

# Run main
main "$@"
