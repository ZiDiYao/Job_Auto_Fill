import assert from "node:assert/strict";
import test from "node:test";

import { exportApplication } from "../application-export-service.js";
import { ApplicationExporterFactory } from "../exporters/exporter-factory.js";
import { ExcelExporter } from "../exporters/excel-exporter.js";
import { MarkdownExporter } from "../exporters/markdown-exporter.js";
import { NotionExporter } from "../exporters/notion-exporter.js";

test("exporter factory creates one independent strategy per destination", () => {
  assert.ok(ApplicationExporterFactory.create("markdown") instanceof MarkdownExporter);
  assert.ok(ApplicationExporterFactory.create("spreadsheet") instanceof ExcelExporter);
  assert.ok(ApplicationExporterFactory.create("notion") instanceof NotionExporter);
  assert.throws(() => ApplicationExporterFactory.create("unknown"), /Unsupported application export type/);
});

test("application export service delegates enabled destinations and reports partial failures", async () => {
  const originalCreate = ApplicationExporterFactory.create;
  const calls = [];
  ApplicationExporterFactory.create = (type, options) => ({
    async save(job) {
      calls.push({ type, options, job });
      if (type === "spreadsheet") throw new Error("disk unavailable");
      return type === "notion" ? { workspace: { token: "updated", dataSourceId: "ready" } } : { filename: "note.md" };
    },
  });
  try {
    const persisted = [];
    const result = await exportApplication({
      settings: {
        destinations: { markdown: true, spreadsheet: true, notion: true },
        spreadsheetFilename: "Applications.csv",
        notion: { token: "initial" },
      },
      job: { jobTitle: "Developer" },
      directories: { markdown: { name: "notes" }, spreadsheet: { name: "sheets" } },
      persistNotionSettings: async (settings) => persisted.push(settings),
    });
    assert.deepEqual(result.saved, ["Markdown", "Notion"]);
    assert.deepEqual(result.failures, ["Excel: disk unavailable"]);
    assert.equal(calls[0].options.directory.name, "notes");
    assert.equal(calls[1].options.directory.name, "sheets");
    assert.equal(calls[2].options.settings.token, "initial");
    assert.equal(persisted.at(-1).notion.token, "updated");
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
