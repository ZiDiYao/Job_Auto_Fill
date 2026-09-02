#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$repository_root/manifest.json').version")
output_directory="$repository_root/dist"
output_file="$output_directory/job-autofill-extension-v$version.zip"
staging_directory=$(mktemp -d)

cleanup() {
  rm -rf "$staging_directory"
}
trap cleanup EXIT INT TERM

mkdir -p "$output_directory" "$staging_directory/exporters" "$staging_directory/icons" "$staging_directory/vendor"

for file in \
  manifest.json \
  background.js \
  content.js \
  auto-fill-watcher.js \
  popup.html popup.css popup.js \
  options.html options.css options.js \
  onboarding.html onboarding.css onboarding.js \
  privacy.html privacy-consent.js \
  application-export-service.js application-record.js \
  job-description-file.js job-notes.js local-directory.js notion-export.js \
  settings-autosave.mjs skills-preview.js
do
  cp "$repository_root/$file" "$staging_directory/$file"
done

cp "$repository_root"/exporters/*.js "$staging_directory/exporters/"
for size in 16 32 48 128
do
  cp "$repository_root/icons/icon-$size.png" "$staging_directory/icons/"
done
cp "$repository_root"/vendor/pdf.mjs "$repository_root"/vendor/pdf.worker.mjs \
  "$repository_root"/vendor/PDFJS-LICENSE.txt "$staging_directory/vendor/"

rm -f "$output_file"
(cd "$staging_directory" && zip -q -r "$output_file" .)
unzip -t "$output_file" >/dev/null

printf '%s\n' "$output_file"
