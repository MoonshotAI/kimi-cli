#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob

REPO_URL="${REPO_URL:-https://github.com/Open-Research-Development-Laboratories/kimi-cli-dev.git}"
SRC="${SRC:-$HOME/src/kimi-cli-dev}"
NODE_STREAM="${NODE_STREAM:-nodejs:24}"
RECLONE="${RECLONE:-0}"

# Default is conservative. Strict mode only prepares/removes user-installed RPMs if explicitly confirmed.
STRICT_PACKAGE_PURGE="${STRICT_PACKAGE_PURGE:-0}"
CONFIRM_STRICT_REMOVE="${CONFIRM_STRICT_REMOVE:-0}"

SNAP="${SNAP:-$HOME/kimi-clean-snapshots/$(date -u +%Y%m%dT%H%M%SZ)}"
PATH="$HOME/.local/bin:$PATH"

log() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$SNAP"

log "Snapshot package state: $SNAP"
rpm -qa | sort > "$SNAP/rpm-qa.before.txt" || true
dnf repoquery --userinstalled --qf '%{name}' | sort -u > "$SNAP/dnf-userinstalled.before.txt" || true
dnf history list > "$SNAP/dnf-history.before.txt" || true

# Minimal builder/runtime base for rebuilding kimi-cli from source.
# Keep system Python/DNF/RPM intact; uv will provide the project Python 3.14.
REQUIRED_RPMS=(
  ca-certificates
  curl
  wget
  git
  make
  tar
  gzip
  bzip2
  xz
  unzip
  zip
  which
  file
  patch
  diffutils
  findutils
  grep
  sed
  gawk
  rsync
  procps-ng
  util-linux

  dnf
  rpm
  python3
  python3-libs
  python3-dnf
  sudo
  openssh-clients
  redhat-release

  gcc
  gcc-c++
  glibc-devel
  binutils
  redhat-rpm-config
  pkgconf-pkg-config
  openssl-devel
  libffi-devel
  zlib-devel
  bzip2-devel
  xz-devel
  sqlite-devel
  readline-devel
  ncurses-devel
  tk-devel
  libuuid-devel
)

# Optional fallback for Python packages that lack wheels on your architecture/Python ABI.
OPTIONAL_RPMS=(
  rust
  cargo
)

log "Install/keep minimal builder RPMs"
sudo dnf -y install --setopt=install_weak_deps=False "${REQUIRED_RPMS[@]}"

log "Install Node/npm module stream: $NODE_STREAM"
sudo dnf -y module reset nodejs || true
sudo dnf -y module install "$NODE_STREAM"

log "Install optional Rust fallback toolchain if available"
sudo dnf -y install --setopt=install_weak_deps=False "${OPTIONAL_RPMS[@]}" || true

log "Mark required RPMs as user-installed so autoremove does not eat the builder"
sudo dnf -y mark install "${REQUIRED_RPMS[@]}" nodejs npm || true

log "Remove orphaned dependency RPMs and clean DNF metadata/package cache"
sudo dnf -y autoremove
sudo dnf -y clean all

log "Install/update uv and Python 3.14 under the build user"
if ! need uv; then
  curl --proto '=https' --tlsv1.2 -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

uv self update || true
uv python install 3.14

log "Validate Node version required by kimi-cli web/vis build"
node - <<'NODE'
const [maj, min] = process.versions.node.split(".").map(Number);
const ok = (maj === 20 && min >= 19) || (maj === 22 && min >= 12) || maj > 22;
if (!ok) {
  console.error(`Node ${process.version} is too old; need ^20.19.0 or >=22.12.0.`);
  process.exit(1);
}
console.log(`Node ${process.version} OK`);
NODE
npm --version

log "Clean project tree or reclone"
if [[ "$RECLONE" == "1" ]]; then
  rm -rf -- "$SRC"
fi

if [[ ! -d "$SRC/.git" ]]; then
  mkdir -p "$(dirname "$SRC")"
  git clone "$REPO_URL" "$SRC"
else
  git -C "$SRC" status --short > "$SNAP/git-status.before.txt" || true
  git -C "$SRC" clean -ndX > "$SNAP/git-clean-ignored-preview.txt" || true

  # Removes ignored build artifacts only: .venv, dist, build, node_modules, caches, generated static assets, etc.
  # It does not remove untracked source files unless they are ignored by .gitignore.
  git -C "$SRC" clean -fdX
fi

log "Clean Python/Node/global build caches"
uv cache clean || true
npm cache clean --force || true

rm -rf -- \
  "$HOME/.cache/pip" \
  "$HOME/.cache/pipx" \
  "$HOME/.cache/pypoetry" \
  "$HOME/.cache/pre-commit" \
  "$HOME/.cache/ruff" \
  "$HOME/.cache/pyright" \
  "$HOME/.cache/node-gyp" \
  "$HOME/.node-gyp" \
  "$HOME/.npm/_npx" \
  "$HOME/.npm/_cacache"

find "$SRC" -depth \( \
  -name "__pycache__" -o \
  -name ".pytest_cache" -o \
  -name ".ruff_cache" -o \
  -name ".mypy_cache" -o \
  -name ".pyright" \
  \) -exec rm -rf -- {} + 2>/dev/null || true

if [[ "$STRICT_PACKAGE_PURGE" == "1" ]]; then
  log "Prepare strict user-installed RPM removal candidate list"

  {
    printf '%s\n' "${REQUIRED_RPMS[@]}"
    printf '%s\n' nodejs npm
    printf '%s\n' "${OPTIONAL_RPMS[@]}"
  } | sort -u > "$SNAP/rpm-keep-builder.txt"

  dnf repoquery --userinstalled --qf '%{name}' | sort -u > "$SNAP/dnf-userinstalled.current.txt" || true

  comm -23 "$SNAP/dnf-userinstalled.current.txt" "$SNAP/rpm-keep-builder.txt" \
    | grep -Ev '^(NetworkManager|audit|authselect|basesystem|bash|chrony|coreutils|crypto-policies|dbus|dnf|dracut|filesystem|firewalld|glibc|grub2|kernel|lib.*|linux-firmware|lvm2|microcode_ctl|openssh|passwd|policycoreutils|python3|redhat|rpm|selinux|setup|shadow-utils|shim|sssd|subscription-manager|sudo|systemd|tuned|util-linux|xfsprogs)$' \
    > "$SNAP/rpm-remove-candidates.txt" || true

  if [[ -s "$SNAP/rpm-remove-candidates.txt" ]]; then
    log "Strict purge candidates written to $SNAP/rpm-remove-candidates.txt"
    xargs -r sudo dnf --assumeno remove < "$SNAP/rpm-remove-candidates.txt" | tee "$SNAP/dnf-strict-remove-dryrun.txt" || true

    if [[ "$CONFIRM_STRICT_REMOVE" == "1" ]]; then
      xargs -r sudo dnf -y remove < "$SNAP/rpm-remove-candidates.txt"
      sudo dnf -y autoremove
      sudo dnf -y clean all
    else
      echo "Review the dry-run first. To actually remove those RPMs, rerun with:"
      echo "STRICT_PACKAGE_PURGE=1 CONFIRM_STRICT_REMOVE=1 $0"
    fi
  else
    echo "No strict purge candidates."
  fi
fi

log "Done. Rebuild with:"
cat <<EOF
cd "$SRC"
make prepare
make build
make build-bin
EOF
