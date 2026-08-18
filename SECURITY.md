# Security Policy & Threat Model

WebClip runs inside your browser and reads the page you are looking at. That is exactly the kind of
tool whose security has to be honest and verifiable, so the design assumes attackers can read every
line of this repository. The security model does not rely on secrecy. It rests on two deliberate
choices: **the smallest useful permission set** and **no network egress at all**.

## Architecture-level decisions

**No data ever leaves your machine.** WebClip makes no network requests to send your data anywhere.
It does not upload screenshots, URLs, page content, or metadata, and it ships no analytics or
telemetry. Captures are composed locally and handed to the browser's own Downloads. (The only
`fetch` calls in the code decode local `data:` URLs in memory; they contact no server.)

**The minimum practical permissions.** The shipped extension requests only `activeTab`, `scripting`,
`downloads`, and `storage`. It deliberately does **not** request `<all_urls>`, `host_permissions`,
`debugger`, `externally_connectable`, or `web_accessible_resources`, and it does not override the
Manifest V3 default Content Security Policy (`script-src 'self'`). Access to a page is granted by
your explicit click (`activeTab`) and released afterward, never held permanently.

## Threat model

**Assets:** the page content you choose to capture, your local files, your browsing.
**Trust boundary:** you (the person clicking WebClip) are trusted; the web pages you capture are not.

| Risk | Mitigation |
|---|---|
| A malicious page exfiltrating your data through the extension | No network egress. Nothing is uploaded; there is no channel to exfiltrate through. |
| A crafted link (`href`) injecting actions into the saved PDF | Link URLs are re-validated at the PDF sink (scheme allowlist: `http`, `https`, `mailto`, `tel`; length-capped) and written as **hex-encoded strings**, which cannot break out of a PDF string to inject annotation or action tokens. Verified in CI (`scripts/verify-pdf.mjs` decodes every `/URI` and rejects anything dangerous). |
| Dangerous PDF actions (`/JavaScript`, `/Launch`, …) leaking into output | The renderer emits only `/URI` link actions; the verifier fails the build if any dangerous action key appears. |
| Cross-site scripting in the popup / options UI | All page-derived text is rendered via `textContent` / `.value` / `.title`, never `innerHTML`; no inline event handlers. |
| Path traversal via the download filename | Filenames are slugged to `[A-Za-z0-9._-]` and `..` / `/` are collapsed; the browser adds a second layer. |
| Capturing the wrong tab | The active tab is re-verified before every screenshot; the capture aborts rather than mixing pixels from another tab. |
| Leaving your page modified | Every scroll, injected style, and hidden element is recorded and restored on success, failure, and cancellation. |
| Supply-chain risk | One runtime dependency (`pdf-lib`, pure JS, no install scripts); dev dependencies are not bundled; a lockfile pins versions. |

### Residual risks (stated plainly)

- **Evidence Mode is honest, not notarized.** It records a **local** clock time and a detached
  SHA-256 of the capture. It is useful for your own integrity checks. It is not, and does not claim
  to be, an independently trusted timestamp. Trusted (RFC-3161) timestamping is a possible future,
  clearly separate, feature.
- **A capture is a picture of what your browser rendered.** If a page shows you something
  misleading, WebClip faithfully captures that. It asserts nothing about the truth of the content.

## What WebClip deliberately does NOT do

- It does not open a network connection to send your data anywhere.
- It does not request broad host permissions or `debugger`.
- It does not run remote or dynamically-fetched code (no `eval`, no CDN, no remote scripts).
- It does not collect analytics or phone home.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Contact the maintainer privately via the
GitHub profile [`andrewmichelis`](https://github.com/andrewmichelis) with a description, an impact
assessment, reproduction steps, and the affected version. Security fixes are prioritized over
features and are release-blocking.

## Release gate

Every release must pass the automated gate before it ships: typecheck, unit tests, build, a
production-dependency audit, a manifest-permission check that fails on anything beyond the four
permissions above, and a headless browser harness that captures a real page and verifies the output
PDF (including that every link is both injection-safe and actually clickable). See
[`CONTRIBUTING.md`](CONTRIBUTING.md).
