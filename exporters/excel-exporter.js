import { createApplicationRecord, sanitizeFileSegment } from "../application-record.js";
import { hasDirectoryPermission } from "../local-directory.js";

export const APPLICATION_CSV_COLUMNS = [
  "Job Key", "Application Date", "Application Month", "Company", "Job Title", "Location", "Status", "Source URL",
  "Resume", "Summary", "Job Description", "Last Saved At",
];

function csvCell(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted && character === '"' && input[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function recordToCsvRow(record) {
  return [record.jobKey, record.applicationDate, record.applicationMonth, record.company, record.jobTitle, record.location,
    record.status, record.url, record.resumeName, record.summary, record.jobDescription, record.savedAt];
}

export function upsertApplicationCsv(existingCsv, job) {
  const record = createApplicationRecord(job);
  if (!record.jobDescription) throw new Error("Add or detect a job description before saving the spreadsheet record.");
  const parsed = parseCsv(existingCsv);
  const dataRows = parsed[0]?.[0] === APPLICATION_CSV_COLUMNS[0] ? parsed.slice(1) : [];
  const nextRow = recordToCsvRow(record);
  const existingIndex = dataRows.findIndex((row) => row[0] === record.jobKey);
  if (existingIndex >= 0) dataRows[existingIndex] = nextRow;
  else dataRows.push(nextRow);
  return `\uFEFF${[APPLICATION_CSV_COLUMNS, ...dataRows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export async function writeApplicationSpreadsheet(directoryHandle, job, { requestPermission = false, filename = "Job Applications.csv" } = {}) {
  if (!directoryHandle || directoryHandle.kind !== "directory") throw new Error("Choose an Excel export folder in settings first.");
  if (!(await hasDirectoryPermission(directoryHandle, requestPermission))) {
    throw new Error("Open settings and grant write access to the saved Excel export folder again.");
  }
  const safeFilename = `${sanitizeFileSegment(String(filename).replace(/\.csv$/i, ""), "Job Applications")}.csv`;
  const fileHandle = await directoryHandle.getFileHandle(safeFilename, { create: true });
  let existing = "";
  if (typeof fileHandle.getFile === "function") existing = await (await fileHandle.getFile()).text();
  const csv = upsertApplicationCsv(existing, job);
  const writable = await fileHandle.createWritable();
  try { await writable.write(csv); } finally { await writable.close(); }
  return { filename: safeFilename, directoryName: directoryHandle.name, bytes: new Blob([csv]).size };
}

export class ExcelExporter {
  constructor({ directory, filename = "Job Applications.csv", requestPermission = false } = {}) {
    this.directory = directory;
    this.filename = filename;
    this.requestPermission = requestPermission;
  }

  save(job) {
    return writeApplicationSpreadsheet(this.directory, job, { filename: this.filename, requestPermission: this.requestPermission });
  }
}
