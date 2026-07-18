#!/usr/bin/env bash
set -euo pipefail

# Resolve the real user's HOME directory even if run under sudo
REAL_HOME="${HOME}"
if [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
fi

# ---------------------------------------------------------------------------
# 0. Ensure a user-local npm prefix so we never need sudo and never collide
#    with a stale system install under /usr/lib/node_modules.
# ---------------------------------------------------------------------------
NPM_GLOBAL="$REAL_HOME/.npm-global"
mkdir -p "$NPM_GLOBAL"
npm config set prefix "$NPM_GLOBAL"
export PATH="$NPM_GLOBAL/bin:$PATH"

# ---------------------------------------------------------------------------
# 1. Ensure Node >= 22 via fnm (user-local, no sudo). pi-coding-agent@latest
#    requires Node 22; on Node 20 npm resolves the "legacy-node20" dist-tag
#    (0.74.x) which lacks the pi-ai/compat export that pi-subagents needs.
# ---------------------------------------------------------------------------
ensure_node_22() {
    local fnm_dir="$REAL_HOME/.fnm"
    local fnm_bin="$fnm_dir/fnm"
    if [ ! -x "$fnm_bin" ] && [ -x "$fnm_dir/bin/fnm" ]; then
        fnm_bin="$fnm_dir/bin/fnm"
    fi
    if [ ! -x "$fnm_bin" ]; then
        echo "fnm not found; installing fnm to $fnm_dir ..."
        curl -fsSL https://fnm.vercel.app/install | FNM_DIR="$fnm_dir" bash
        # The installer places the binary at $fnm_dir/fnm on Linux.
        [ -x "$fnm_dir/fnm" ] && fnm_bin="$fnm_dir/fnm"
    fi
    if [ -x "$fnm_bin" ]; then
        export FNM_DIR="$fnm_dir"
        export PATH="$fnm_dir:$PATH"
        eval "$("$fnm_bin" env --shell bash)"
        local major
        major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
        if [ "${major:-0}" -lt 22 ]; then
            echo "Node $(node --version 2>/dev/null || echo 'missing') < 22; installing Node 22 via fnm..."
            "$fnm_bin" install 22
            "$fnm_bin" use 22
            "$fnm_bin" default 22
        fi
        eval "$("$fnm_bin" env --shell bash)"
        echo "Using Node $(node --version) at $(command -v node)"
    else
        echo "Warning: fnm unavailable; relying on system node ($(node --version 2>/dev/null || echo 'missing')). pi-coding-agent@latest may not install."
    fi
}
ensure_node_22

# ---------------------------------------------------------------------------
# 2. Install official pi-coding-agent (latest) + pi-subagents into the
#    user-local prefix. @latest is explicit so npm never falls back to the
#    "legacy-node20" dist-tag.
# ---------------------------------------------------------------------------
echo "Installing @earendil-works/pi-coding-agent@latest and pi-subagents@latest..."
npm install -g @earendil-works/pi-coding-agent@latest pi-subagents@latest

# Recreate extension and theme directories
EXT_DIR="$REAL_HOME/.pi/agent/extensions"
THEMES_DIR="$REAL_HOME/.pi/agent/themes"
mkdir -p "$EXT_DIR"
mkdir -p "$THEMES_DIR"

# Get absolute path of this script directory
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to safely create symlink
link_plugin() {
    local src="$1"
    local dest="$2"
    if [ -e "$src" ]; then
        echo "Linking $dest -> $src"
        rm -f "$dest"
        ln -s "$src" "$dest"
        # Ensure the symlink is owned by the real user if run under sudo
        if [ -n "${SUDO_USER:-}" ]; then
            chown -h "$SUDO_USER:" "$dest"
        fi
    else
        echo "Warning: Source path $src does not exist, skipping."
    fi
}

# Function to find plugin entry point TS file
find_entry_point() {
    local dir="$1"
    local name="$2"
    
    # 1. Look for extensions/index.ts
    if [ -f "$dir/extensions/index.ts" ]; then
        echo "$dir/extensions/index.ts"
        return 0
    fi
    # 2. Look for index.ts
    if [ -f "$dir/index.ts" ]; then
        echo "$dir/index.ts"
        return 0
    fi
    # 3. Look for DIR.ts (without the "pi-" prefix, or with it)
    local base_name="${name#pi-}"
    if [ -f "$dir/${base_name}.ts" ]; then
        echo "$dir/${base_name}.ts"
        return 0
    fi
    if [ -f "$dir/${name}.ts" ]; then
        echo "$dir/${name}.ts"
        return 0
    fi
    # 4. Look for DIR-notify.ts or similar
    if [ -f "$dir/${base_name}-notify.ts" ]; then
        echo "$dir/${base_name}-notify.ts"
        return 0
    fi
    # 5. Look for any *.ts file that doesn't end with "bridge.ts" or "test.ts"
    local ts_files
    ts_files=$(find "$dir" -maxdepth 1 -name "*.ts" ! -name "*bridge.ts" ! -name "*test.ts" ! -name "*spec.ts" 2>/dev/null)
    if [ -n "$ts_files" ] && [ "$(echo "$ts_files" | wc -l)" -eq 1 ]; then
        echo "$ts_files"
        return 0
    fi
    
    return 1
}

echo "Scanning plugins directory..."
# Scan and link active plugins
if [ -d "$REPO_DIR/plugins" ]; then
    for dir in "$REPO_DIR/plugins"/*; do
        if [ -d "$dir" ]; then
            name=$(basename "$dir")
            
            # Find extension entry point
            entry_point=
            if entry_point=$(find_entry_point "$dir" "$name"); then
                echo "Found plugin: $name (Entry point: $entry_point)"
                
                # Install dependencies if present
                if [ -f "$dir/package.json" ]; then
                    echo "Installing dependencies for $name..."
                    (cd "$dir" && npm install --ignore-scripts)
                    if [ -n "${SUDO_USER:-}" ]; then
                        chown -R "$SUDO_USER:" "$dir/node_modules" 2>/dev/null || true
                    fi
                fi
                
                # Link extension
                link_plugin "$entry_point" "$EXT_DIR/${name}.ts"
                
                # Link themes if present
                if [ -d "$dir/themes" ]; then
                    for theme_file in "$dir/themes"/*.json; do
                        if [ -f "$theme_file" ]; then
                            theme_name=$(basename "$theme_file")
                            link_plugin "$theme_file" "$THEMES_DIR/$theme_name"
                        fi
                    done
                fi
            else
                echo "Warning: Could not find entry point for plugin $name, skipping link."
            fi
        fi
    done
fi

# Clean up stale symlinks pointing to deleted plugins
cleanup_stale_symlinks() {
    local dir="$1"
    if [ -d "$dir" ]; then
        for link in "$dir"/*; do
            if [ -L "$link" ]; then
                local target
                target=$(readlink "$link" || true)
                if [[ "$target" == "$REPO_DIR/plugins/"* ]]; then
                    if [ ! -e "$target" ]; then
                        echo "Cleaning up stale plugin link: $link"
                        rm -f "$link"
                    fi
                fi
            fi
        done
    fi
}

echo "Cleaning up any uninstalled plugin links..."
cleanup_stale_symlinks "$EXT_DIR"
cleanup_stale_symlinks "$THEMES_DIR"

# 4. Update the wrapper script to run the user-installed pi under fnm's
#    Node 22. Calling bare `pi` would resolve to a stale system install at
#    /usr/bin/pi (Node 20); the wrapper instead points at $NPM_GLOBAL/bin/pi
#    and activates fnm by direct path so it works even when fnm is not on
#    the caller's PATH (e.g. non-interactive shells, cron).
WRAPPER_DIR="$REAL_HOME/.pi/bin"
WRAPPER_PATH="$WRAPPER_DIR/pi"
FNM_DIR="$REAL_HOME/.fnm"
mkdir -p "$WRAPPER_DIR"
echo "Updating wrapper script at $WRAPPER_PATH..."
cat > "$WRAPPER_PATH" <<EOF
#!/bin/bash
# Wrapper that runs the user-installed pi-coding-agent from $NPM_GLOBAL
# under fnm's Node 22, avoiding the system Node 20 at /usr/bin/node which
# lacks APIs the latest pi-coding-agent needs.

export FNM_DIR="\${FNM_DIR:-$FNM_DIR}"
FNM_BIN="\$FNM_DIR/fnm"
if [ ! -x "\$FNM_BIN" ] && [ -x "\$FNM_DIR/bin/fnm" ]; then
    FNM_BIN="\$FNM_DIR/bin/fnm"
fi
if [ -x "\$FNM_BIN" ]; then
    eval "\$("\$FNM_BIN" env --shell bash)"
fi

exec "$NPM_GLOBAL/bin/pi" "\$@"
EOF
chmod +x "$WRAPPER_PATH"
if [ -n "${SUDO_USER:-}" ]; then
    chown "$SUDO_USER:" "$WRAPPER_PATH"
fi

# 5. Ensure the wrapper dir is on PATH for the current shell; hint to the
#    user if their shell rc hasn't been updated yet.
case ":${PATH}:" in
    *":$WRAPPER_DIR:"*) : ;;
    *)
        export PATH="$WRAPPER_DIR:$PATH"
        echo
        echo "NOTE: '$WRAPPER_DIR' is not on your PATH."
        echo "Add this line to your shell rc (~/.zshrc or ~/.bashrc):"
        echo "    export PATH=\"$WRAPPER_DIR:\$PATH\""
        echo
        ;;
esac

echo "Sync complete! You can now run 'pi'."
