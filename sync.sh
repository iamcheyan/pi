#!/usr/bin/env bash
set -euo pipefail

# 1. Install official pi-coding-agent
echo "Checking global npm directory permissions..."
GLOBAL_ROOT=$(npm root -g)
if [ ! -w "$GLOBAL_ROOT" ] || [ ! -w "$(dirname "$GLOBAL_ROOT")" ]; then
    echo "Global npm directory ($GLOBAL_ROOT) is not writable. Installing with sudo..."
    sudo npm install -g @earendil-works/pi-coding-agent
else
    echo "Installing official @earendil-works/pi-coding-agent globally..."
    npm install -g @earendil-works/pi-coding-agent
fi

# Resolve the real user's HOME directory even if run under sudo
REAL_HOME="${HOME}"
if [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
fi

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

# 4. Update the wrapper script to run global pi
WRAPPER_PATH="$REAL_HOME/.pi/bin/pi"
if [ -f "$WRAPPER_PATH" ]; then
    echo "Updating wrapper script at $WRAPPER_PATH..."
    cat > "$WRAPPER_PATH" <<'EOF'
#!/bin/bash
exec pi "$@"
EOF
    chmod +x "$WRAPPER_PATH"
    if [ -n "${SUDO_USER:-}" ]; then
        chown "$SUDO_USER:" "$WRAPPER_PATH"
    fi
fi

echo "Sync complete! You can now run 'pi'."
