const MAX_JOB_DESCRIPTION_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);

function extensionOf(filename) {
  return String(filename || "").split(".").pop().toLocaleLowerCase("en");
}

export function validateJobDescriptionFile(file) {
  if (!file) throw new Error("Choose a job-description file.");
  const extension = extensionOf(file.name);
  if (extension !== "pdf" && !TEXT_EXTENSIONS.has(extension)) {
    throw new Error("Upload a PDF, TXT, or Markdown job description.");
  }
  if (!Number(file.size) || Number(file.size) > MAX_JOB_DESCRIPTION_FILE_BYTES) {
    throw new Error("The job-description file must be no larger than 5 MB.");
  }
  return extension;
}

export function normalizeJobDescriptionText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 30000);
}

async function readPdfText(file) {
  const { getDocument } = await import("./vendor/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableWorker: true });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
    }
    return pages.join("\n\n");
  } finally {
    await pdf.destroy();
  }
}

export async function readJobDescriptionFile(file) {
  const extension = validateJobDescriptionFile(file);
  const rawText = extension === "pdf" ? await readPdfText(file) : await file.text();
  const text = normalizeJobDescriptionText(rawText);
  if (text.length < 80) throw new Error("The selected file does not contain enough readable job-description text.");
  return text;
}
