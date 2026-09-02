import assert from "node:assert/strict";
import test from "node:test";

import {
  exchangeNotionAuthorizationCode,
  getNotionOAuthConfig,
  validateNotionRedirectUri,
} from "./notion-oauth.js";

test("loads Notion OAuth credentials without exposing policy in the extension", () => {
  assert.deepEqual(getNotionOAuthConfig({ notion: { oauth: { clientId: "config-id", clientSecret: "config-secret" } } }, {}), {
    clientId: "config-id",
    clientSecret: "config-secret",
  });
  assert.deepEqual(getNotionOAuthConfig({}, { NOTION_OAUTH_CLIENT_ID: "env-id", NOTION_OAUTH_CLIENT_SECRET: "env-secret" }), {
    clientId: "env-id",
    clientSecret: "env-secret",
  });
});

test("accepts only Chrome identity redirect URLs", () => {
  assert.equal(validateNotionRedirectUri("https://abc.chromiumapp.org/notion"), "https://abc.chromiumapp.org/notion");
  assert.equal(validateNotionRedirectUri("http://abc.chromiumapp.org/notion"), "");
  assert.equal(validateNotionRedirectUri("https://example.com/callback"), "");
});

test("exchanges a Notion authorization code using backend-only Basic authentication", async () => {
  let request;
  const result = await exchangeNotionAuthorizationCode({
    code: "temporary-code",
    redirectUri: "https://extension.chromiumapp.org/notion",
    config: { clientId: "client-id", clientSecret: "client-secret" },
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "workspace-token", workspace_id: "workspace-1", workspace_name: "My Workspace" };
        },
      };
    },
  });
  assert.equal(request.url, "https://api.notion.com/v1/oauth/token");
  assert.equal(request.init.headers.Authorization, `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  assert.deepEqual(request.body, {
    grant_type: "authorization_code",
    code: "temporary-code",
    redirect_uri: "https://extension.chromiumapp.org/notion",
  });
  assert.equal(result.accessToken, "workspace-token");
  assert.equal(result.workspaceName, "My Workspace");
});

test("refuses OAuth exchange when backend credentials or redirect URI are invalid", async () => {
  await assert.rejects(
    () => exchangeNotionAuthorizationCode({ code: "x", redirectUri: "https://x.chromiumapp.org/notion", config: {} }),
    /not configured/i,
  );
  await assert.rejects(
    () => exchangeNotionAuthorizationCode({ code: "x", redirectUri: "https://evil.example/callback", config: { clientId: "a", clientSecret: "b" } }),
    /invalid/i,
  );
});
