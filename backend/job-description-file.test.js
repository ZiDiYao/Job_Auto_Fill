import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeJobDescriptionText,
  readJobDescriptionFile,
  validateJobDescriptionFile,
} from "../job-description-file.js";

test("job-description files accept PDF and common plain-text formats", () => {
  assert.equal(validateJobDescriptionFile({ name: "role.PDF", size: 120 }), "pdf");
  assert.equal(validateJobDescriptionFile({ name: "role.txt", size: 120 }), "txt");
  assert.equal(validateJobDescriptionFile({ name: "role.md", size: 120 }), "md");
});

test("job-description file validation rejects unsupported, empty, and oversized files", () => {
  assert.throws(() => validateJobDescriptionFile({ name: "role.docx", size: 120 }), /PDF, TXT, or Markdown/);
  assert.throws(() => validateJobDescriptionFile({ name: "role.txt", size: 0 }), /5 MB/);
  assert.throws(() => validateJobDescriptionFile({ name: "role.txt", size: (5 * 1024 * 1024) + 1 }), /5 MB/);
});

test("manual text job descriptions are normalized, bounded, and readable", async () => {
  const source = `Responsibilities\r\n\tBuild reliable software.   Work with product teams.\n\n\nQualifications\n${"Experience with Java and SQL. ".repeat(5)}`;
  const file = {
    name: "job.md",
    size: source.length,
    async text() { return source; },
  };
  const result = await readJobDescriptionFile(file);
  assert.match(result, /^Responsibilities\nBuild reliable software/);
  assert.match(result, /\n\nQualifications\n/);
  assert.ok(result.length >= 80);
  assert.equal(normalizeJobDescriptionText("A".repeat(31000)).length, 30000);
});

test("manual job-description files with no useful text are rejected", async () => {
  await assert.rejects(
    readJobDescriptionFile({ name: "empty.txt", size: 4, async text() { return "nope"; } }),
    /enough readable/,
  );
});
