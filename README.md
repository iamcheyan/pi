# pi-plugins

This repository is used to manage and version-control my custom plugins and configurations for `pi` (the Google DeepMind terminal coding agent).

It links custom plugins directly to the global `~/.pi/agent/extensions/` directory while running the official upstream version of the `pi` program.

## Structure

- `plugins/`: Custom plugins and tools (e.g. `pi-minimal`, `pi-ralph`, `pi-spawn`, `pi-telegram`, `pi-debug`, `pi-opencode-config-reader`).
- `setup.sh`: Installation script to set up the official binary and establish plugin links.

## Installation / Sync

Whenever you pull changes or set up a new computer, just run:

```bash
./setup.sh
```

This script will:
1. Install the official version of `pi` globally.
2. Link the plugins in this repository to `~/.pi/agent/extensions/`.
3. Set up the terminal wrapper script `~/.pi/bin/pi` so any existing aliases continue to work.
