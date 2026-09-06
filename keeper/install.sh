#!/usr/bin/env bash
# Installs the HoodSale launch keeper as a systemd service on a fresh Ubuntu 24.04 server.
#
#   scp contracts/keeper/install.sh root@<server>:/root/          (from the repository on your machine)
#   ssh root@<server> bash /root/install.sh
#
# The script creates an SSH deploy key on the server (the repository it clones may be private), prints its
# public half and waits until it has been added under the repository's Settings > Deploy keys
# (read-only). Then it clones the repository to /opt/hoodsale, installs Node 22, builds the
# contracts once (the compiler is downloaded), writes /etc/hoodsale/keeper.env from the example
# and starts the service. The keeper wallet's private key is typed into that file by hand; the
# script never asks for it.
set -euo pipefail

REPO_SSH="git@github.com:hoodsale/hoodsale.git"
APP_DIR="/opt/hoodsale"
ENV_DIR="/etc/hoodsale"
ENV_FILE="$ENV_DIR/keeper.env"
DEPLOY_KEY="/root/.ssh/hoodsale_deploy"
SERVICE="hoodsale-keeper"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates ufw unattended-upgrades

echo "== firewall (ssh only) and automatic security updates"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  echo "== 2 GB swap (the first contract build needs more memory than a 1 GB server has)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q "^/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo "== node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs
fi
echo "node $(node -v), npm $(npm -v)"

if ! id hoodsale >/dev/null 2>&1; then
  echo "== service user"
  useradd --system --create-home --home-dir /var/lib/hoodsale --shell /usr/sbin/nologin hoodsale
fi

if [ ! -f "$DEPLOY_KEY" ]; then
  echo "== deploy key"
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  ssh-keygen -t ed25519 -N "" -f "$DEPLOY_KEY" -C "hoodsale keeper $(hostname)" >/dev/null
fi
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"

if [ ! -d "$APP_DIR/.git" ]; then
  echo
  echo "Add this public key as a read-only deploy key of the repository"
  echo "(GitHub: hoodsale/hoodsale > Settings > Deploy keys > Add deploy key), then press Enter:"
  echo
  cat "$DEPLOY_KEY.pub"
  echo
  read -r -p "" _
  echo "== clone"
  git clone -q "$REPO_SSH" "$APP_DIR"
fi
chown -R hoodsale:hoodsale "$APP_DIR"

echo "== dependencies and a first build (downloads the Solidity compiler)"
sudo -u hoodsale -H bash -c "cd $APP_DIR/contracts && npm ci --no-audit --no-fund --loglevel=error && npx hardhat compile"

mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/contracts/keeper/keeper.env.example" "$ENV_FILE"
fi
chown root:hoodsale "$ENV_FILE"
chmod 640 "$ENV_FILE"

cp "$APP_DIR/contracts/keeper/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

if grep -q "^KEEPER_KEY=0x\.\.\." "$ENV_FILE"; then
  echo
  echo "Put the keeper wallet's private key into $ENV_FILE (KEEPER_KEY=0x...), then run:"
  echo "  systemctl start $SERVICE && journalctl -u $SERVICE -f"
else
  systemctl restart "$SERVICE"
  echo
  echo "Started. Logs: journalctl -u $SERVICE -f"
fi
