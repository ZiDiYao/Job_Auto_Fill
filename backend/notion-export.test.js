import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotionPageMarkdown,
  createNotionWorkspace,
  normalizeNotionPageId,
  saveJobToNotion,
} from "../notion-export.js";

const job = {
  jobTitle: "Software Developer",
  company: "Example Corp",
  location: "Toronto, ON",
  url: "https://example.com/jobs/42",
  resumeName: "Resume.pdf",
  savedAt: "2026-09-02T14:00:00.000Z",
  status: "Applied",
  jobDescription: "Build reliable APIs. Collaborate with product and engineering.",
};

function response(payload, ok = true, status = 200) {
  return { ok, status, async json() { return payload; } };
}

test("normalizes Notion page URLs and IDs", () => {
  assert.equal(
    normalizeNotionPageId("https://www.notion.so/Workspace-0123456789abcdef0123456789abcdef?pvs=4"),
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.equal(
    normalizeNotionPageId("https://notion.so/My-Page-01234567-89ab-cdef-0123-456789abcdef"),
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.equal(normalizeNotionPageId("not-an-id"), "");
});

test("creates a root page and inline Application List data source", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.endsWith("/pages")) return response({ id: "11111111-1111-1111-1111-111111111111" });
    return response({
      id: "22222222-2222-2222-2222-222222222222",
      data_sources: [{ id: "33333333-3333-3333-3333-333333333333" }],
    });
  };
  const workspace = await createNotionWorkspace({
    token: "notion-test-token",
    parentPageId: "00000000000000000000000000000000",
    rootPageTitle: "My Job Search",
  }, { fetchImpl });
  assert.equal(workspace.rootPageId, "11111111-1111-1111-1111-111111111111");
  assert.equal(workspace.dataSourceId, "33333333-3333-3333-3333-333333333333");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.is_inline, true);
  assert.ok(calls[1].body.initial_data_source.properties["Application Date"]);
  assert.ok(calls[1].body.initial_data_source.properties.Summary);
});

test("OAuth connections can create the root page at workspace level without a parent page ID", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/pages")) return response({ id: "11111111-1111-1111-1111-111111111111" });
    return response({ id: "22222222-2222-2222-2222-222222222222", data_sources: [{ id: "33333333-3333-3333-3333-333333333333" }] });
  };
  await createNotionWorkspace({ token: "oauth-token", workspaceLevel: true }, { fetchImpl });
  assert.deepEqual(calls[0].body.parent, { type: "workspace", workspace: true });
});

test("creates a clickable Notion application row with summary and JD content", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes("/query")) return response({ results: [] });
    return response({ id: "44444444-4444-4444-4444-444444444444" });
  };
  const settings = {
    token: "notion-test-token",
    parentPageId: "00000000-0000-0000-0000-000000000000",
    rootPageId: "11111111-1111-1111-1111-111111111111",
    databaseId: "22222222-2222-2222-2222-222222222222",
    dataSourceId: "33333333-3333-3333-3333-333333333333",
  };
  const result = await saveJobToNotion(settings, job, { fetchImpl });
  assert.equal(result.updated, false);
  const create = calls.find((call) => call.url.endsWith("/pages"));
  assert.equal(create.body.parent.data_source_id, settings.dataSourceId);
  assert.equal(create.body.properties.Status.select.name, "Applied");
  assert.match(create.body.markdown, /## Summary/);
  assert.match(create.body.markdown, /## Job description/);
  assert.match(createNotionPageMarkdown(job), /Build reliable APIs/);
});

test("updates an existing Notion row and replaces its detail content", async () => {
  const calls = [];
  const existingId = "55555555-5555-5555-5555-555555555555";
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes("/query")) return response({ results: [{ id: existingId }] });
    return response({ id: existingId });
  };
  const result = await saveJobToNotion({
    token: "notion-test-token",
    parentPageId: "00000000-0000-0000-0000-000000000000",
    rootPageId: "11111111-1111-1111-1111-111111111111",
    dataSourceId: "33333333-3333-3333-3333-333333333333",
  }, job, { fetchImpl });
  assert.equal(result.updated, true);
  assert.ok(calls.some((call) => call.url.endsWith(`/pages/${existingId}`)));
  const markdownUpdate = calls.find((call) => call.url.endsWith(`/pages/${existingId}/markdown`));
  assert.equal(markdownUpdate.body.type, "replace_content");
});
