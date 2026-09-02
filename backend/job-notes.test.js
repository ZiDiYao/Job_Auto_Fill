import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createJobNote,
  createJobNoteFilename,
  hasDirectoryPermission,
  sanitizeFileSegment,
  stableJobHash,
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
  const note = createJobNote(sampleJob);
  assert.match(note, /title: "Software Developer, AI"/);
  assert.match(note, /company: "Example \/ Engineering: Inc\."/);
  assert.match(note, /source_url: "https:\/\/example\.com\/jobs\/123"/);
  assert.match(note, /resume: "Resume_2027\.pdf"/);
  assert.match(note, /## Interview preparation/);
  assert.match(note, /## Original job description/);
  assert.match(note, /Build reliable software systems\./);
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
  await assert.rejects(() => writeJobNote(null, sampleJob), /Choose an interview-notes folder/);
  await assert.rejects(
    () => writeJobNote({ kind: "directory", queryPermission: async () => "denied" }, sampleJob),
    /grant write access/,
  );
});

test("popup and settings expose the notes workflow through module scripts", async () => {
  const [popupHtml, popupSource, optionsHtml, optionsSource] = await Promise.all([
    readFile(new URL("../popup.html", import.meta.url), "utf8"),
    readFile(new URL("../popup.js", import.meta.url), "utf8"),
    readFile(new URL("../options.html", import.meta.url), "utf8"),
    readFile(new URL("../options.js", import.meta.url), "utf8"),
  ]);
  assert.match(popupHtml, /id="saveNote"/);
  assert.match(popupHtml, /type="module" src="popup\.js"/);
  assert.match(popupSource, /saveCurrentJobNote/);
  assert.match(popupSource, /autoSaveOnFill/);
  assert.match(optionsHtml, /id="chooseNotesFolder"/);
  assert.match(optionsHtml, /id="autoSaveJobNotes"/);
  assert.match(optionsSource, /chooseNotesDirectory/);
  assert.match(optionsSource, /refreshNotesFolderStatus/);
});
