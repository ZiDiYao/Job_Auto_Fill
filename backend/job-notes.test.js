import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  APPLICATION_CSV_COLUMNS,
  createApplicationRecord,
  createJobNote,
  createJobNoteFilename,
  createJobSummary,
  hasDirectoryPermission,
  sanitizeFileSegment,
  stableJobHash,
  upsertApplicationCsv,
  writeApplicationSpreadsheet,
  writeJobNote,
} from "../job-notes.js";

const sampleJob = {
  jobTitle: "Software Developer, AI",
  company: "Example / Engineering: Inc.",
  location: "Toronto, ON",
  url: "https://example.com/jobs/123",
  resumeName: "Resume_2027.pdf",
  savedAt: "2026-09-02T12:34:56.000Z",
  jobDescription: "Build reliable software systems.\nWork with an Agile team.",
};

test("sanitizes platform-invalid filename characters", () => {
  assert.equal(sanitizeFileSegment(' Hatch / R&D: <Cloud> | "AI" '), "Hatch-R&D-Cloud-AI");
  assert.equal(sanitizeFileSegment("   ", "Fallback"), "Fallback");
});

test("creates a stable filename for the same job URL across save dates", () => {
  const first = createJobNoteFilename(sampleJob);
  const later = createJobNoteFilename({ ...sampleJob, savedAt: "2026-10-20T01:00:00.000Z" });
  assert.equal(first, later);
  assert.match(first, /^Example-Engineering-Inc - Software Developer, AI - [a-z0-9]{7}\.md$/);
  assert.equal(first.includes("/"), false);
});

test("uses different stable identities for different posting URLs", () => {
  assert.notEqual(
    stableJobHash("https://example.com/jobs/123"),
    stableJobHash("https://example.com/jobs/456"),
  );
});

