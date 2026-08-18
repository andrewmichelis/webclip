# WebClip Privacy Policy

**Last updated:** 2026-08-17

WebClip is designed to run entirely on your device.

## What WebClip does with your data

WebClip captures the active browser tab when you explicitly ask it to, and turns that capture into a file (a PDF, and in a later release a Markdown document) that is saved through your browser's normal download mechanism.

All processing happens locally in your browser. WebClip does **not**:

- upload screenshots, PDFs, or Markdown output;
- upload URLs, page titles, page content, or capture metadata;
- send your browsing history anywhere;
- run analytics or telemetry;
- use remotely hosted code.

## What WebClip stores

- **Preferences** (paper size, image format, and similar settings) are stored in your browser's extension storage so they persist between sessions.
- **Transient capture state** may be held briefly in session storage while a capture is running, and is cleared afterward.

Captured image data is held in memory only for as long as it takes to produce your file, then released.

## Permissions and why they are needed

- **activeTab**: temporary access to the tab you are on, granted by your click, so WebClip can read its URL/title and capture it. This is used instead of permanent access to all sites.
- **scripting**: to measure and scroll the page during a full-page capture, and to restore it afterward.
- **downloads**: to save the resulting file.
- **storage**: to remember your preferences and hold transient capture state.

## Evidence Mode

If you enable Evidence Mode, WebClip records the source URL, page title, capture time, and a cryptographic checksum alongside the output. This information stays on your device. The capture time comes from your local system clock. It is not an independently trusted timestamp.

## Future optional services

Any future feature that would send data off your device (for example, an external trusted-timestamp service) will be off by default, will require your explicit opt-in, and will be disclosed here before it ships.

## Contact

Questions: open an issue on the project repository.
