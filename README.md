# Local Job Application Autofill

A small Chrome/Chromium Manifest V3 extension for filling repetitive job-application questions from a profile stored locally in the browser.

The primary workflow uses a local Node.js backend. The backend stores the candidate profile and resume, keeps provider API keys out of the browser, and sends only the CV, pasted/detected job description, page context, and unanswered questions to the selected AI provider.

## What it does

- Fills common contact, education, availability, work-authorization, and portfolio fields.
- Optionally fills user-configured gender, pronoun, sexual-orientation, Indigenous-identity, race/ethnicity, disability, and veteran-status answers.
- Stores a user-selected resume locally and attaches it to recognizable Resume/CV upload fields.
- Uses the configured backend AI after a resume upload to prefill only blank, evidence-backed contact and education fields; validated legal, demographic, medical, and criminal-history fields are never inferred from a resume.
- Optionally uses a free local Ollama model to draft unmatched open-ended questions from resume text and visible job context.
- Opens a movable, resizable extension window for reviewing the detected job description and controlling autofill while the application remains visible behind it.
- Fills the current application without opening the popup through `Command+Shift+Y` on macOS or `Ctrl+Shift+Y` on Windows/Linux.
- Optionally watches full navigations and single-page application step changes, recognizes application forms, and fills each new page automatically after one-time website access is approved.
- Automatically saves Profile, AI, and Application History settings after editing stops; slow writes are serialized so older data cannot overwrite newer changes.
- Offers White + Green, Current Blue, and Dark appearance themes; the selected theme is saved immediately and shared by the popup and settings pages.
- Opens on a leftmost General settings page for appearance and automatic-fill behaviour, while keeping candidate data and the uploaded resume in Profile.
- Syncs the saved profile and resume from a backend bound to `127.0.0.1`.
- Uses structured Workday mappings for repeated experience, education, language, and skill controls instead of asking AI to guess field boundaries.
- Scans unresolved visible controls into a compact semantic DOM schema containing labels, sections, control types, requirements, and exact available options.
- Sends that schema to the backend AI for a field plan, then uses a guarded browser executor to fill, select, validate, wait for dynamic controls, and re-scan up to three rounds.
- Adds Workday skills one at a time through the site's suggestion list so each value becomes a confirmed token.
- Applies saved Indeed preferences to commute/relocation, prior-employment, employee-referral, and relatives-at-employer questions by reading the complete radio-group question.
- Supports explicit employer-friendly defaults for travel, onsite work, flexible schedules, screenings, and criminal-record questions while keeping unsupported factual claims out of AI-generated answers.
- Uses AI to rank skills found in both the JD and resume first, followed by job-relevant technical skills and resume-only skills; user-editable total and non-technical limits prevent overcrowded skill lists.
- Shows the latest real AI skill selection directly below AI Settings, including its CV/JD evidence source and ranking reasons; uploading a CV creates the initial baseline and each detected JD refreshes it automatically. A user-managed permanent blacklist is enforced by both backend ranking and final browser insertion.
- Passively detects substantial job descriptions on full page loads and single-page navigation, keeps the current tab's JD in local extension storage, and updates the popup without requiring copy/paste or a Detect click.
- Optionally auto-advances through multi-page applications by clicking only recognized Next, Continue, Save and Continue, or Review controls; the popup's pause/play control immediately suspends future field changes and page advances, resumes the same active flow, and always stops before final Submit.
- Reconciles existing Workday skill tokens in overwrite mode, inserts each retained skill through a real portal search result, and stops at the configured maximum.
- Creates missing Workday language rows and fills each language and proficiency level saved by the user, with aliases for tenant-specific proficiency labels.
- Creates missing Workday experience rows with Add Another so every saved work experience receives its own structured entry.
- Adds Workday skills one at a time by waiting for and selecting a real suggestion, then verifies that each skill token appears before continuing.
- Types each Workday skill with per-character keyboard/input events, presses Enter to run the portal search, waits for the result list to stabilize, clicks the matching option row, and verifies the selected token before continuing.
- Fills Workday questionnaire button/listbox controls by reading the enclosing fieldset question and selecting only explicit saved answers.
- Re-scans Workday's React-rendered dropdowns and conditional checkbox groups after every answer so later questions and follow-up identity fields are not skipped.
- Sends unresolved Workday questions and their exact option lists to the backend AI, which maps saved profile facts and preferences to a validated available option.
- Corrects stale resume-import values in authoritative profile fields (for example, replacing a truncated Workday surname) and recognizes Workday questions outside fieldsets.
- Reads GPA and education start/end dates from editable profile fields, with those user-entered values overriding any older resume-import education record.
- Commits Workday's segmented month/year controls through real focus transitions so the portal clears stale required-field errors after autofill.
- Normalizes expected-graduation dates from the saved month/day/year and commits masked Workday date widgets through sequential input events so values such as `05/01/2028` are accepted by React validation.
- Supports Workday tenants that identify the school control as either `schoolName` or `school`, detects Education From/To years both by stable field IDs and row order, and verifies the React-controlled values after filling.
- Lets users drop a PDF into the autofill window and persists it in the local Docker-mounted resume file until another PDF replaces it.
- Gives Markdown, Excel, and Notion separate collapsible Application History sections that reveal their settings only when enabled.
- Lets users save application history manually, when autofill runs, or automatically after their own final Submit action; the extension records the status as `Submitted` without clicking Submit itself.
- Lets Markdown and Excel use independent remembered folders instead of coupling both formats to one destination.
- Supports Notion OAuth sign-in in a Chrome authorization window, while retaining internal-integration tokens as an optional local developer mode.
- Creates a user-named Notion root page with an inline **Application List** whose rows open into job-detail pages containing a
  summary, the complete JD, source URL, resume name, application date, status, and interview-preparation template.
