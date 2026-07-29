#!/usr/bin/env bash
# Run as root on a fresh Ubuntu 22.04 ARM64 server (Oracle Cloud A1.Flex).
# Sets up Docker, nginx, clones both service repos, and creates the database.
set -euo pipefail

echo "=== deskbusiness API server setup ==="

# ── System update ─────────────────────────────────────────────────────────────
apt-get update -q
apt-get upgrade -y -q

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker ubuntu
  echo "Docker installed."
else
  echo "Docker already present."
fi

# ── nginx ─────────────────────────────────────────────────────────────────────
apt-get install -y -q nginx
systemctl enable nginx

# ── App directory ─────────────────────────────────────────────────────────────
mkdir -p /opt/deskbusiness
cd /opt/deskbusiness

# ── Clone repos ───────────────────────────────────────────────────────────────
if [ ! -d compliance-os ]; then
  git clone https://github.com/mike43stone615/compliance-os.git
fi
if [ ! -d registry-api ]; then
  git clone https://github.com/mike43stone615/registry-api.git
fi

chown -R ubuntu:ubuntu /opt/deskbusiness

echo ""
echo "=== Setup complete. Next steps ==="
echo "1. Upload the SQL dump files from your Windows machine"
echo "2. Copy /opt/deskbusiness/compose.yml from the desk-api repo or create it"
echo "3. Run: cd /opt/deskbusiness && docker compose up -d"
echo "4. Import the database dumps"
