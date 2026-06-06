#!/usr/bin/env bash
set -euo pipefail

# pi-mobile setup
# Installs: pi-mobile launcher to ~/.bin, systemd service, optional voice model (Parakeet)
# Usage: ./setup.sh          (interactive)
#        ./setup.sh --all    (install everything including voice)
#        ./setup.sh --no-voice  (skip voice setup)
#
# Optional env overrides for systemd install:
#   PI_MOBILE_HOST=127.0.0.1|100.x.x.x|0.0.0.0
#   PI_MOBILE_PORT=4317

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.bin"
VOICE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --all)      VOICE_FLAG="yes" ;;
    --no-voice) VOICE_FLAG="no" ;;
  esac
done

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*"; }

APT_UPDATED=""

resolve_bun_bin() {
  if command -v bun &>/dev/null; then
    command -v bun
    return 0
  fi

  local candidates=(
    "$HOME/.bun/bin/bun"
    "/root/.bun/bin/bun"
    "/usr/local/bin/bun"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

BUN_BIN="$(resolve_bun_bin || true)"

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo &>/dev/null; then
    sudo "$@"
  else
    return 127
  fi
}

install_system_packages() {
  local packages=("$@")
  [[ ${#packages[@]} -eq 0 ]] && return 0

  if command -v apt-get &>/dev/null; then
    if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo &>/dev/null; then
      warn "Need sudo/root to install system packages: ${packages[*]}"
      return 1
    fi
    if [[ -z "$APT_UPDATED" ]]; then
      info "Updating apt package index..."
      run_privileged apt-get update
      APT_UPDATED=1
    fi
    info "Installing system packages: ${packages[*]}"
    run_privileged apt-get install -y "${packages[@]}"
    return 0
  fi

  if command -v brew &>/dev/null; then
    info "Installing packages with Homebrew: ${packages[*]}"
    brew install "${packages[@]}"
    return 0
  fi

  warn "No supported package manager found to install: ${packages[*]}"
  return 1
}

ensure_fuzzy_search_tools() {
  local missing=()
  command -v fzf &>/dev/null || missing+=("fzf")
  command -v zoxide &>/dev/null || missing+=("zoxide")

  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "fzf found: $(fzf --version 2>/dev/null | head -n1 || echo 'installed')"
    ok "zoxide found: $(zoxide --version 2>/dev/null || echo 'installed')"
    return 0
  fi

  info "Installing fuzzy directory search tools: ${missing[*]}"
  install_system_packages "${missing[@]}" || {
    warn "Couldn't automatically install ${missing[*]} — directory search will fall back without them"
    return 1
  }

  if command -v fzf &>/dev/null; then
    ok "fzf found: $(fzf --version 2>/dev/null | head -n1 || echo 'installed')"
  else
    warn "fzf is still not in PATH"
  fi

  if command -v zoxide &>/dev/null; then
    ok "zoxide found: $(zoxide --version 2>/dev/null || echo 'installed')"
  else
    warn "zoxide is still not in PATH"
  fi
}

# ── 1. Check bun ─────────────────────────────────────────────────
if [[ -z "$BUN_BIN" ]]; then
  err "bun is required but not found. Install it: https://bun.sh"
  exit 1
fi
ok "bun found: $($BUN_BIN --version)"

require_npm() {
  if command -v npm &>/dev/null; then
    return 0
  fi

  err "npm is required because pi-mobile can load OMP from the global npm install"
  err "Install Node.js/npm, then rerun ./setup.sh"
  exit 1
}

resolve_npm_global_root() {
  npm root -g 2>/dev/null || true
}

ensure_global_npm_package() {
  local cmd="$1" pkg="$2" rel_dir="$3"
  local pkg_dir="$NPM_GLOBAL_ROOT/$rel_dir"

  if [[ -d "$pkg_dir" ]]; then
    if [[ -n "$cmd" ]] && command -v "$cmd" &>/dev/null; then
      ok "$pkg found globally: $pkg_dir ($("$cmd" --version 2>/dev/null | head -n1 || echo 'installed'))"
    else
      ok "$pkg found globally: $pkg_dir"
      if [[ -n "$cmd" ]]; then
        warn "$cmd is not currently in PATH — pi-mobile will still use the global package directly"
      fi
    fi
    return 0
  fi

  info "$pkg not found in global npm root — installing globally..."
  npm install -g "$pkg"

  if [[ ! -d "$pkg_dir" ]]; then
    err "$pkg install did not create $pkg_dir"
    return 1
  fi

  if [[ -n "$cmd" ]] && command -v "$cmd" &>/dev/null; then
    ok "$pkg installed globally: $pkg_dir ($("$cmd" --version 2>/dev/null | head -n1 || echo 'installed'))"
  else
    ok "$pkg installed globally: $pkg_dir"
    if [[ -n "$cmd" ]]; then
      warn "$cmd was installed but is not yet in PATH — restart your shell if you want the CLI command"
    fi
  fi
}

# ── 2. Check npm + global OMP package ─────────────────────────────
require_npm
NPM_GLOBAL_ROOT="$(resolve_npm_global_root)"
if [[ -z "$NPM_GLOBAL_ROOT" ]]; then
  err "Could not resolve npm global root (npm root -g)"
  exit 1
fi
ok "npm global root: $NPM_GLOBAL_ROOT"

ensure_global_npm_package omp @oh-my-pi/pi-coding-agent "@oh-my-pi/pi-coding-agent"
ensure_fuzzy_search_tools || true

# ── 3. Install deps ──────────────────────────────────────────────
info "Installing dependencies..."
cd "$SCRIPT_DIR"
"$BUN_BIN" install --frozen-lockfile 2>/dev/null || "$BUN_BIN" install
ok "Dependencies installed"

# ── 4. Create ~/.bin ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"

# ── 6. Create pi-mobile launcher ─────────────────────────────────
cat > "$BIN_DIR/pi-mobile" << 'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

PIMOBILE_DIR="${PIMOBILE_DIR:-__SCRIPT_DIR__}"

usage() {
  echo "Usage: pi-mobile [options]"
  echo ""
  echo "Options:"
  echo "  --host <ip>      Bind address (default: 127.0.0.1)"
  echo "  --port <port>    Port (default: 4317)"
  echo "  --token <tok>    Auth token for non-loopback"
  echo "  --help           Show this help"
  echo ""
  echo "Examples:"
  echo "  pi-mobile                              # localhost:4317"
  echo "  pi-mobile --host 0.0.0.0 --port 8080   # public"
  echo "  pi-mobile --host \$(tailscale ip -4)     # tailscale"
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$PIMOBILE_DIR"
exec __BUN_BIN__ src/server.ts "$@"
LAUNCHER

# Patch in the actual directory
sed -i "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" "$BIN_DIR/pi-mobile"
sed -i "s|__BUN_BIN__|$BUN_BIN|g" "$BIN_DIR/pi-mobile"
chmod +x "$BIN_DIR/pi-mobile"
ok "Installed pi-mobile launcher → $BIN_DIR/pi-mobile"

# ── 7. Install systemd service ────────────────────────────────────
install_systemd_service() {
  if ! command -v systemctl &>/dev/null; then
    warn "systemctl not found — skipping systemd service install"
    return 0
  fi

  local service_template="$SCRIPT_DIR/systemd/pi-mobile.service"
  if [[ ! -f "$service_template" ]]; then
    warn "Service template not found at $service_template"
    return 1
  fi

  local host="${PI_MOBILE_HOST:-}"
  if [[ -z "$host" ]] && command -v tailscale &>/dev/null; then
    host="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  fi
  if [[ -z "$host" ]]; then
    host="127.0.0.1"
  fi

  local port="${PI_MOBILE_PORT:-4317}"
  local bun_bin="$BUN_BIN"
  if [[ -z "$bun_bin" ]]; then
    warn "bun not found — skipping systemd service install"
    return 1
  fi

  local tmp_service
  tmp_service="$(mktemp)"
  sed \
    -e "s|__USER__|$USER|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__WORKDIR__|$SCRIPT_DIR|g" \
    -e "s|__BUN__|$bun_bin|g" \
    -e "s|__HOST__|$host|g" \
    -e "s|__PORT__|$port|g" \
    "$service_template" > "$tmp_service"

  if ! run_privileged install -D -m 0644 "$tmp_service" /etc/systemd/system/pi-mobile.service; then
    rm -f "$tmp_service"
    warn "Need sudo/root to install /etc/systemd/system/pi-mobile.service"
    return 1
  fi
  rm -f "$tmp_service"

  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now pi-mobile.service
  ok "Installed systemd service → /etc/systemd/system/pi-mobile.service"
  ok "Service enabled + started (host=$host port=$port)"
}

install_systemd_service || warn "Systemd service install failed — you can still run pi-mobile manually"

# ── 8. Add ~/.bin to PATH + shell hooks if needed ─────────────────
ensure_shell_line() {
  local shell_rc="$1"
  local match="$2"
  local line="$3"
  local description="$4"

  if [[ -f "$shell_rc" ]] && grep -qF "$match" "$shell_rc" 2>/dev/null; then
    return 0
  fi

  if [[ -f "$shell_rc" ]] || [[ "$shell_rc" == "$HOME/.bashrc" ]] || [[ "$shell_rc" == "$HOME/.zshrc" ]] || [[ "$shell_rc" == "$HOME/.profile" ]]; then
    echo "" >> "$shell_rc"
    echo "# pi-mobile" >> "$shell_rc"
    echo "$line" >> "$shell_rc"
    ok "Added $description to $(basename "$shell_rc")"
  fi
}

add_to_path() {
  ensure_shell_line "$1" '/.bin' 'export PATH="$HOME/.bin:$PATH"' '~/.bin to PATH'
}

add_zoxide_init() {
  local shell_rc="$1"
  local shell_name="$2"
  ensure_shell_line "$shell_rc" "zoxide init $shell_name" "eval \"\$(zoxide init $shell_name)\"" "zoxide init ($shell_name)"
}

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  # Detect shell and add to rc
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
    add_to_path "$HOME/.zshrc"
  fi
  if [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == */bash ]]; then
    add_to_path "$HOME/.bashrc"
  fi
  # Also add to .profile for login shells
  add_to_path "$HOME/.profile"
  export PATH="$BIN_DIR:$PATH"
  warn "Restart your shell or run: export PATH=\"\$HOME/.bin:\$PATH\""
else
  ok "~/.bin already in PATH"
fi

if command -v zoxide &>/dev/null; then
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
    add_zoxide_init "$HOME/.zshrc" "zsh"
  fi
  if [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == */bash ]]; then
    add_zoxide_init "$HOME/.bashrc" "bash"
  fi
  zoxide add "$HOME" 2>/dev/null || true
  zoxide add "$SCRIPT_DIR" 2>/dev/null || true
  ok "zoxide ready"
fi

# ── 9. Voice transcription (Parakeet) ────────────────────────────
PARAKEET_MODEL_DIR="$HOME/.local/share/parakeet-tdt-0.6b-v3-int8"
PARAKEET_URL="https://blob.handy.computer/parakeet-v3-int8.tar.gz"

install_voice() {
  info "Setting up voice transcription..."

  # Check ffmpeg (still needed for audio conversion)
  if ! command -v ffmpeg &>/dev/null; then
    warn "ffmpeg not found — voice transcription needs it for audio conversion"
    warn "Install with: sudo apt-get install -y ffmpeg  (or brew install ffmpeg)"
  else
    ok "ffmpeg found"
  fi

  # onnxruntime-node is already installed via bun install
  info "Voice uses native ONNX Runtime (already installed with dependencies)"

  # Download model if needed
  if [[ -d "$PARAKEET_MODEL_DIR" ]] && [[ -f "$PARAKEET_MODEL_DIR/nemo128.onnx" ]]; then
    ok "Parakeet model already exists at $PARAKEET_MODEL_DIR"
  else
    info "Downloading Parakeet model (~640MB)..."
    mkdir -p "$HOME/.local/share"
    curl -L --progress-bar "$PARAKEET_URL" -o /tmp/parakeet-v3-int8.tar.gz
    tar -xzf /tmp/parakeet-v3-int8.tar.gz -C "$HOME/.local/share"
    rm -f /tmp/parakeet-v3-int8.tar.gz
    ok "Parakeet model installed → $PARAKEET_MODEL_DIR"
  fi

  # Validate
  local all_good=true
  while IFS= read -r f; do
    if [[ ! -f "$PARAKEET_MODEL_DIR/$f" ]]; then
      err "Missing model file: $f"
      all_good=false
    fi
  done < "$SCRIPT_DIR/PARAKEET_MODEL_FILES.txt"
  $all_good && ok "All model files present"

  info "Voice is ready! First transcription will load models (~2-3s), then instant."
}

if [[ "$VOICE_FLAG" == "yes" ]]; then
  install_voice || warn "Voice setup failed — pi-mobile will work without it"
elif [[ "$VOICE_FLAG" == "no" ]]; then
  info "Skipping voice setup (--no-voice)"
else
  echo ""
  printf '\033[1m?\033[0m Install voice transcription (Parakeet, ~640MB download)? [y/N] '
  read -r answer
  if [[ "$answer" =~ ^[Yy] ]]; then
    install_voice || warn "Voice setup failed — pi-mobile will work without it"
  else
    info "Skipping voice — you can run ./setup.sh --all later"
  fi
fi

# ── 10. Summary ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "Setup complete!"
echo ""
echo "  Run:      pi-mobile"
echo "  Service:  sudo systemctl restart pi-mobile"
echo "  Logs:     journalctl -u pi-mobile -f"
echo "  Override: PI_MOBILE_HOST=127.0.0.1 PI_MOBILE_PORT=4317 ./setup.sh"
echo ""
if [[ ! -d "$PARAKEET_MODEL_DIR" ]] || [[ ! -f "$PARAKEET_MODEL_DIR/nemo128.onnx" ]]; then
  echo "  Voice: not installed (run ./setup.sh --all to add)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
