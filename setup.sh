#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# GREMLIN — Setup script
# Installs dependencies and builds to a single dist/index.html
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[gremlin]${NC} $*"; }
success() { echo -e "${GREEN}[gremlin]${NC} ✓ $*"; }
error()   { echo -e "${RED}[gremlin]${NC} ✖ $*"; exit 1; }

# ── 1. Check prerequisites ────────────────────────────────────────────────────
info "Checking prerequisites…"

command -v node >/dev/null 2>&1 || error "Node.js not found. Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || error "npm not found. Install from https://nodejs.org"

success "Node $(node --version)"
success "npm  $(npm --version)"

# ── 2. Install dependencies ───────────────────────────────────────────────────
info "Installing dependencies…"
cd web && npm install
success "Dependencies installed"

# ── 3. Build (single HTML file) ──────────────────────────────────────────────
info "Building…"
npm run build
success "Built"

# ── 4. Done ───────────────────────────────────────────────────────────────────
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
echo -e "${GREEN}│    cd web && npm run dev                             │${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────────┘${NC}"
