export function cleanText(value, fallback = "") {
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

export function dateParts(value) {
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
