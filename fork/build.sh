#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[90m'
RESET='\033[0m'

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CODING_AGENT_DIR="$ROOT_DIR/packages/coding-agent"
TUI_DIR="$ROOT_DIR/packages/tui"
AI_DIR="$ROOT_DIR/packages/ai"
AGENT_DIR="$ROOT_DIR/packages/agent"

# ─── Load nvm and use latest Node.js ────────────────────────────────────────
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    echo -e "${DIM}Loading nvm...${RESET}"
    
    # nvm.sh is often incompatible with set -u and set -e
    set +eu
    source "$NVM_DIR/nvm.sh"
    set -eu
    
    local latest_node
    # nvm ls can also be problematic with set -u
    set +u
    latest_node=$(nvm ls --no-colors 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1)
    set -u
    
    if [ -n "$latest_node" ]; then
      echo -e "${DIM}Using latest Node.js: $latest_node${RESET}"
      set +e
      nvm use "$latest_node" >/dev/null 2>&1
      set -e
    fi
  fi
}

# ─── nvm: load Bun ───────────────────────────────────────────────────────────
load_bun() {
  load_nvm
  
  if command -v bun &>/dev/null; then
    echo -e "${DIM}bun $(bun --version) found in PATH${RESET}"
    return
  fi

  echo -e "${YELLOW}bun not found. Installing bun...${RESET}"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command -v bun &>/dev/null; then
    echo -e "${RED}Failed to install bun. Please install manually: https://bun.sh${RESET}"
    exit 1
  fi
  echo -e "${GREEN}bun $(bun --version) installed${RESET}"
}

# ─── Platform detection ──────────────────────────────────────────────────────
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

  echo -e "${DIM}Target: bun-${PLATFORM_OS}-${PLATFORM_ARCH}${RESET}"
}

# ─── Build dependencies ──────────────────────────────────────────────────────
build_deps() {
  echo -e "${DIM}Building dependencies...${RESET}"
  
  cd "$ROOT_DIR"
  npm install --ignore-scripts
  
  # Build packages in order: tui -> ai -> agent -> coding-agent
  echo -e "${DIM}Building packages...${RESET}"
  npm run build
}

# ─── Build binary ────────────────────────────────────────────────────────────
build_binary() {
  local version
  # Prefer the clean version from package.json to avoid prerelease suffixes
  # (git describe produces e.g. 0.76.0-24-ge658bb04 which looks older than 0.76.0)
  version="$(cd "$ROOT_DIR" && node -e "console.log(JSON.parse(require('fs').readFileSync('packages/coding-agent/package.json','utf-8')).version || '0.0.0-dev')" 2>/dev/null || echo '0.0.0-dev')"
  
  local channel
  channel="$(cd "$ROOT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "local")"
  
  local package_dir="pi-${PLATFORM_OS}-${PLATFORM_ARCH}"
  local out_dir="$ROOT_DIR/fork/dist/$package_dir"
  local out_bin="$out_dir/bin/pi"
  
  rm -rf "$out_dir"
  mkdir -p "$out_dir/bin"
  
  echo -e "${DIM}Compiling pi binary for current platform...${RESET}"
  
  cd "$CODING_AGENT_DIR"
  
  # Build using bun compile
  BUILD_TARGET="bun-${PLATFORM_OS}-${PLATFORM_ARCH}" \
  BUILD_OUTFILE="$out_bin" \
  BUILD_VERSION="$version" \
  BUILD_CHANNEL="$channel" \
  bun build --compile \
    ./dist/bun/cli.js \
    ./src/utils/image-resize-worker.ts \
    --outfile "$out_bin"
  
  # Create package.json in both locations (root and bin)
  cat > "$out_dir/package.json" <<EOF
{
  "name": "$package_dir",
  "version": "$version",
  "private": true
}
EOF
  cp "$out_dir/package.json" "$out_dir/bin/package.json"
  
  # Copy assets to bin directory (where binary expects them)
  mkdir -p "$out_dir/bin/theme"
  cp src/modes/interactive/theme/*.json "$out_dir/bin/theme/" 2>/dev/null || true
  mkdir -p "$out_dir/bin/assets"
  cp src/modes/interactive/assets/*.png "$out_dir/bin/assets/" 2>/dev/null || true
  
  # Copy docs and examples to root
  cp -r dist/docs "$out_dir/" 2>/dev/null || true
  cp -r dist/examples "$out_dir/" 2>/dev/null || true
  cp dist/CHANGELOG.md "$out_dir/" 2>/dev/null || true
  
  echo -e "${GREEN}Binary built: $out_bin${RESET}"
}

# ─── Smoke test ──────────────────────────────────────────────────────────────
smoke_test() {
  local entrypoint="$1"

  if "$entrypoint" --version &>/dev/null; then
    echo -e "${GREEN}Smoke test passed${RESET}"
    echo ""
    echo -e "${DIM}Starting pi...${RESET}"
    exec "$entrypoint"
  else
    echo -e "${YELLOW}Warning: smoke test failed${RESET}"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}${CYAN}Building pi binaries${RESET}"
  echo ""
  
  load_bun
  detect_platform
  build_deps
  build_binary
  
  local package_dir="pi-${PLATFORM_OS}-${PLATFORM_ARCH}"
  local out_bin="$ROOT_DIR/fork/dist/$package_dir/bin/pi"
  
  echo -e "${DIM}Running smoke test...${RESET}"
  smoke_test "$out_bin"
  
  echo ""
  echo -e "${GREEN}${BOLD}Build complete!${RESET}"
  echo ""
  echo -e "  Binary: ${CYAN}$out_bin${RESET}"
}

main "$@"
