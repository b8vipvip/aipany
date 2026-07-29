#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_ROOT="${1:-}"
RELEASE_SHA="${2:-}"

if [[ -z "${DEPLOY_ROOT}" || -z "${RELEASE_SHA}" ]]; then
  echo "usage: deploy-ssh-release.sh <deploy-root> <release-sha>" >&2
  exit 64
fi

[[ "${DEPLOY_ROOT}" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "unsafe deploy root" >&2
  exit 64
}
[[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "release SHA must be a full 40-character Git commit" >&2
  exit 64
}

command -v docker >/dev/null 2>&1 || {
  echo "docker is not installed" >&2
  exit 69
}
docker compose version >/dev/null 2>&1 || {
  echo "docker compose plugin is not available" >&2
  exit 69
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is not installed" >&2
  exit 69
}
command -v flock >/dev/null 2>&1 || {
  echo "flock is not installed" >&2
  exit 69
}

STATE_DIR="${DEPLOY_ROOT}/.deploy"
INCOMING_DIR="${STATE_DIR}/incoming/${RELEASE_SHA}"
RELEASES_DIR="${STATE_DIR}/releases"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_SHA}"
CURRENT_SHA_FILE="${STATE_DIR}/current_sha"
PREVIOUS_SHA_FILE="${STATE_DIR}/previous_sha"
HISTORY_FILE="${STATE_DIR}/history.log"
ENV_FILE="${DEPLOY_ROOT}/.env"

mkdir -p "${STATE_DIR}/incoming" "${RELEASES_DIR}"
exec 9>"${STATE_DIR}/deploy.lock"
flock -w 900 9 || {
  echo "another Aipany deployment still holds the production lock" >&2
  exit 75
}

[[ -d "${INCOMING_DIR}" ]] || {
  echo "incoming release not found: ${INCOMING_DIR}" >&2
  exit 66
}
[[ -f "${INCOMING_DIR}/deploy/docker-compose.yml" ]] || {
  echo "incoming release has no deploy/docker-compose.yml" >&2
  exit 66
}
[[ -f "${ENV_FILE}" ]] || {
  echo "missing persistent environment file: ${ENV_FILE}" >&2
  exit 78
}

PREVIOUS_SHA=""
if [[ -f "${CURRENT_SHA_FILE}" ]]; then
  PREVIOUS_SHA="$(tr -d '[:space:]' < "${CURRENT_SHA_FILE}")"
fi

rm -rf "${RELEASE_DIR}"
mv "${INCOMING_DIR}" "${RELEASE_DIR}"
ln -sfn "${ENV_FILE}" "${RELEASE_DIR}/.env"

compose_for() {
  local release_dir="$1"
  docker compose \
    -p aipany \
    --env-file "${ENV_FILE}" \
    -f "${release_dir}/deploy/docker-compose.yml" \
    "${@:2}"
}

rollback_previous() {
  if [[ -z "${PREVIOUS_SHA}" || ! "${PREVIOUS_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "no valid previous release is available for rollback" >&2
    return 0
  fi

  local previous_dir="${RELEASES_DIR}/${PREVIOUS_SHA}"
  if [[ ! -f "${previous_dir}/deploy/docker-compose.yml" ]]; then
    echo "previous release directory is unavailable: ${previous_dir}" >&2
    return 0
  fi

  echo "rolling back containers to ${PREVIOUS_SHA}"
  ln -sfn "${ENV_FILE}" "${previous_dir}/.env"
  compose_for "${previous_dir}" up -d --build --remove-orphans || true
}

compose_for "${RELEASE_DIR}" config >/dev/null
compose_for "${RELEASE_DIR}" build

if ! compose_for "${RELEASE_DIR}" up -d --remove-orphans; then
  rollback_previous
  exit 1
fi

healthy=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:3000/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done

if (( healthy == 0 )); then
  echo "Aipany local health check failed after 300 seconds" >&2
  compose_for "${RELEASE_DIR}" ps || true
  rollback_previous
  exit 1
fi

if [[ -n "${PREVIOUS_SHA}" && "${PREVIOUS_SHA}" != "${RELEASE_SHA}" ]]; then
  printf '%s\n' "${PREVIOUS_SHA}" > "${PREVIOUS_SHA_FILE}"
fi
ln -sfn "${RELEASE_DIR}" "${DEPLOY_ROOT}/current"
printf '%s\n' "${RELEASE_SHA}" > "${CURRENT_SHA_FILE}"
printf '%s %s\n' "$(date -Is)" "${RELEASE_SHA}" >> "${HISTORY_FILE}"

mapfile -t OLD_RELEASES < <(
  find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@ %p\n' | sort -nr | awk 'NR > 5 {print $2}'
)
for old_release in "${OLD_RELEASES[@]:-}"; do
  [[ -n "${old_release}" ]] || continue
  [[ "${old_release}" == "${RELEASE_DIR}" ]] && continue
  [[ -n "${PREVIOUS_SHA}" && "${old_release}" == "${RELEASES_DIR}/${PREVIOUS_SHA}" ]] && continue
  rm -rf -- "${old_release}"
done

echo "Aipany release activated: ${RELEASE_SHA}"
compose_for "${RELEASE_DIR}" ps