- Upserts the same posting instead of duplicating it and includes date/month/status columns suitable for Excel pivot tables and
  application-trend charts.
- Uses a Strategy + Factory provider layer to switch between DeepSeek and OpenAI without coupling application logic to either API.
- Uses structured JSON output to draft answers from CV evidence plus the job description.
- Works on ordinary HTML forms and dispatches the events commonly required by React-based forms.
- Highlights required fields that still need manual review.
- Never clicks Submit; the local backend sends only the configured profile evidence, CV, JD, page context, and semantic field schema to the configured AI provider.
- Provides country-neutral, user-managed dropdowns for self-identification, work eligibility, criminal-history and screening questions, security clearance, employment history, and conflict disclosures. It can recognize local identifier wording such as SSN, SIN, NIN, and tax ID without storing the identifier itself. Unset facts remain untouched, and salary, contractual consent, certification, and signature fields are never automated.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select this `job-application-autofill` folder.
5. Pin **Local Job Application Autofill** to the toolbar.
6. Open the extension and choose **Edit profile**.
7. Enter your information—it saves automatically—then open an application form. The extension recognizes and fills new application pages automatically; the configured keyboard shortcut remains available as a fallback.

To fill each newly displayed application page automatically, enable **Automatically recognize and fill new application pages** under **General → Behaviour** and approve Chrome's one-time website-access request. This mode recognizes both full page loads and application steps rendered without a navigation. It never clicks a final Submit control. Keyboard shortcuts can be changed at `chrome://extensions/shortcuts`.

The same process works in Edge or another Chromium browser from its extensions management page.

## Start the local backend

Requirements for the double-click launcher: macOS and Node.js 20 or newer.

1. Double-click **Start Job Autofill Backend.command** and leave that Terminal window open.
2. Open a job posting or application. The extension captures the JD and fills recognized application pages automatically; use **Refresh current page** only when you want to recapture the page manually.

The direct Node.js launcher reads API credentials and connection settings from `backend/config/local-config.json`. That file is ignored by Git and Docker builds; keys are never copied into the image, extension, or application webpage. Copy `backend/config/local-config.example.json` to that filename before configuring a provider. **Configure DeepSeek Key.command** can instead save the DeepSeek key in macOS Keychain.

The backend listens only on `http://127.0.0.1:17840`. Its `/api/context` endpoint supplies the extension with the current user's saved profile and optional resume. Its `/api/answer` endpoint calls the selected provider strategy and validates every returned answer before the extension inserts it.

As an alternative to macOS Keychain, copy `.env.example` to `.env` and put a newly generated key there. `.env` is ignored by Git.

## Run the backend with Docker

The committed Docker image uses Node.js 24 LTS and contains only the backend code, blank templates, and PDF.js. Runtime credentials and candidate data remain in one ignored, host-local directory.

```bash
docker compose up --build -d
docker compose ps
```

The first startup creates `local-data/` and seeds blank `local-config.json` and `profile.json` files. The service is exposed only at `127.0.0.1:17840`, and Docker Compose mounts this one ignored directory as `/data`:

- `local-data/local-config.json` - this installation's provider keys, base URLs, and model choices.
- `local-data/profile.json` - this installation's saved autofill answers and personal profile.
- `local-data/resume.pdf` - created only after this user uploads a resume through the extension.

Edit `local-data/local-config.json` after the first startup, insert only your own provider credentials, and restart with `docker compose restart`. Each clone therefore starts empty and retains only the profile and resume created on that computer. The entire `local-data/` directory is excluded from both Git and Docker build context.

Stop the backend with:

```bash
docker compose down
```

No manual copying is required for a fresh clone. Open **Edit profile & answers** after startup, save that user's information, and upload a resume from the popup. Do not use `docker compose down -v` as a substitute for deleting the host `local-data/` directory; the bind-mounted files remain on that computer until deliberately removed.

## Tests

Run the complete test suite without contacting any real AI provider:

```bash
cd backend
npm test
npm run test:coverage
```

