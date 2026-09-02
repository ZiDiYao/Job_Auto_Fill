# Chrome Web Store release checklist

## Release artifact

1. Run `./scripts/package-extension.sh`.
2. Upload the generated `dist/job-autofill-extension-v<version>.zip`.
3. Confirm `manifest.json` is at the ZIP root.
4. Re-run `cd backend && npm test && npm run test:coverage` from the exact release commit.

## Store listing

- Single purpose: Help users complete and organize their own job applications using a locally saved profile and resume, with optional AI answer suggestions and optional application-history exports.
- State prominently that the extension reads visible job descriptions and application form content only to provide autofill.
- State prominently that cloud AI, automatic all-site access, and sensitive-answer matching are separately optional.
- Do not claim that the extension submits applications. It always stops before final Submit.
- Provide accurate screenshots of the first-run disclosure, popup, Profile, AI, Privacy & Data, and Application History pages.

## Privacy practices questionnaire

Use `STORE_PRIVACY_DISCLOSURE.md` as the build-specific worksheet. The dashboard disclosure, listing, first-run disclosure, and public privacy policy must describe the same behavior.

- Publish `privacy.html` and its stylesheet at a stable public HTTPS URL.
- Enter that public URL in the dashboard; an extension-only `chrome-extension://` URL is not sufficient.
- Declare personally identifiable information, website content, form data, user activity, health information, and the listed sensitive personal information.
- Certify that data is used only for the disclosed single purpose and is not sold, used for ads, or used for creditworthiness.
- Name the configured AI provider and the selected application website as conditional external destinations.

## Permission justifications

- `activeTab`: inspect and fill the tab the user explicitly invokes.
- `scripting`: inject only extension-packaged form inspection and filling logic into that active tab.
- `storage`: retain consent, profile, resume cache, settings, and application history.
- Localhost origins: communicate with the user-run Docker backend and optional local Ollama process.
- Optional HTTP/HTTPS origins: enable automatic job-page detection and filling only after a separate user gesture and Chrome permission prompt.

## Reviewer access

- Paste `REVIEWER_INSTRUCTIONS.md` into the reviewer-notes field or provide it through the dashboard's test-instructions area.
- Explain that deterministic autofill works with cloud AI disabled.
- If cloud AI must be tested, provide non-production reviewer credentials through the private reviewer-instructions channel, never in the ZIP or public listing.
- Keep the local backend available exactly as documented, or clearly state that optional cloud features require the companion Docker service.

## Final policy audit

- No remotely hosted executable code, dynamic module URL, `eval`, or `new Function`.
- AI response objects contain only `id`, `category`, `answer`, `answers`, and `confidence` under a strict schema.
- No backend response can provide selectors, scripts, browser events, waits, navigation, clicks, or action sequences.
- All DOM selection, form mutation, option confirmation, date entry, waiting, verification, and Next/Continue logic ships in the extension package.
- Rotate any credential ever pasted into chat, source control, logs, or screenshots before release.

Official references:

- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- https://developer.chrome.com/docs/webstore/prepare
