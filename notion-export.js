import { createApplicationRecord, createJobSummary } from "./application-record.js";

export const NOTION_API_VERSION = "2026-03-11";
const NOTION_API = "https://api.notion.com/v1";

function textContent(value, limit = 2000) {
  return String(value || "").trim().slice(0, limit);
}

function richText(value, limit = 2000) {
  const content = textContent(value, limit);
  return content ? [{ type: "text", text: { content } }] : [];
}

export function normalizeNotionPageId(value) {
  const input = String(value || "");
  const compact = input.match(/[0-9a-f]{32}/i)?.[0]
    || input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0].replace(/-/g, "")
    || input.replace(/[^0-9a-f]/gi, "");
  if (compact.length !== 32) return "";
  return compact.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5").toLowerCase();
}

async function notionRequest(settings, path, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const token = String(settings?.token || "").trim();
  if (!token) throw new Error("Add your Notion integration token in settings.");
  const response = await fetchImpl(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = textContent(payload?.message || payload?.code || `HTTP ${response.status}`, 300);
    throw new Error(`Notion: ${detail}`);
  }
  return payload;
}

export function createNotionPageMarkdown(job = {}) {
  const summary = createJobSummary(job);
  const description = String(job.jobDescription || "").trim();
  return [
    "## Summary",
    "",
    summary,
    "",
    "## Application details",
    "",
    `- **Company:** ${textContent(job.company, 300) || "Unknown company"}`,
    `- **Role:** ${textContent(job.jobTitle, 300) || "Unknown role"}`,
    `- **Location:** ${textContent(job.location, 300) || "Not detected"}`,
    `- **Source:** ${textContent(job.url, 1000) || "Not detected"}`,
    `- **Resume:** ${textContent(job.resumeName, 300) || "Not recorded"}`,
    "",
    "## Interview preparation",
    "",
    "### Why this role",
    "",
    "- ",
    "",
    "### Relevant experience",
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
    "## Job description",
    "",
    description,
  ].join("\n");
}

export async function createNotionWorkspace(settings = {}, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const next = { ...settings };
  const parentPageId = normalizeNotionPageId(next.parentPageId);
  if (!parentPageId && next.workspaceLevel !== true) throw new Error("Add a valid Notion parent page ID or sign in with Notion.");

  if (!normalizeNotionPageId(next.rootPageId)) {
    const root = await notionRequest(next, "/pages", {
      method: "POST",
      fetchImpl,
      body: {
        parent: parentPageId
          ? { type: "page_id", page_id: parentPageId }
          : { type: "workspace", workspace: true },
        properties: { title: { title: richText(next.rootPageTitle || "Job Application", 200) } },
        icon: { type: "emoji", emoji: "💼" },
        markdown: "Track saved applications, revisit job descriptions, and prepare for interviews from one place.",
      },
    });
    next.rootPageId = root.id;
    await onProgress?.({ ...next });
  }

  if (!normalizeNotionPageId(next.dataSourceId)) {
    const database = await notionRequest(next, "/databases", {
      method: "POST",
      fetchImpl,
      body: {
        parent: { type: "page_id", page_id: normalizeNotionPageId(next.rootPageId) },
        title: richText("Application List", 200),
        is_inline: true,
        initial_data_source: {
          properties: {
            Application: { title: {} },
            Company: { rich_text: {} },
            Role: { rich_text: {} },
            Location: { rich_text: {} },
            "Application Date": { date: {} },
            Status: {
              select: {
                options: [
                  { name: "Saved", color: "blue" },
                  { name: "Applied", color: "purple" },
                  { name: "Interview", color: "yellow" },
                  { name: "Offer", color: "green" },
                  { name: "Closed", color: "gray" },
                ],
              },
            },
            "Source URL": { url: {} },
            Resume: { rich_text: {} },
            Summary: { rich_text: {} },
            "Job Key": { rich_text: {} },
            "Last Saved At": { date: {} },
          },
        },
      },
    });
    next.databaseId = database.id;
    next.dataSourceId = database.data_sources?.[0]?.id || "";
    if (!next.dataSourceId) throw new Error("Notion created the database but did not return its data source ID.");
    await onProgress?.({ ...next });
  }

  return next;
}

function notionPageProperties(job) {
  const record = createApplicationRecord(job);
  return {
    Application: { title: richText(`${record.company} — ${record.jobTitle}`, 500) },
    Company: { rich_text: richText(record.company) },
    Role: { rich_text: richText(record.jobTitle) },
    Location: { rich_text: richText(record.location) },
    "Application Date": { date: { start: record.applicationDate } },
    Status: { select: { name: record.status } },
    "Source URL": { url: record.url || null },
    Resume: { rich_text: richText(record.resumeName) },
    Summary: { rich_text: richText(record.summary) },
    "Job Key": { rich_text: richText(record.jobKey) },
    "Last Saved At": { date: { start: record.savedAt } },
  };
}

export async function verifyNotionWorkspace(settings, { fetchImpl = globalThis.fetch } = {}) {
  const dataSourceId = normalizeNotionPageId(settings?.dataSourceId);
  if (!dataSourceId) throw new Error("Set up the Notion workspace first.");
  await notionRequest(settings, `/data_sources/${dataSourceId}`, { fetchImpl });
  return true;
}

export async function saveJobToNotion(settings, job, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  if (!String(job?.jobDescription || "").trim()) throw new Error("Add or detect a job description before saving to Notion.");
  const workspace = await createNotionWorkspace(settings, { fetchImpl, onProgress });
  const dataSourceId = normalizeNotionPageId(workspace.dataSourceId);
  const record = createApplicationRecord(job);
  const query = await notionRequest(workspace, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    fetchImpl,
    body: {
      page_size: 1,
      filter: { property: "Job Key", rich_text: { equals: record.jobKey } },
    },
  });
  const existing = query.results?.[0];
  const properties = notionPageProperties(job);
  const markdown = createNotionPageMarkdown(job);

  if (existing?.id) {
    await notionRequest(workspace, `/pages/${existing.id}`, { method: "PATCH", fetchImpl, body: { properties } });
    await notionRequest(workspace, `/pages/${existing.id}/markdown`, {
      method: "PATCH",
      fetchImpl,
      body: { type: "replace_content", replace_content: { new_str: markdown } },
    });
    return { pageId: existing.id, updated: true, workspace };
  }

  const page = await notionRequest(workspace, "/pages", {
    method: "POST",
    fetchImpl,
    body: {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
      icon: { type: "emoji", emoji: "📌" },
      markdown,
    },
  });
  return { pageId: page.id, updated: false, workspace };
}