The suite exercises provider Strategy/Factory adapters, HTTP endpoints with isolated temporary storage and a local mock AI server, answer and skill validation, Chrome background-message routing, deterministic content-script form filling, privacy invariants, and Docker bootstrap configuration. The coverage command enforces minimum thresholds for the backend and AI adapter modules.

## Application history: Markdown, Excel, and Notion

The extension settings are separated into **General**, **Profile**, **AI**, and **Application History** tabs. Application History
has independent **Markdown**, **Excel**, and **Notion** sections. Each destination is implemented as its own exporter strategy,
selected by a small factory when a record is saved. Markdown and Excel remember independent folders through the browser's
directory picker. The `.csv` file is UTF-8 Excel-compatible and stores one row per
posting with application date, month, company, role, location, status, URL, resume, summary, complete JD, and last-saved time.
Saving the same posting again updates its row. The save trigger is configurable: manual only, when autofill runs, or after the
user clicks the final Submit control. Submit-triggered records use the `Submitted` status; the extension only observes that user
action and never performs the submission.

For Notion OAuth:

1. Create a Notion **public integration** and enable read, insert, and update-content capabilities.
2. Open **Application History → Notion** and copy the OAuth redirect URL shown by the extension into the integration's redirect URI settings.
3. Add the public integration's client ID and client secret to `local-data/local-config.json` under `notion.oauth`, then run `docker compose restart`.
4. Click **Connect Notion**. Chrome opens Notion's authorization screen; after approval, the backend exchanges the temporary code without exposing the client secret to the extension.

```json
{
  "notion": {
    "oauth": {
      "clientId": "your-public-integration-client-id",
      "clientSecret": "your-public-integration-client-secret"
    }
  }
}
```

OAuth creates the root page at workspace level, so the user does not need to paste a parent-page ID. The generated workspace
access token stays in that Chrome profile. For an eventual Chrome Web Store release, use the stable published extension ID's
redirect URL and move the same code-exchange endpoint to a hosted HTTPS backend.

Internal-token developer mode remains available under the collapsed section on the Notion page:

1. Create a Notion internal integration with read, insert, and update-content capabilities.
2. Create or choose a parent Notion page and share it with that integration.
3. Paste the integration token and the parent page URL or ID into extension settings.
4. Optionally rename the default root page, then click **Connect with token**.

The extension creates the **Job Application** root page (or your chosen name) and an inline **Application List** database. Every database row is a clickable application
page containing the summary, full JD, and interview sections. Notion credentials and generated IDs are stored only in that
Chrome profile; they are not included in Git, Docker images, profile exports, or application webpages.

## Resume upload and AI profile setup

Upload a PDF at the top of the **Profile** page or from the autofill window. It remains the active resume for applications until the user replaces or removes it. After upload, its text is extracted automatically for AI evidence and safe, empty-only profile prefilling; existing profile values are never overwritten. Common application fields that the resume does not establish are marked in red for the user to complete.

The movable autofill window uses separate sections for profile setup, resume upload, the captured job description, application history, and automation controls. The full-width **Profile & settings** entry remains highlighted until the one-time setup page has been opened.

DeepSeek through the local backend is the default adapter. Select **OpenAI** under **Backend AI provider** after configuring its key and model in the active configuration file (`local-data/local-config.json` for Docker). An entirely local Ollama fallback remains available:

1. Install [Ollama](https://ollama.com/download).
2. In Terminal, download and start a model, for example: `ollama run qwen3:4b`.
3. In extension settings, choose **Local Ollama** and save. The extension uses the installed `qwen3:4b` model by default without exposing model configuration in the user interface.
4. Open an application page. Deterministic answers are green, AI drafts are purple, and unresolved required fields are yellow. Use the popup's full-width pause/resume control to stop or continue automatic changes.

All AI strategies are instructed to leave unsupported answers blank. Demographic, authorization, sponsorship, and other sensitive facts are available to the semantic planner only when **Allow backend AI to use saved demographic and legal answers** is enabled, and then only from explicitly saved profile values. Submit, signature, certification, attestation, consent, privacy, terms, compensation, government-identifier, and birth-date actions are always excluded. Review every purple field before submitting. The OpenAI strategy uses the [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create); Ollama structured JSON responses are documented at [docs.ollama.com](https://docs.ollama.com/capabilities/structured-outputs).

PDF text extraction uses the open-source Mozilla PDF.js distribution; its license is included in `vendor/PDFJS-LICENSE.txt`.

## Current limitations

- A saved resume can be attached to standard file inputs, but some proprietary drag-and-drop upload widgets may still require a manual selection.
- Some ATS products render controls inside closed Shadow DOM components or unusual cross-origin frames; those fields may need manual entry or site-specific adapters.
- Long, job-specific written questions should still be reviewed and tailored before submission.
- The extension does not scrape job boards, mass-apply, bypass CAPTCHAs, or submit applications.
