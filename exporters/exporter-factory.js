import { ExcelExporter } from "./excel-exporter.js";
import { MarkdownExporter } from "./markdown-exporter.js";

export class ApplicationExporterFactory {
  static create(type, options = {}) {
    if (type === "markdown") return new MarkdownExporter(options);
    if (type === "spreadsheet") return new ExcelExporter(options);
    throw new Error(`Unsupported application export type: ${type}`);
  }
}
