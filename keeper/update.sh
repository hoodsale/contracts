#!/usr/bin/env bash
# Pulls the latest main, reinstalls the dependencies, rebuilds and restarts the keeper service.
#   bash /opt/hoodsale/contracts/keeper/update.sh
set -euo pipefail
APP_DIR="/opt/hoodsale"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/hoodsale_deploy -o IdentitiesOnly=yes"
cd "$APP_DIR"
git fetch -q origin main
git reset -q --hard origin/main
chown -R hoodsale:hoodsale "$APP_DIR"
sudo -u hoodsale -H bash -c "cd $APP_DIR/contracts && npm ci --no-audit --no-fund --loglevel=error && npx hardhat compile"
systemctl restart hoodsale-keeper
echo "updated to $(git rev-parse --short HEAD); logs: journalctl -u hoodsale-keeper -f"
