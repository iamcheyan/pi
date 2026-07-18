#!/usr/bin/env bash
set -euo pipefail

# 1. Install official pi-coding-agent
echo "Installing official @earendil-works/pi-coding-agent globally..."
npm install -g @earendil-works/pi-coding-agent

# 2. Recreate extension directory
EXT_DIR="$HOME/.pi/agent/extensions"
mkdir -p "$EXT_DIR"

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
    else
        echo "Warning: Source path $src does not exist, skipping."
    fi
}

# 3. Create symlinks for all plugins in the repo
link_plugin "$REPO_DIR/plugins/pi-minimal/extensions/index.ts" "$EXT_DIR/pi-minimal.ts"
link_plugin "$REPO_DIR/plugins/pi-opencode-config-reader/opencode-config-reader.ts" "$EXT_DIR/opencode-config-reader.ts"
link_plugin "$REPO_DIR/plugins/pi-debug/index.ts" "$EXT_DIR/pi-debug.ts"
link_plugin "$REPO_DIR/plugins/pi-ralph/index.ts" "$EXT_DIR/pi-ralph.ts"
link_plugin "$REPO_DIR/plugins/pi-spawn/index.ts" "$EXT_DIR/pi-spawn.ts"
link_plugin "$REPO_DIR/plugins/pi-telegram/telegram-notify.ts" "$EXT_DIR/telegram-notify.ts"

# 4. Update the wrapper script to run global pi
WRAPPER_PATH="$HOME/.pi/bin/pi"
if [ -f "$WRAPPER_PATH" ]; then
    echo "Updating wrapper script at $WRAPPER_PATH..."
    cat > "$WRAPPER_PATH" <<'EOF'
#!/bin/bash
exec pi "$@"
EOF
    chmod +x "$WRAPPER_PATH"
fi

echo "Setup complete! You can now run 'pi'."
