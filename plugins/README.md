# Pi Coding Agent Plugins

This directory contains repository-local plugins for the `pi-coding-agent`.

## Plugin Management

Plugins in this directory are managed automatically by the root `sync.sh` script. You do not need to manually configure paths or link files.

- **To Install/Enable a plugin**: Place the plugin directory inside `plugins/` and run `./sync.sh` from the repository root.
- **To Uninstall/Disable a plugin**: Remove the plugin directory from `plugins/` and run `./sync.sh` from the repository root. Any stale global symlinks corresponding to deleted local plugins will be automatically cleaned up.

---

## Plugin Structure Conventions

To allow the `sync.sh` script to automatically discover and link plugins, your plugin directory should follow one of these entry point patterns (in order of resolution priority):

1. **Dedicated extensions folder**: `plugins/<plugin-name>/extensions/index.ts`
2. **Root index**: `plugins/<plugin-name>/index.ts`
3. **Named entry point**: `plugins/<plugin-name>/<plugin-name-without-pi-prefix>.ts` (e.g., `opencode-config-reader.ts` inside `pi-opencode-config-reader/`)
4. **Notify/Extension suffix**: `plugins/<plugin-name>/<name>-notify.ts` or `plugins/<plugin-name>/<name>-extension.ts` (e.g., `telegram-notify.ts` inside `pi-telegram/`)
5. **Single file fallback**: If there is exactly one `.ts` file inside the root of the plugin directory (excluding files ending with `bridge.ts`, `test.ts`, or `spec.ts`), it will be selected as the entry point.

### Dependencies
If your plugin folder contains a `package.json` file, `sync.sh` will automatically run `npm install --ignore-scripts` to install its node dependencies before linking.

### Themes
If your plugin folder contains a `themes/` directory, any `.json` file inside it (e.g., `themes/minimal.json`) will be automatically symlinked into the global theme directory (`~/.pi/agent/themes/`).
