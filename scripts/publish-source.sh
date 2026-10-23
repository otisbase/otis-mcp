#!/usr/bin/env bash
# Publish the Otis source code to github.com/otisbase/otis-mcp.
#
# The public repository is the MCP service Worker only: an allowlisted copy of its code, tests, scripts,
# config and service spec (spec/01-05), with the files in open-source/ (README, CONTRIBUTING, SECURITY,
# LICENSE and a public spec guide) laid over it. The website Worker (site/), its design spec (spec/06),
# decisions.md, CURRENT.md, reports/, the original brief, the agent house rules and plugins/ stay private.
#
# Needs: gh signed in with rights to create repositories in the otisbase organization.
# This publishes publicly. Run it only after Stefan approves the release.
set -euo pipefail

repo="otisbase/otis-mcp"
description="Otis MCP: the open-source MCP server behind Otisbase, free client billing for AI assistants"
root="$(cd "$(dirname "$0")/.." && pwd)"
message="${1:-Update Otis source}"
include=(src test scripts server.json spec/01-README.md spec/02-product.md spec/03-records-and-billing.md spec/04-service.md spec/05-tax-guidance.md package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc worker-configuration.d.ts .gitignore)

npm --prefix "$root" run --silent check
npm --prefix "$root" test --silent >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$root" && for path in "${include[@]}"; do rsync -aR --exclude '.DS_Store' "./$path" "$work/"; done)
rsync -a "$root/open-source/" "$work/"
# The website's npm scripts point at site/, which is not published.
node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));for(const k of Object.keys(p.scripts))if(k.startsWith("site:"))delete p.scripts[k];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$work/package.json"
if [ -e "$work/site" ] || grep -rIl -- 'src/site/\|site/src/' "$work/src" "$work/test" >/dev/null 2>&1; then
  echo "Website code found in the export; nothing was published." >&2
  exit 1
fi
printf '\n# Local QA output and generated plugin packages.\n/reports/\n/plugins/\n' >> "$work/.gitignore"

if grep -rIlE -- '-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[abp]-' "$work"; then
  echo "Possible secret found in the files above; nothing was published." >&2
  exit 1
fi

if ! gh repo view "$repo" >/dev/null 2>&1; then
  gh repo create "$repo" --public --description "$description" --homepage "https://otisbase.com/docs"
fi

cd "$work"
git init -q -b main
git add -A
git commit -q -m "$message"
git remote add origin "https://github.com/$repo.git"
if [ "${FRESH:-}" = 1 ]; then
  # FRESH=1 replaces the public history with this one commit (a force push). Only with Stefan's approval.
  git push -q --force origin main
else
  git fetch -q origin main 2>/dev/null && git reset -q --soft origin/main && git commit -q -m "$message" || true
  git push -q origin main
fi
gh repo edit "$repo" --description "$description" --homepage "https://otisbase.com/docs" --add-topic mcp --add-topic mcp-server --add-topic cloudflare-workers --add-topic durable-objects --add-topic invoicing --add-topic billing >/dev/null
echo "Published $repo"
