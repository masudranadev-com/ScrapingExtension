## Quick orientation

This is a small Manifest V3 Chrome/Edge extension that provides a popup UI and injects a content script into pages.

- Manifest: `manifest.json` (MV3)
- Popup UI: `popup.html` (loads `popup.js`)
- Content script: `content.js` (injected into pages via `content_scripts`)

The manifest declares the Storage permission and broad host access:

`"permissions": ["storage"]`

`"host_permissions": ["<all_urls>"]`

These are the most important facts an agent needs to be productive: there is no background/service_worker in the manifest, the extension uses a popup action, and content scripts run on all pages.

## Big-picture architecture (what to know first)

- The popup is the primary UI entrypoint (open from browser toolbar). It includes an input with id `domain`, a `#save` button, and a `#status` paragraph in `popup.html` — see those element ids when modifying the popup behavior.
- `popup.js` should handle UI, persist configuration (storage API), and (if required) send commands to the content script.
- `content.js` runs in-page on all matched pages and is responsible for any DOM automation (auto-clicking) — it runs without a background/service worker in the current manifest.

## Concrete patterns and conventions to follow

- Storage: manifest requests the `storage` permission, so extension state/config should live in `chrome.storage` (or `browser.storage` for cross-browser).
- UI wiring: `popup.html` expects `popup.js` to find elements by id: `domain`, `save`, and `status`.
- Content script isolation: `content.js` will execute in the page context (content-script JS). Keep DOM access and page-modifying logic inside `content.js`; do not assume a persistent background script.
- No build step: there is no package.json, bundler, or service worker entry in the repo. Edits are single-file changes and can be tested by loading the unpacked extension in Chrome/Edge.

## Developer workflows (how to run, test, debug)

- Load unpacked extension: open chrome://extensions (or edge://extensions), enable Developer mode, click "Load unpacked" and point to the repository folder.
- Popup debugging: open the toolbar popup, then open the popup's devtools (right-click inside popup -> Inspect) to see console/logs from `popup.js`.
- Content script debugging: open devtools for a target page where the content script runs and look for `content.js` under the Sources tab or use console logs inserted into `content.js`.

## Integration points & extension communication

- There is currently no background/service worker declared. If you need cross-tab/state orchestration, prefer `chrome.storage` for shared state or implement message passing with `chrome.tabs.sendMessage` + `chrome.runtime.onMessage` between the popup and content script.
- Because `host_permissions` are `<all_urls>`, be cautious when adding broad DOM logic — tests and feature flags are helpful.

## Files to inspect when changing behavior

- `manifest.json` — control permissions, content_scripts, and popup wiring.
- `popup.html` — UI layout; IDs: `domain`, `save`, `status`.
- `popup.js` — currently empty; expected to implement saving/reading configuration and initiating runtime actions.
- `content.js` — currently empty; expected to implement per-page DOM actions (auto-click logic).

## Example snippets (what agents should look for / produce)

- Read/save domain in popup using Storage (recommended pattern):

- Wire the `#save` button to persist `domain` into `chrome.storage.sync` or `chrome.storage.local` and update `#status`.
- Content script should read stored domain/config (via `chrome.storage`) and only act on matching pages.

## Do not assume / gotchas

- There is no background/service_worker entry in `manifest.json`. Do not assume a persistent background process exists.
- The project currently has no tests or build tools — changes are validated by loading the unpacked extension and using the browser devtools.

## Quick checklist for edits an agent might perform

1. Update `popup.js` to add UI handlers that read/write `chrome.storage` and show feedback in `#status`.
2. Implement `content.js` to read stored config and perform DOM clicks only on matching domains.
3. Keep all permission changes in `manifest.json` minimal and explicit.

If any section is unclear or you want examples (e.g., a ready-to-add `popup.js` + `content.js` pair), tell me which behavior you want and I will implement and validate them by loading and testing locally.
