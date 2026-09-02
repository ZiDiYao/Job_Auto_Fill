const NOTES_DATABASE = "job-autofill-file-handles";
const NOTES_STORE = "handles";
const NOTES_DIRECTORY_KEY = "job-notes-directory";

function cleanText(value, fallback = "") {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

export function sanitizeFileSegment(value, fallback = "Unknown") {
  const sanitized = cleanText(value, fallback)
    .replace(/[\\/:*?"<>|%\u0000-\u001f]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 72);
  return sanitized || fallback;
}

export function stableJobHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

function dateParts(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    date: valid.toISOString().slice(0, 10),
    timestamp: valid.toISOString(),
  };
}

export function createJobSummary(job = {}) {
  const explicit = cleanText(job.summary);
  if (explicit) return explicit.slice(0, 1200);

  const title = cleanText(job.jobTitle, "Unknown role");
  const company = cleanText(job.company, "Unknown company");
  const location = cleanText(job.location);
  const description = cleanText(job.jobDescription);
  const sentences = description.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const excerpt = sentences.map((sentence) => sentence.trim()).filter(Boolean).slice(0, 2).join(" ").slice(0, 700);
  return `${title} at ${company}${location ? ` in ${location}` : ""}.${excerpt ? ` ${excerpt}` : ""}`;
}

export function createApplicationRecord(job = {}) {
  const { date, timestamp } = dateParts(job.savedAt);
  const url = cleanText(job.url);
  const company = cleanText(job.company, "Unknown company");
  const title = cleanText(job.jobTitle, "Unknown role");
  return {
    jobKey: stableJobHash(url || `${company}|${title}|${cleanText(job.jobDescription).slice(0, 500)}`),
    applicationDate: date,
    applicationMonth: date.slice(0, 7),
    company,
    jobTitle: title,
    location: cleanText(job.location),
    status: cleanText(job.status, "Saved"),
    url,
    resumeName: cleanText(job.resumeName),
    summary: createJobSummary(job),
    jobDescription: String(job.jobDescription || "").trim(),
    savedAt: timestamp,
  };
}

export function createJobNoteFilename(job = {}) {
  const company = sanitizeFileSegment(job.company, "Unknown-company");
  const title = sanitizeFileSegment(job.jobTitle, "Unknown-role");
  const identity = cleanText(job.url) || `${company}|${title}|${cleanText(job.jobDescription).slice(0, 500)}`;
  return `${company} - ${title} - ${stableJobHash(identity)}.md`;
}

function yamlValue(value) {
  return JSON.stringify(cleanText(value));
}

export function createJobNote(job = {}) {
  const { date, timestamp } = dateParts(job.savedAt);
  const title = cleanText(job.jobTitle, "Unknown role");
  const company = cleanText(job.company, "Unknown company");
  const location = cleanText(job.location, "Not detected");
  const url = cleanText(job.url);
  const resumeName = cleanText(job.resumeName, "Not recorded");
  const description = String(job.jobDescription || "").trim();
  const summary = createJobSummary(job);

  if (!description) throw new Error("Add or detect a job description before saving a note.");

  return [
    "---",
    `title: ${yamlValue(title)}`,
    `company: ${yamlValue(company)}`,
    `location: ${yamlValue(location)}`,
    `source_url: ${yamlValue(url)}`,
    `saved_at: ${yamlValue(timestamp)}`,
    `application_date: ${yamlValue(date)}`,
    `resume: ${yamlValue(resumeName)}`,
    'status: "saved"',
    "tags:",
    "  - job-application",
    "---",
    "",
    `# ${company} — ${title}`,
    "",
    "## Application snapshot",
    "",
    `- **Location:** ${location}`,
    `- **Original posting:** ${url ? `[Open job posting](${url})` : "Not detected"}`,
    `- **Saved:** ${timestamp}`,
    `- **Resume used:** ${resumeName}`,
    "- **Application status:** Saved / Applied / Interview / Offer / Closed",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Interview preparation",
    "",
    "### Why this role",
    "",
    "- ",
    "",
    "### Most relevant experience",
    "",
    "1. ",
    "2. ",
    "3. ",
    "",
    "### Questions to ask",
    "",
    "1. ",
    "2. ",
    "",
    "### Interview notes",
    "",
    "- ",
    "",
    "## Original job description",
    "",
    description,
    "",
  ].join("\n");
}

export const APPLICATION_CSV_COLUMNS = [
  "Job Key",
  "Application Date",
  "Application Month",
  "Company",
  "Job Title",
  "Location",
  "Status",
  "Source URL",
  "Resume",
  "Summary",
  "Job Description",
  "Last Saved At",
];

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted && character === '"' && input[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function recordToCsvRow(record) {
  return [
    record.jobKey,
    record.applicationDate,
    record.applicationMonth,
    record.company,
    record.jobTitle,
    record.location,
    record.status,
    record.url,
    record.resumeName,
    record.summary,
    record.jobDescription,
    record.savedAt,
  ];
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

function openNotesDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) return Promise.reject(new Error("This browser cannot remember a notes folder."));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(NOTES_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTES_STORE)) {
        request.result.createObjectStore(NOTES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open notes storage."));
  });
}

async function useHandleStore(mode, action) {
  const database = await openNotesDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(NOTES_STORE, mode);
      const request = action(transaction.objectStore(NOTES_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not access the saved notes folder."));
      transaction.onabort = () => reject(transaction.error || new Error("Notes folder storage was interrupted."));
    });
  } finally {
    database.close();
  }
}

