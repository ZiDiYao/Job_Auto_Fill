#!/bin/sh
set -eu

data_directory="${JOB_AUTOFILL_DATA_DIRECTORY:-/data}"
mkdir -p "$data_directory"

if [ ! -f "$data_directory/local-config.json" ]; then
  cp /app/backend/config/local-config.example.json "$data_directory/local-config.json"
fi

if [ ! -f "$data_directory/profile.json" ]; then
  cp /app/backend/data/profile.example.json "$data_directory/profile.json"
fi

exec node server.js
