const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export function getNotionOAuthConfig(config = {}, env = process.env) {
  return {
    clientId: String(env.NOTION_OAUTH_CLIENT_ID || config.notion?.oauth?.clientId || "").trim(),
    clientSecret: String(env.NOTION_OAUTH_CLIENT_SECRET || config.notion?.oauth?.clientSecret || "").trim(),
  };
}

export function validateNotionRedirectUri(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return ""; }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".chromiumapp.org")) return "";
  return url.toString();
}

export async function exchangeNotionAuthorizationCode({ code, redirectUri, config, fetchImpl = globalThis.fetch }) {
  const authorizationCode = String(code || "").trim();
  const safeRedirectUri = validateNotionRedirectUri(redirectUri);
  if (!config?.clientId || !config?.clientSecret) {
    throw Object.assign(new Error("Notion OAuth is not configured in the local backend."), { statusCode: 503 });
  }
  if (!authorizationCode || !safeRedirectUri) {
    throw Object.assign(new Error("The Notion authorization response is invalid."), { statusCode: 400 });
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
  const response = await fetchImpl(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "Notion-Version": "2026-03-11",
    },
    body: JSON.stringify({ grant_type: "authorization_code", code: authorizationCode, redirect_uri: safeRedirectUri }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const detail = String(payload.error_description || payload.message || payload.error || `HTTP ${response.status}`).slice(0, 300);
    throw Object.assign(new Error(`Notion OAuth: ${detail}`), { statusCode: response.status >= 400 && response.status < 500 ? 400 : 502 });
  }
  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type || "bearer",
    workspaceId: payload.workspace_id || "",
    workspaceName: payload.workspace_name || "",
    workspaceIcon: payload.workspace_icon || "",
    botId: payload.bot_id || "",
    owner: payload.owner || null,
    duplicatedTemplateId: payload.duplicated_template_id || "",
    requestId: payload.request_id || "",
  };
}
