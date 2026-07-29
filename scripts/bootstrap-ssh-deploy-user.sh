#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "Run this bootstrap as root." >&2
  exit 77
fi

DEPLOY_USER="${AIPANY_DEPLOY_USER:-aipany-deploy}"
DEPLOY_ROOT="${AIPANY_DEPLOY_PATH:-/opt/aipany}"
SSH_PUBLIC_KEY="${AIPANY_DEPLOY_PUBLIC_KEY:-}"
SSH_HOST="${AIPANY_SSH_HOST:-}"
SSH_PORT="${AIPANY_SSH_PORT:-22}"

[[ "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  echo "AIPANY_DEPLOY_USER is invalid" >&2
  exit 64
}
[[ "${DEPLOY_ROOT}" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "AIPANY_DEPLOY_PATH must be a safe absolute path" >&2
  exit 64
}
[[ "${SSH_PORT}" =~ ^[0-9]{1,5}$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || {
  echo "AIPANY_SSH_PORT must be between 1 and 65535" >&2
  exit 64
}
[[ "${SSH_PUBLIC_KEY}" == ssh-ed25519\ * || "${SSH_PUBLIC_KEY}" == ssh-rsa\ * ]] || {
  echo "Set AIPANY_DEPLOY_PUBLIC_KEY to the dedicated SSH public key." >&2
  exit 64
}

command -v docker >/dev/null 2>&1 || {
  echo "Docker must be installed before running this bootstrap." >&2
  exit 69
}
docker compose version >/dev/null 2>&1 || {
  echo "The Docker Compose plugin must be installed." >&2
  exit 69
}

if ! command -v rsync >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y rsync
fi

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

getent group docker >/dev/null 2>&1 || groupadd docker
usermod -aG docker "${DEPLOY_USER}"

DEPLOY_HOME="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
touch "${DEPLOY_HOME}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh/authorized_keys"
chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"

if ! grep -Fqx "${SSH_PUBLIC_KEY}" "${DEPLOY_HOME}/.ssh/authorized_keys"; then
  printf '%s\n' "${SSH_PUBLIC_KEY}" >> "${DEPLOY_HOME}/.ssh/authorized_keys"
fi

install -d -m 750 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${DEPLOY_ROOT}" \
  "${DEPLOY_ROOT}/.deploy" \
  "${DEPLOY_ROOT}/.deploy/incoming" \
  "${DEPLOY_ROOT}/.deploy/releases"

chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_ROOT}"
if [[ -f "${DEPLOY_ROOT}/.env" ]]; then
  chmod 600 "${DEPLOY_ROOT}/.env"
else
  echo "WARNING: ${DEPLOY_ROOT}/.env does not exist yet; copy the production environment file before the first deployment." >&2
fi

sudo -u "${DEPLOY_USER}" docker version >/dev/null
sudo -u "${DEPLOY_USER}" docker compose version >/dev/null

echo "Deploy user ready: ${DEPLOY_USER}"
echo "Deploy root ready: ${DEPLOY_ROOT}"
echo "Authorized key installed."

if [[ -n "${SSH_HOST}" && -f /etc/ssh/ssh_host_ed25519_key.pub ]]; then
  HOST_KEY="$(awk '{print $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
  echo
  echo "Use the following exact value for GitHub secret AIPANY_SSH_HOST_KEY:"
  if [[ "${SSH_PORT}" == "22" ]]; then
    printf '%s %s\n' "${SSH_HOST}" "${HOST_KEY}"
  else
    printf '[%s]:%s %s\n' "${SSH_HOST}" "${SSH_PORT}" "${HOST_KEY}"
  fi
fi
