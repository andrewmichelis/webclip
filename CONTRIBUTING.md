# Contributing to WebClip

Thanks for your interest. WebClip is a small, focused tool, and contributions that keep it that way
are very welcome: bug reports, capture edge cases, and well-tested fixes.

## Getting set up

```bash
git clone https://github.com/andrewmichelis/webclip.git
cd webclip
npm install
npm run build        # bundles the unpacked extension into dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → **Load unpacked**.

## The checks

Please keep every change green:

```bash
npm run typecheck    # TypeScript, strict
npm test             # unit tests (Vitest)
npm run build        # esbuild bundle
npm run harness      # headless browser capture-and-assert (needs: npx playwright install chromium)
```

`npm run harness` drives a real capture end to end in headless Chrome and verifies the output PDF
(page geometry, break placement, and that every link is injection-safe and clickable). It is the
same check that guards releases. New behavior should come with a test; a bug fix should come with a
regression test that fails before the fix and passes after.

## Hard constraints (please do not change these without discussion)

- **Permissions stay minimal.** The shipped manifest must request exactly `activeTab`, `scripting`,
  `downloads`, `storage` and nothing else. `<all_urls>`, `host_permissions`, `debugger`, and CSP
  overrides are out of scope for the standard build. This is what keeps WebClip trustworthy.
- **No network egress.** WebClip does not upload anything or call out to a server. Keep it that way.
- **Restore the page.** Any page modification during capture must be recorded and restored on
  success, failure, and cancellation.

## Pull requests

Keep PRs focused and describe what you changed and why. Reference an issue if there is one. By
contributing, you agree your contribution is licensed under the project's Apache-2.0 license.

## Reporting security issues

Please do not file security reports as public issues. See [SECURITY.md](SECURITY.md).
