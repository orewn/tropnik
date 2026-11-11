#!/usr/bin/env bash
set -euo pipefail

tropnik_runner_release() (
  # This installer belongs only to the pinned ubuntu-24.04 device runner.
  . /etc/os-release
  printf '%s:%s:%s\n' "$ID" "$VERSION_ID" "$VERSION_CODENAME"
)

tropnik_libpulse_available() {
  # Loading the SONAME also checks its transitive shared-library dependencies.
  python3 -c 'import ctypes; ctypes.CDLL("libpulse.so.0")'
}

tropnik_ubuntu_keyring_available() {
  [[ -r /usr/share/keyrings/ubuntu-archive-keyring.gpg ]]
}

tropnik_install_ci_libpulse() (
  set -euo pipefail
  if [[ "${GITHUB_ACTIONS:-}" != 'true' || "$(tropnik_runner_release)" != 'ubuntu:24.04:noble' ]]; then
    printf '%s\n' 'libpulse setup requires the Ubuntu 24.04 Noble GitHub Actions runner.' >&2
    exit 2
  fi
  if tropnik_libpulse_available 2>/dev/null; then
    printf '%s\n' 'libpulse.so.0 is already loadable; no package download is needed.'
    exit 0
  fi
  if ! tropnik_ubuntu_keyring_available; then
    printf '%s\n' 'The packaged Ubuntu archive signing keyring is missing.' >&2
    exit 1
  fi

  # The hosted mirror+file list repeatedly stalled on Azure DNS. Use official
  # Ubuntu sources only for these two commands, with separate indexes/cache.
  # Never rewrite the runner's repositories or reuse its stale mirror indexes.
  tropnik_apt="$(mktemp -d "${RUNNER_TEMP:?}/tropnik-libpulse.XXXXXX")"
  trap 'sudo rm -rf -- "$tropnik_apt"' EXIT
  chmod 755 "$tropnik_apt"
  mkdir -p "$tropnik_apt/lists/partial" "$tropnik_apt/archives/partial" "$tropnik_apt/sourceparts"
  cat > "$tropnik_apt/ubuntu.sources" <<'SOURCES'
Types: deb
URIs: https://archive.ubuntu.com/ubuntu
Suites: noble noble-updates
Components: main
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
  tropnik_apt_options=(
    -o "Dir::Etc::SourceList=$tropnik_apt/ubuntu.sources"
    -o "Dir::Etc::SourceParts=$tropnik_apt/sourceparts"
    -o "Dir::State::Lists=$tropnik_apt/lists"
    -o "Dir::Cache::Archives=$tropnik_apt/archives"
    -o Acquire::Retries=1
    -o Acquire::http::Timeout=15
    -o Acquire::https::Timeout=15
    -o Acquire::Languages=none
    -o Acquire::AllowInsecureRepositories=false
    -o APT::Get::AllowUnauthenticated=false
    -o Dpkg::Use-Pty=0
  )
  # Reject incomplete indexes, including transient DNS failures. The outer
  # caps include DNS/locks and leave room inside the existing five-minute step.
  sudo timeout --signal=TERM --kill-after=5s 90s apt-get "${tropnik_apt_options[@]}" update --error-on=any
  sudo timeout --signal=TERM --kill-after=5s 90s apt-get "${tropnik_apt_options[@]}" install --yes --no-install-recommends libpulse0
  tropnik_libpulse_available
  printf '%s\n' 'Verified that the installed libpulse.so.0 can be loaded.'
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  tropnik_install_ci_libpulse
fi
