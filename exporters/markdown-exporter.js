import { cleanText, createJobSummary, dateParts, sanitizeFileSegment, stableJobHash } from "../application-record.js";
import { hasDirectoryPermission } from "../local-directory.js";

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
  if (!description) throw new Error("Add or detect a job description before saving a note.");

  return [
    "---", `title: ${yamlValue(title)}`, `company: ${yamlValue(company)}`, `location: ${yamlValue(location)}`,
    `source_url: ${yamlValue(url)}`, `saved_at: ${yamlValue(timestamp)}`, `application_date: ${yamlValue(date)}`,
    `resume: ${yamlValue(resumeName)}`, 'status: "saved"', "tags:", "  - job-application", "---", "",
    `# ${company} — ${title}`, "", "## Application snapshot", "", `- **Location:** ${location}`,
    `- **Original posting:** ${url ? `[Open job posting](${url})` : "Not detected"}`, `- **Saved:** ${timestamp}`,
    `- **Resume used:** ${resumeName}`, "- **Application status:** Saved / Applied / Interview / Offer / Closed", "",
    "## Summary", "", createJobSummary(job), "", "## Interview preparation", "", "### Why this role", "", "- ", "",
    "### Most relevant experience", "", "1. ", "2. ", "3. ", "", "### Questions to ask", "", "1. ", "2. ", "",
    "### Interview notes", "", "- ", "", "## Original job description", "", description, "",
  ].join("\n");
}

export async function writeJobNote(directoryHandle, job, { requestPermission = false } = {}) {
  if (!directoryHandle || directoryHandle.kind !== "directory") throw new Error("Choose a Markdown folder in settings first.");
  if (!(await hasDirectoryPermission(directoryHandle, requestPermission))) {
    throw new Error("Open settings and grant write access to the saved Markdown folder again.");
  }
  const filename = createJobNoteFilename(job);
  const note = createJobNote(job);
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try { await writable.write(note); } finally { await writable.close(); }
  return { filename, directoryName: directoryHandle.name, bytes: new Blob([note]).size };
}

export class MarkdownExporter {
  constructor({ directory, requestPermission = false } = {}) {
    this.directory = directory;
    this.requestPermission = requestPermission;
  }

  save(job) {
    return writeJobNote(this.directory, job, { requestPermission: this.requestPermission });
  }
}
