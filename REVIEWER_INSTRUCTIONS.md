# Chrome Web Store reviewer instructions

## Product boundary

Job Autofill assists with job-application forms but never clicks final Submit. AI is not an execution engine. It returns only an opaque field ID, semantic category, suggested answer(s), and confidence. The backend rejects any response outside the strict schema. All DOM discovery, option selection, input events, timing, verification, and Next/Continue decisions are implemented in extension-packaged JavaScript.

## First-run flow

1. Load the unpacked extension.
2. The extension opens `onboarding.html` before the popup or automation can run.
3. Local-processing consent is required. Automatic site access, cloud AI, sensitive-answer matching, and Notion are separate unchecked options.
4. Choices can be withdrawn and local data can be deleted in **Profile & settings → Privacy & Data**.

## Permissions

- `activeTab`: manual operation on the user-selected current tab.
- `scripting`: inject the packaged content script when the user invokes autofill.
- `storage`: retain the user's profile, settings, resume cache, consent, and connection state.
- Optional `identity`: requested at runtime only when the user clicks **Connect Notion** for OAuth, and revoked on disconnect/deletion.
- Localhost host permissions: communicate with the user-run Docker backend and optional Ollama service.
- Optional HTTP/HTTPS host access: requested only when the user enables automatic page detection/filling.
- Optional Notion host access: requested only when the user enables Notion export.

## Test mode

The extension can be reviewed without a cloud account by leaving cloud AI disabled and using deterministic profile mappings. To review the companion backend, run `docker compose up -d --build` from the repository root; it binds only to `127.0.0.1:17840` and starts with blank per-install data. Reviewers can inspect `/api/suggest-fields`; its response schema contains no selector, script, event, wait, navigation, click, or action fields.

The extension never downloads or evaluates executable code. PDF.js and every browser automation routine are packaged in the uploaded ZIP. The only remote responses consumed by form filling are data objects that pass the exact semantic suggestion schema.
