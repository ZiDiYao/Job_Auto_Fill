#!/bin/zsh
set -euo pipefail

read -r -s "new_deepseek_key?Enter a NEW DeepSeek API key (input is hidden): "
echo

if [[ -z "$new_deepseek_key" ]]; then
  echo "No key entered." >&2
  exit 1
fi

security add-generic-password \
  -U \
  -a "${USER:-local-user}" \
  -s "local-job-autofill-deepseek" \
  -w "$new_deepseek_key" >/dev/null

unset new_deepseek_key
echo "DeepSeek key saved in macOS Keychain for Local Job Autofill."