export function getSavedNotesDirectory() {
  return useHandleStore("readonly", (store) => store.get(NOTES_DIRECTORY_KEY));
}

export function rememberNotesDirectory(handle) {
  if (!handle || handle.kind !== "directory") throw new Error("Choose a valid folder.");
  return useHandleStore("readwrite", (store) => store.put(handle, NOTES_DIRECTORY_KEY));
}

export function forgetNotesDirectory() {
  return useHandleStore("readwrite", (store) => store.delete(NOTES_DIRECTORY_KEY));
}

export async function chooseNotesDirectory(picker = globalThis.showDirectoryPicker) {
  if (typeof picker !== "function") throw new Error("Folder selection is not supported by this browser.");
  const handle = await picker({ id: "job-autofill-notes", mode: "readwrite", startIn: "documents" });
  await rememberNotesDirectory(handle);
  return handle;
}

export async function hasDirectoryPermission(handle, request = false) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if (typeof handle.queryPermission !== "function") return true;
  if (await handle.queryPermission(options) === "granted") return true;
  if (!request || typeof handle.requestPermission !== "function") return false;
  return (await handle.requestPermission(options)) === "granted";
}

export async function writeJobNote(directoryHandle, job, { requestPermission = false } = {}) {
  if (!directoryHandle || directoryHandle.kind !== "directory") {
    throw new Error("Choose an interview-notes folder in settings first.");
  }
  if (!(await hasDirectoryPermission(directoryHandle, requestPermission))) {
    throw new Error("Open settings and grant write access to the saved notes folder again.");
  }

  const filename = createJobNoteFilename(job);
  const note = createJobNote(job);
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(note);
  } finally {
    await writable.close();
  }
  return { filename, directoryName: directoryHandle.name, bytes: new Blob([note]).size };
}

export async function writeApplicationSpreadsheet(
  directoryHandle,
  job,
  { requestPermission = false, filename = "Job Applications.csv" } = {},
) {
  if (!directoryHandle || directoryHandle.kind !== "directory") {
    throw new Error("Choose an application-history folder in settings first.");
  }
  if (!(await hasDirectoryPermission(directoryHandle, requestPermission))) {
    throw new Error("Open settings and grant write access to the saved application-history folder again.");
  }

  const safeFilename = `${sanitizeFileSegment(String(filename).replace(/\.csv$/i, ""), "Job Applications")}.csv`;
  const fileHandle = await directoryHandle.getFileHandle(safeFilename, { create: true });
  let existing = "";
  if (typeof fileHandle.getFile === "function") {
    const file = await fileHandle.getFile();
    existing = await file.text();
  }
  const csv = upsertApplicationCsv(existing, job);
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(csv);
  } finally {
    await writable.close();
  }
  return { filename: safeFilename, directoryName: directoryHandle.name, bytes: new Blob([csv]).size };
}
