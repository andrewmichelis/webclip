#!/usr/bin/env bash
# release-check.sh — WebClip release gate (RT-18 maturity check). One command, no model / no operator
# (SE-28). Exits non-zero on ANY failure so it can gate the release-public ceremony / CI.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$1"; }

step "typecheck"; npm run --silent typecheck
step "unit tests"; npm run --silent test
step "lint"; npm run --silent lint
step "build (dist/)"; npm run --silent build
step "supply-chain integrity (lockfile + exact pins)"
node -e '
  const fs = require("fs");
  if (!fs.existsSync("package-lock.json")) { console.error("  FAIL package-lock.json missing (npm ci reproducibility)"); process.exit(1); }
  const deps = require("./package.json").dependencies || {};
  const bad = Object.entries(deps).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(String(v)));
  if (bad.length) { console.error("  FAIL runtime deps must be EXACT-pinned (no ^/~/range):", JSON.stringify(bad)); process.exit(1); }
  console.log("  ok lockfile present; runtime deps exact-pinned =", JSON.stringify(deps));
'
step "security audit (production dependencies)"; npm audit --omit=dev
step "shipped manifest permissions (must be exactly the ARCH-WC-04 set)"
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
