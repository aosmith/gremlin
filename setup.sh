#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# GREMLIN — Setup script
# Installs all dependencies and builds the project to a single dist/index.html
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[gremlin]${NC} $*"; }
success() { echo -e "${GREEN}[gremlin]${NC} ✓ $*"; }
warn()    { echo -e "${YELLOW}[gremlin]${NC} ⚠ $*"; }
error()   { echo -e "${RED}[gremlin]${NC} ✖ $*"; exit 1; }

# ── 1. Check prerequisites ────────────────────────────────────────────────────
info "Checking prerequisites…"

command -v cargo >/dev/null 2>&1 || error "Rust/Cargo not found. Install from https://rustup.rs"
command -v node  >/dev/null 2>&1 || error "Node.js not found. Install from https://nodejs.org"
command -v npm   >/dev/null 2>&1 || error "npm not found. Install from https://nodejs.org"

success "Rust $(rustc --version | cut -d' ' -f2)"
success "Node  $(node --version)"
success "npm   $(npm --version)"

# ── 2. Add wasm32 target ──────────────────────────────────────────────────────
info "Adding wasm32-unknown-unknown target…"
rustup target add wasm32-unknown-unknown
success "wasm32 target ready"

# ── 3. Install wasm-pack ──────────────────────────────────────────────────────
if ! command -v wasm-pack >/dev/null 2>&1; then
  info "Installing wasm-pack…"
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
  success "wasm-pack installed"
else
  success "wasm-pack $(wasm-pack --version)"
fi

# ── 4. Install Node dependencies ──────────────────────────────────────────────
info "Installing Node.js dependencies…"
cd web && npm install && cd ..
success "Node dependencies installed"

# ── 5. Build WASM with hardware acceleration ──────────────────────────────────
info "Building Rust WASM coordinator (with SIMD + bulk-memory)…"

# Enable WASM SIMD128 (supported in Chrome 91+, Firefox 89+, Safari 16.4+)
# and bulk-memory operations for maximum throughput.
export RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint"

wasm-pack build crates/coordinator \
  --target web \
  --out-dir "$(pwd)/web/src/wasm" \
  --release

success "WASM module built"

# ── 6. Encode WASM as base64 for single-file embedding ───────────────────────
info "Encoding WASM binary for single-file build…"
node web/scripts/encode-wasm.mjs
success "WASM encoded"

# ── 7. Build frontend (single HTML file) ─────────────────────────────────────
info "Building frontend…"
cd web && npm run build && cd ..
success "Frontend built"

# ── 8. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌─────────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  ⚡ GREMLIN built successfully!                      │${NC}"
echo -e "${GREEN}│                                                      │${NC}"
echo -e "${GREEN}│  Output: web/dist/index.html  (single HTML file)     │${NC}"
echo -e "${GREEN}│                                                      │${NC}"
echo -e "${GREEN}│  To run:                                             │${NC}"
echo -e "${GREEN}│    npx serve web/dist                                │${NC}"
echo -e "${GREEN}│    — or —                                            │${NC}"
echo -e "${GREEN}│    python3 -m http.server 3000 -d web/dist           │${NC}"
echo -e "${GREEN}│    — then open http://localhost:3000                 │${NC}"
echo -e "${GREEN}│                                                      │${NC}"
echo -e "${GREEN}│  For development (live reload):                      │${NC}"
echo -e "${GREEN}│    npm run dev                                       │${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────────┘${NC}"