test("generates a complete Markdown interview note", () => {
  const note = createJobNote({ ...sampleJob, status: "Submitted" });
  assert.match(note, /title: "Software Developer, AI"/);
  assert.match(note, /company: "Example \/ Engineering: Inc\."/);
  assert.match(note, /source_url: "https:\/\/example\.com\/jobs\/123"/);
  assert.match(note, /resume: "Resume_2027\.pdf"/);
  assert.match(note, /status: "Submitted"/);
  assert.match(note, /Application status:\*\* Submitted/);
  assert.match(note, /## Interview preparation/);
  assert.match(note, /## Summary/);
  assert.match(note, /## Original job description/);
  assert.match(note, /Build reliable software systems\./);
});

test("creates chart-friendly application records with deterministic summaries", () => {
  const record = createApplicationRecord({ ...sampleJob, status: "Applied" });
  assert.equal(record.applicationDate, "2026-09-02");
  assert.equal(record.applicationMonth, "2026-09");
  assert.equal(record.status, "Applied");
  assert.match(record.summary, /Software Developer, AI at Example/);
  assert.equal(createJobSummary({ ...sampleJob, summary: "Custom summary" }), "Custom summary");
});

test("Excel-compatible CSV export inserts and updates by stable job key", () => {
  const first = upsertApplicationCsv("", sampleJob);
  assert.ok(first.startsWith("\uFEFF"));
  assert.match(first, new RegExp(APPLICATION_CSV_COLUMNS[0]));
  assert.match(first, /"2026-09-02"/);
  assert.match(first, /"2026-09"/);
  assert.match(first, /"Build reliable software systems\.\r?\nWork with an Agile team\."/);

  const updated = upsertApplicationCsv(first, { ...sampleJob, status: "Interview", summary: "Updated" });
  assert.equal(updated.match(new RegExp(stableJobHash(sampleJob.url), "g"))?.length, 1);
  assert.match(updated, /"Interview"/);
  assert.match(updated, /"Updated"/);
});

test("refuses to create an empty job-description note", () => {
  assert.throws(() => createJobNote({ ...sampleJob, jobDescription: "  " }), /job description/i);
});

test("checks and optionally requests directory write permission", async () => {
  const denied = {
    queryPermission: async () => "prompt",
    requestPermission: async () => "denied",
  };
  assert.equal(await hasDirectoryPermission(denied, false), false);
  assert.equal(await hasDirectoryPermission(denied, true), false);

  const granted = {
    queryPermission: async () => "prompt",
    requestPermission: async () => "granted",
  };
  assert.equal(await hasDirectoryPermission(granted, true), true);
});

test("writes and closes a Markdown note through a directory handle", async () => {
  let written = "";
  let closed = false;
  let requestedFilename = "";
  const directory = {
    kind: "directory",
    name: "Interview Notes",
    queryPermission: async () => "granted",
    async getFileHandle(filename, options) {
      requestedFilename = filename;
      assert.deepEqual(options, { create: true });
      return {
        async createWritable() {
          return {
            async write(value) { written = value; },
            async close() { closed = true; },
          };
        },
      };
    },
  };

  const result = await writeJobNote(directory, sampleJob);
  assert.equal(result.filename, requestedFilename);
  assert.equal(result.directoryName, "Interview Notes");
  assert.equal(closed, true);
  assert.match(written, /Original job description/);
  assert.ok(result.bytes > 100);
});

test("does not write without a configured or authorized directory", async () => {
  await assert.rejects(() => writeJobNote(null, sampleJob), /Choose a Markdown folder/);
  await assert.rejects(
    () => writeJobNote({ kind: "directory", queryPermission: async () => "denied" }, sampleJob),
    /grant write access/,
  );
});

test("writes an Excel-compatible application list through the saved directory", async () => {
  let written = "";
  const directory = {
    kind: "directory",
    name: "Applications",
    queryPermission: async () => "granted",
    async getFileHandle(filename) {
      assert.equal(filename, "My Applications.csv");
      return {
        async getFile() { return { async text() { return ""; } }; },
        async createWritable() {
          return {
            async write(value) { written = value; },
            async close() {},
          };
        },
      };
    },
  };
  const result = await writeApplicationSpreadsheet(directory, sampleJob, { filename: "My Applications.csv" });
  assert.equal(result.filename, "My Applications.csv");
  assert.match(written, /Application Date/);
  assert.match(written, /Software Developer, AI/);
});

test("popup and settings expose the notes workflow through module scripts", async () => {
  const [popupHtml, popupSource, optionsHtml, optionsSource, manifestSource, watcherSource] = await Promise.all([
    readFile(new URL("../popup.html", import.meta.url), "utf8"),
    readFile(new URL("../popup.js", import.meta.url), "utf8"),
    readFile(new URL("../options.html", import.meta.url), "utf8"),
    readFile(new URL("../options.js", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../auto-fill-watcher.js", import.meta.url), "utf8"),
  ]);
  assert.match(popupHtml, /id="saveNote"/);
  assert.match(popupHtml, /id="autoNext"/);
  assert.match(popupHtml, /Stops before Submit/);
  for (const field of ["genderIdentity", "pronouns", "sexualOrientation", "indigenousIdentity", "raceEthnicity", "visibleMinority", "disabilityStatus", "veteranStatus"]) {
    assert.match(optionsHtml, new RegExp(`<select name="${field}">`));
  }
  assert.doesNotMatch(optionsHtml, /name="aiModel"|qwen3:4b/);
  assert.match(popupHtml, /type="module" src="popup\.js"/);
  assert.match(popupHtml, /Complete profile &amp; settings/);
  assert.match(popupHtml, /id="settingsRequired">Required before your first autofill/);
  assert.match(popupHtml, /class="popup-card resume-section"/);
  assert.match(popupHtml, /class="popup-card job-section"/);
  assert.match(popupHtml, /class="notes-copy">[\s\S]*?Application history[\s\S]*?id="notesSettings"[\s\S]*?<\/div>[\s\S]*?id="saveNote"/);
  assert.doesNotMatch(popupHtml, /notesFolderStatus|folder access req/);
  assert.doesNotMatch(popupSource, /refreshNotesFolderStatus|hasDirectoryPermission/);
  assert.doesNotMatch(popupHtml, /The job description is captured automatically/);
  assert.doesNotMatch(popupHtml, /id="fill"|>Fill application</);
  assert.match(popupSource, /saveCurrentJobNote/);
  assert.match(popupSource, /jobAutofillOnboardingVisited/);
  assert.match(popupSource, /renderSetupState/);
  assert.match(popupSource, /onboardingVisited && hasDefaultResume/);
  assert.match(optionsHtml, /id="chooseMarkdownFolder"/);
  assert.match(optionsHtml, /id="chooseExcelFolder"/);
  assert.match(optionsHtml, /id="historySaveTrigger"/);
  assert.match(optionsHtml, /Whenever Autofill starts/);
  assert.match(optionsHtml, /After I submit an application/);
  assert.match(optionsHtml, /Only when I click Save application/);
  assert.ok(optionsHtml.indexOf('id="historySaveTrigger"') < optionsHtml.indexOf('id="exportMarkdown"'));
  assert.match(optionsHtml, /id="exportNotion"/);
  assert.match(optionsHtml, /id="exportSpreadsheet"/);
  assert.match(optionsHtml, /data-settings-target="profile"/);
  assert.match(optionsHtml, /data-settings-target="general">General<\/button>/);
  assert.ok(optionsHtml.indexOf('data-settings-target="general"') < optionsHtml.indexOf('data-settings-target="profile"'));
  assert.match(optionsHtml, /<select name="theme">[\s\S]*?White \+ Green[\s\S]*?Current Blue[\s\S]*?Dark/);
  assert.match(optionsHtml, /data-settings-target="ai"/);
  assert.match(optionsHtml, /data-settings-page="profile"[^>]*class="default-resume-section"[^>]*hidden>[\s\S]*?<h2>Upload resume<\/h2>/);
  assert.match(optionsHtml, /data-settings-page="general">[\s\S]*?<h2>Behaviour<\/h2>/);
  assert.match(optionsSource, /return "general";\n}/);
  assert.match(optionsHtml, /id="profileFooter" data-settings-page="profile"/);
  assert.doesNotMatch(optionsHtml, /data-ai-target|data-ai-page|Mock job description skills|Mock resume\/profile skills|Run skills preview/);
  assert.match(optionsHtml, /id="previewSelectedSkills"/);
  assert.match(optionsHtml, /Skills selected from your CV \+ JD/);
  assert.match(optionsHtml, /name="skillBlacklist"/);
  assert.match(optionsSource, /gpaInput\.type = hidden \? "text" : "password"/);
  assert.match(optionsHtml, /id="educationList"/);
  assert.match(optionsHtml, /id="addEducation"/);
  assert.match(optionsSource, /normalizeEducationEntries/);
  assert.match(optionsHtml, /Why these were selected/);
  assert.doesNotMatch(optionsHtml, /Excluded by your limits|preview-explainers|preview-legend|ats-mock-header/);
  assert.match(optionsHtml, /data-settings-target="history"/);
  assert.match(optionsHtml, /id="exportMarkdown"/);
  assert.match(optionsHtml, /id="notionConnectionAction"/);
  assert.doesNotMatch(optionsHtml, /id="resetNotion"|Reset Notion link/);
  assert.match(optionsHtml, /id="saveStatus"[^>]*>All changes saved</);
  assert.doesNotMatch(optionsHtml, /id="syncBackend"|Reload backend/);
  assert.match(optionsHtml, /<h2>Languages<\/h2>/);
  assert.match(optionsSource, /languages: \[\]/);
  assert.match(popupSource, /normalizeExtractedLanguages/);
  assert.doesNotMatch(optionsHtml, /id="saveTop"|id="saveBottom"|id="saveExportSettings"/);
  assert.match(optionsHtml, /data-export-options="markdown"/);
  assert.match(optionsHtml, /data-export-options="spreadsheet"/);
  assert.match(optionsHtml, /data-export-options="notion"/);
  assert.doesNotMatch(optionsHtml, /Forget folder|forgetMarkdownFolder|forgetExcelFolder/);
  assert.match(optionsSource, /chooseExportDirectory/);
  assert.match(optionsSource, /forgetExportDirectory/);
  assert.match(optionsSource, /button\.textContent = "Cancel"/);
  assert.match(optionsSource, /button\.dataset\.folderSelected === "true"/);
  assert.match(optionsSource, /refreshExportFolderStatus/);
  assert.match(optionsSource, /updateExportOptionVisibility/);
  assert.match(optionsSource, /renderNotionConnectionAction/);
  assert.match(optionsSource, /createDebouncedAutosave/);
  assert.match(optionsSource, /form\.addEventListener\("input", queueChangedSetting\)/);
  assert.match(optionsSource, /form\.addEventListener\("change", queueChangedSetting\)/);
  assert.match(optionsSource, /updateIncompleteProfileFields/);
  assert.match(optionsSource, /notionToken\.value\.trim\(\) \|\| current\.notion\.token/);
  assert.match(optionsHtml, /name="autoFillOnPageChange"/);
  assert.match(optionsHtml, /name="autoCaptureJobDescriptions"/);
  assert.match(manifestSource, /"fill-current-page"/);
  assert.doesNotMatch(manifestSource, /"default_popup"/);
  assert.match(watcherSource, /MutationObserver/);
  assert.match(manifestSource, /"Command\+Shift\+Y"/);
  assert.doesNotMatch(manifestSource, /"optional_host_permissions"/);
  assert.match(manifestSource, /"http:\/\/\*\/\*"/);
  assert.match(manifestSource, /"https:\/\/\*\/\*"/);
  assert.match(watcherSource, /MutationObserver/);
  assert.match(watcherSource, /job-page-observed/);
  assert.match(watcherSource, /application-submitted/);
  assert.match(watcherSource, /document\.addEventListener\("submit"/);
  assert.match(watcherSource, /INSPECTION_DELAY_MS = 350/);
  assert.doesNotMatch(watcherSource, /clearTimeout\(timer\)/);
  assert.match(watcherSource, /JobPosting structured data/);
  assert.match(popupSource, /jobAutofillDetectedJobContext/);
  assert.match(popupSource, /jobAutofillAutomationPaused/);
  assert.match(popupSource, /Pause automatic changes/);
  assert.match(popupSource, /Resume automatic changes/);
  assert.match(popupHtml, /id="automationToggle"/);
  assert.match(popupHtml, /id="automationToggleLabel">Pause automatic changes/);
  assert.doesNotMatch(popupHtml, /Stop auto-advance/);
  assert.match(optionsSource, /showSettingsPage/);
  assert.match(optionsSource, /renderSkillPreview/);
  assert.match(optionsSource, /launchWebAuthFlow/);
});
