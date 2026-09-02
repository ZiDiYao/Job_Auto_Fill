// Backward-compatible public surface. Implementations live in focused modules.
export {
  cleanText,
  createApplicationRecord,
  createJobSummary,
  dateParts,
  sanitizeFileSegment,
  stableJobHash,
} from "./application-record.js";
export {
  chooseNotesDirectory,
  forgetNotesDirectory,
  forgetExportDirectory,
  getSavedExportDirectory,
  getSavedNotesDirectory,
  hasDirectoryPermission,
  rememberNotesDirectory,
  rememberExportDirectory,
  chooseExportDirectory,
} from "./local-directory.js";
export {
  createJobNote,
  createJobNoteFilename,
  writeJobNote,
} from "./exporters/markdown-exporter.js";
export {
  APPLICATION_CSV_COLUMNS,
  upsertApplicationCsv,
  writeApplicationSpreadsheet,
} from "./exporters/excel-exporter.js";
