#!/bin/bash
set -e

# Install dependencies only if needed
if [ ! -d "node_modules/.pnpm" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Always rebuild frontend so source changes are picked up
echo "Building frontend..."
cd artifacts/shadow-garden
node ./node_modules/vite/bin/vite.js build --config vite.config.ts
cd ../..

# Always rebuild backend (copies new frontend into dist/public)
echo "Building backend..."
cd artifacts/api-server
node ./build.mjs
cd ../..

echo "Starting server..."
cd artifacts/api-server
node ./dist/index.mjs
