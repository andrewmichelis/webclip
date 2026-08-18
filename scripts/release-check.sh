#!/usr/bin/env bash
# release-check.sh — WebClip release gate (maturity check). One command.
# Exits non-zero on ANY failure so it can gate a public release / CI.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$1"; }

step "typecheck"; npm run --silent typecheck
step "unit tests"; npm run --silent test
step "lint"; npm run --silent lint
step "build (dist/)"; npm run --silent build
step "security audit (production dependencies)"; npm audit --omit=dev
step "shipped manifest permissions (must be exactly the minimal permission set)"
node -e '
  const m = require("./dist/manifest.json");
  const got = JSON.stringify(m.permissions || []);
  const want = JSON.stringify(["activeTab","scripting","downloads","storage"]);
  const bad = m.host_permissions || m.web_accessible_resources || m.externally_connectable
            || (m.content_security_policy && Object.keys(m.content_security_policy).length);
  if (got !== want) { console.error("  FAIL permissions drift:", got); process.exit(1); }
  if (bad) { console.error("  FAIL forbidden manifest key present (host_permissions / web_accessible_resources / externally_connectable / CSP override)"); process.exit(1); }
  console.log("  ok permissions =", got, "; no <all_urls>/host_permissions/CSP override");
'

printf '\nRELEASE GATE: PASS\n'
printf 'Browser / poppler follow-ons (run before publishing):\n'
printf '  npm run harness                      # headless capture-and-assert (needs: npx playwright install chromium)\n'
printf '  npm run verify:pdf <file> --breaks   # assert any WebClip PDF\n'
printf '  qpdf --check <file>                  # structural PDF check on a crafted-href capture (poppler/qpdf)\n'
