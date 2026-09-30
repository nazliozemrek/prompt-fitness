#!/usr/bin/env bash
# Publishes the web dashboard to GitHub Pages: builds, runs the privacy gate, and pushes
# the site files to the gh-pages branch. main is never touched.
#   https://nazliozemrek.github.io/prompt-fitness/
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npm run check:privacy

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
cp dist/index.html dist/app.js dist/styles.css dist/favicon.png "$OUT/"
touch "$OUT/.nojekyll"   # serve files as-is, no Jekyll processing

git -C "$OUT" init -q -b gh-pages
git -C "$OUT" add -A
git -C "$OUT" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
  commit -q -m "Deploy web dashboard from $(git rev-parse --short HEAD)"
# gh-pages holds only the latest build, so it's replaced on every deploy.
git -C "$OUT" push -q --force "$(git remote get-url origin)" gh-pages
echo "✓ Deployed to gh-pages. Live in about a minute at https://nazliozemrek.github.io/prompt-fitness/"
