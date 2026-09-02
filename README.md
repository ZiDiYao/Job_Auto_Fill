# Local Job Application Autofill

A small Chrome/Chromium Manifest V3 extension for filling repetitive job-application questions from a profile stored locally in the browser.

The primary workflow uses a local Node.js backend. The backend stores the candidate profile and resume, keeps the DeepSeek key out of the browser, and sends only the CV, pasted/detected job description, page context, and unanswered questions to DeepSeek.

## What it does

- Fills common contact, education, availability, work-authorization, and portfolio fields.
- Supports reusable custom question rules with regular-expression matching.
- Optionally fills user-configured gender, pronoun, sexual-orientation, Indigenous-identity, race/ethnicity, disability, and veteran-status answers.
- Stores a user-selected resume locally and attaches it to recognizable Resume/CV upload fields.
- Optionally uses a free local Ollama model to draft unmatched open-ended questions from resume text and visible job context.
- Provides a popup window for pasting a job description or detecting it from the current page.
- Syncs the saved profile and resume from a backend bound to `127.0.0.1`.
- Uses structured Workday mappings for repeated experience, education, language, and skill controls instead of asking AI to guess field boundaries.
- Adds Workday skills one at a time through the site's suggestion list so each value becomes a confirmed token.
- Applies saved Indeed preferences to commute/relocation, prior-employment, employee-referral, and relatives-at-employer questions by reading the complete radio-group question.
- Supports explicit employer-friendly defaults for travel, onsite work, flexible schedules, screenings, and criminal-record questions while keeping unsupported factual claims out of AI-generated answers.
- Merges saved candidate skills with technical skills extracted from the current JD, inserts each as a confirmed Workday token, and reports JD-only additions for manual review.
- Creates missing Workday language rows and fills English and Chinese as Fluent plus French as Classroom, with aliases for tenant-specific proficiency labels.
- Creates missing Workday experience rows with Add Another so every saved work experience receives its own structured entry.
- Adds Workday skills one at a time by waiting for and selecting a real suggestion, then verifies that each skill token appears before continuing.
- Waits for Workday skill search results to load and stabilize before clicking the result checkbox, then pauses again while the selected token is committed.
- Fills Workday questionnaire button/listbox controls by reading the enclosing fieldset question and selecting only explicit saved answers.
- Re-scans Workday's React-rendered dropdowns and conditional checkbox groups after every answer so later questions and follow-up identity fields are not skipped.
- Sends unresolved Workday questions and their exact option lists to the backend AI, which maps saved profile facts and preferences to a validated available option.
- Corrects stale resume-import values in authoritative profile fields (for example, replacing a truncated Workday surname) and recognizes Workday questions outside fieldsets.
- Reads GPA and education start/end dates from editable profile fields, with those user-entered values overriding any older resume-import education record.
- Supports Workday tenants that identify the school control as either `schoolName` or `school`, detects Education From/To years both by stable field IDs and row order, and verifies the React-controlled values after filling.
- Lets users drop a PDF into the popup and persists it in the local Docker-mounted resume file until another PDF replaces it.
- Uses DeepSeek JSON output to draft answers from CV evidence plus the job description.
- Works on ordinary HTML forms and dispatches the events commonly required by React-based forms.
- Highlights required fields that still need manual review.
- Never clicks Submit and never sends profile data to an external service.
- Leaves self-identification questions untouched unless the user explicitly configures an answer, and always ignores salary, consent, signature, and background-check fields unless a custom rule is added.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select this `job-application-autofill` folder.
5. Pin **Local Job Application Autofill** to the toolbar.
6. Open the extension and choose **Edit profile & answers**.
7. Save your information, open an application form, paste or detect the JD, and click **Fill with CV + JD**.

The same process works in Edge or another Chromium browser from its extensions management page.

## Start the local backend

Requirements: macOS and Node.js 20 or newer.

1. Double-click **Start Job Autofill Backend.command** and leave that Terminal window open.
2. Open the extension. Paste the JD or click **Detect from current page**, then click **Fill with CV + JD**.

This personal build reads its API credential and connection settings from `backend/config/local-config.json`. That file is ignored by Git and Docker builds; the key is never copied into the image, extension, or application webpage. **Configure DeepSeek Key.command** remains available if you later remove the key from the local config and prefer macOS Keychain.

The backend listens only on `http://127.0.0.1:17840`. Its `/api/context` endpoint supplies the extension with the saved profile and `backend/data/Resume_2027_ZIDI.pdf`. Its `/api/answer` endpoint calls DeepSeek and validates every returned answer before the extension inserts it.

As an alternative to macOS Keychain, copy `.env.example` to `.env` and put a newly generated key there. `.env` is ignored by Git.

## Run the backend with Docker

The committed Docker image uses Node.js 24 LTS and contains only the backend code plus PDF.js. Runtime credentials and candidate data remain local bind mounts.

```bash
docker compose up --build -d
docker compose ps
```

The service is exposed only at `127.0.0.1:17840`. Docker Compose mounts these untracked local files at runtime:

- `backend/config/local-config.json` - DeepSeek API key, base URL, model, server, and storage configuration.
- `backend/data/profile.json` - saved autofill answers and personal profile.
- `backend/data/Resume_2027_ZIDI.pdf` - resume used for evidence and file uploads.

Stop the backend with:

```bash
docker compose down
```

For a fresh clone, copy `local-config.example.json` and `profile.example.json` to their non-example filenames, then add a local resume PDF. None of those personal runtime files should be committed.

## Custom rules

Custom rules override built-in mappings. Each rule has a case-insensitive regular expression and the answer to enter:

```json
[
  { "match": "available.*start|start date", "value": "January 2027" },
  { "match": "length.*work term|co-?op duration", "value": "8 months" },
  { "match": "how did you hear", "value": "Company website" }
]
```

Keep legal and sensitive answers truthful. Leave them blank when the correct response depends on the employer, location, or role.

## Resume upload and AI

The saved PDF/DOCX is used for the application page's file-upload control. PDF and TXT content is extracted automatically into the **Resume text used as AI evidence** box. DOCX files can still be attached automatically, but their text must currently be pasted into that box manually.

DeepSeek through the local backend is the default. An entirely local Ollama fallback remains available:

1. Install [Ollama](https://ollama.com/download).
2. In Terminal, download and start a model, for example: `ollama run qwen3:4b`.
3. In extension settings, enable **Use local AI**, enter the same model name, paste the resume text, and save.
4. Click **Fill with CV + JD**. Deterministic answers are green, AI drafts are purple, and unresolved required fields are yellow.

Both AI providers are instructed to leave unsupported answers blank and are never asked to answer demographic, authorization, sponsorship, compensation, consent, or legal questions. Those fields use only explicitly saved deterministic answers. Review every purple field before submitting. Ollama structured JSON responses are documented at [docs.ollama.com](https://docs.ollama.com/capabilities/structured-outputs).

PDF text extraction uses the open-source Mozilla PDF.js distribution; its license is included in `vendor/PDFJS-LICENSE.txt`.

## Current limitations

- A saved resume can be attached to standard file inputs, but some proprietary drag-and-drop upload widgets may still require a manual selection.
- Some ATS products render controls inside closed Shadow DOM components or unusual cross-origin frames; those fields may need manual entry or site-specific adapters.
- Long, job-specific written questions should still be reviewed and tailored before submission.
- The extension does not scrape job boards, mass-apply, bypass CAPTCHAs, or submit applications.
