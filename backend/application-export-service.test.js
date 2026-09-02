import assert from "node:assert/strict";
import test from "node:test";

import { exportApplication } from "../application-export-service.js";
import { ApplicationExporterFactory } from "../exporters/exporter-factory.js";
import { ExcelExporter } from "../exporters/excel-exporter.js";
import { MarkdownExporter } from "../exporters/markdown-exporter.js";

test("exporter factory creates one independent strategy per destination", () => {
  assert.ok(ApplicationExporterFactory.create("markdown") instanceof MarkdownExporter);
  assert.ok(ApplicationExporterFactory.create("spreadsheet") instanceof ExcelExporter);
  assert.throws(() => ApplicationExporterFactory.create("unknown"), /Unsupported application export type/);
});

test("application export service delegates enabled destinations and reports partial failures", async () => {
  const originalCreate = ApplicationExporterFactory.create;
  const calls = [];
  ApplicationExporterFactory.create = (type, options) => ({
    async save(job) {
      calls.push({ type, options, job });
      if (type === "spreadsheet") throw new Error("disk unavailable");
      return { filename: "note.md" };
    },
  });
  try {
    const result = await exportApplication({
      settings: {
        destinations: { markdown: true, spreadsheet: true },
        spreadsheetFilename: "Applications.csv",
      },
      job: { jobTitle: "Developer" },
      directories: { markdown: { name: "notes" }, spreadsheet: { name: "sheets" } },
    });
    assert.deepEqual(result.saved, ["Markdown"]);
    assert.deepEqual(result.failures, ["Excel: disk unavailable"]);
    assert.deepEqual(calls.map(({ type }) => type), ["markdown", "spreadsheet"]);
    assert.equal(calls[0].options.directory.name, "notes");
    assert.equal(calls[1].options.directory.name, "sheets");
  } finally {
    ApplicationExporterFactory.create = originalCreate;
  }
});

test("application export service rejects an empty destination selection", async () => {
  await assert.rejects(
    () => exportApplication({ settings: { destinations: {} }, job: {}, directories: {} }),
    /Enable at least one/,
  );
});
