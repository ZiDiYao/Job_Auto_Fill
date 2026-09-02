import { ApplicationExporterFactory } from "./exporters/exporter-factory.js";

const DESTINATION_LABELS = { markdown: "Markdown", spreadsheet: "Excel", notion: "Notion" };

export async function exportApplication({ settings, job, directories = {}, persistNotionSettings }) {
  const enabled = Object.entries(settings?.destinations || {})
    .filter(([, selected]) => selected === true)
    .map(([type]) => type);
  if (!enabled.length) throw new Error("Enable at least one application-history export in settings.");

  const saved = [];
  const failures = [];
  let latestSettings = settings;
  for (const type of enabled) {
    const label = DESTINATION_LABELS[type] || type;
    try {
      const exporter = ApplicationExporterFactory.create(type, {
        directory: directories[type],
        filename: settings.spreadsheetFilename,
        settings: latestSettings.notion,
        onProgress: async (notion) => {
          latestSettings = { ...latestSettings, notion };
          await persistNotionSettings?.(latestSettings);
        },
      });
      const result = await exporter.save(job);
      if (type === "notion") {
        latestSettings = { ...latestSettings, notion: result.workspace };
        await persistNotionSettings?.(latestSettings);
      }
      saved.push(label);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  if (!saved.length) throw new Error(failures.join(" · ") || "No application record was saved.");
  return { saved, failures, settings: latestSettings };
}
