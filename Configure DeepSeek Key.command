#!/bin/zsh
set -euo pipefail

app_directory="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$app_directory/backend/configure-key.sh"
