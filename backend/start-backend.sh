#!/bin/zsh
set -euo pipefail

backend_directory="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$backend_directory"
exec node server.js
