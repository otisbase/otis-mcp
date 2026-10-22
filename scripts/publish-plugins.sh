#!/usr/bin/env bash
# Publish the Otis plugin marketplace to github.com/otisbase/otis-plugins.
#
# The plugins/ folder is the marketplace repository: the Claude catalog (.claude-plugin/marketplace.json),
# the Codex catalog (.agents/plugins/marketplace.json), both plugin folders and a README. The ZIPs are not
# committed; they are attached to a GitHub release for Claude chat and Cowork uploads.
#
# Needs: gh signed in with rights to create repositories in the otisbase organization.
# This publishes publicly. Run it only after Stefan approves the release.
set -euo pipefail

repo="otisbase/otis-plugins"
description="Otis Plugins: the Otisbase MCP connection and billing skills for Claude and Codex"
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -e "console.log(require('$root/plugins/claude/otis/.claude-plugin/plugin.json').version)")"
tag="v$version"
message="${1:-Otis plugin $version}"

npm --prefix "$root" run --silent plugins:check
claude plugin validate "$root/plugins" >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rsync -a --exclude '*.zip' --exclude '.DS_Store' "$root/plugins/" "$work/"

if ! gh repo view "$repo" >/dev/null 2>&1; then
  gh repo create "$repo" --public --description "$description" --homepage "https://otisbase.com/connect"
fi

cd "$work"
git init -q -b main
git add -A
git commit -q -m "Otis plugin $version"
git remote add origin "https://github.com/$repo.git"
git fetch -q origin main 2>/dev/null && git reset -q --soft origin/main && git commit -q -m "$message" || true
git push -q origin main
git tag "$tag" 2>/dev/null || true
git push -q origin "$tag" 2>/dev/null || true

if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$repo" --title "Otis plugin $version" \
    --notes "Otis skills for Claude and Codex. Claude chat and Cowork: upload otis-claude-$version.zip under Customize, Plugins." \
    "$root/plugins/otis-claude-$version.zip" "$root/plugins/otis-codex-$version.zip"
fi
gh repo edit "$repo" --description "$description" --homepage "https://otisbase.com/connect" --add-topic mcp --add-topic mcp-server --add-topic claude-code --add-topic codex --add-topic invoicing --add-topic billing >/dev/null
echo "Published $repo $tag"
