#!/usr/bin/env bash
# =====================================================================
# Everwake · prepare a fresh Ubuntu 24.04 server (Hostinger KVM) for n8n.
# Run once, as root:   bash setup-server.sh
# Then, after checking you can log in as "everwake" with your SSH key:
#                      bash setup-server.sh --lock-ssh
# Safe to run again: every step checks before it changes anything.
# =====================================================================
set -euo pipefail
APP_USER=everwake
APP_DIR=/opt/everwake
SWAP_GB=4

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash $0)"; exit 1; }

if [ "${1:-}" = "--lock-ssh" ]; then
  # WHY: most attacks on a server are bots guessing passwords over SSH. With
  # keys only and no root login, guessing is pointless. Only done once you have
  # proved the key login works, so you cannot lock yourself out.
  say "Locking SSH to keys only"
  if [ ! -s "/home/$APP_USER/.ssh/authorized_keys" ]; then
    echo "No SSH key for $APP_USER yet — add one first (see the guide). Nothing changed."; exit 1
  fi
  cat > /etc/ssh/sshd_config.d/10-everwake.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  sshd -t && systemctl reload ssh
  echo "Done. Keep this session open and test a NEW login as $APP_USER before closing it."
  exit 0
fi

say "1/8 System updates"
# WHY: start from a fully patched system; most break-ins use holes that already have a fix.
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -yq upgrade
apt-get -yq install ca-certificates curl gnupg ufw fail2ban unattended-upgrades cron rclone jq

say "2/8 Automatic security updates"
# WHY: security fixes install themselves every night, without you remembering to.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null

say "3/8 Swap (${SWAP_GB} GB)"
# WHY: if memory runs out for a moment (a busy Friday), the server slows down
# instead of killing processes. swappiness=10 keeps it a last resort, not a habit.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l ${SWAP_GB}G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-everwake.conf
sysctl -q --system

say "4/8 Firewall: only SSH, HTTP and HTTPS"
# WHY: nothing else on this server should be reachable from the internet —
# n8n and its database are only reachable through Caddy / Docker's private network.
# (Docker publishes only what docker-compose.yml lists: 80 and 443.)
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,12p'

say "5/8 fail2ban (blocks repeated failed SSH logins)"
# WHY: a bot that keeps failing to log in gets banned for a while.
systemctl enable --now fail2ban >/dev/null

say "6/8 Docker"
# WHY: every service runs in its own container with its own memory cap, so one
# misbehaving service cannot take the others down, and updating is one command.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -yq install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# WHY: container logs are capped (3 × 10 MB each) — logs filling the disk is a classic crash
mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
EOF
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

say "7/8 The everwake user"
# WHY: you work as a normal user, not root; a mistake or a stolen session can do less.
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER" >/dev/null
fi
usermod -aG sudo,docker "$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
if [ -s /root/.ssh/authorized_keys ] && [ ! -s "/home/$APP_USER/.ssh/authorized_keys" ]; then
  # the key you already log in with as root also works for everwake
  install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "/home/$APP_USER/.ssh/authorized_keys"
fi
echo "Set a password for $APP_USER (needed for sudo):"
passwd "$APP_USER" || true

say "8/8 The app folder"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$APP_DIR/backups"

say "Ready"
cat <<EOF
Next (as $APP_USER):
  1. Copy the deploy folder into $APP_DIR (see the guide).
  2. cd $APP_DIR && ./scripts/make-env.sh && nano .env
  3. docker compose up -d
When a NEW login as $APP_USER with your SSH key works:  sudo bash $APP_DIR/scripts/setup-server.sh --lock-ssh
EOF
