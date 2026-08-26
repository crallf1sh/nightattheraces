#!/bin/bash
# Double-click this file in Finder, or run it from Terminal.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required. Install it from https://nodejs.org/, then run this file again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Preparing Night at the Races for first use..."
  npm install
fi

open "http://localhost:3000/admin"
echo "Night at the Races is starting. Keep this window open while the event is running."
npm start
