export class AiProviderStrategy {
  constructor({ name, apiKey, baseUrl, model, fetchImpl = fetch }) {
    this.name = name;
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.model = String(model || "").trim();
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.apiKey && !this.apiKey.startsWith("replace_with_") && this.model);
  }

  assertConfigured() {
    if (!this.apiKey || this.apiKey.startsWith("replace_with_")) {
      throw Object.assign(new Error(`${this.name} API key is not configured.`), { statusCode: 503 });
    }
    if (!this.model) {
      throw Object.assign(new Error(`${this.name} model is not configured.`), { statusCode: 503 });
    }
  }

  async apiError(response) {
    const detail = await response.text();
    throw Object.assign(
      new Error(`${this.name} returned ${response.status}: ${detail.slice(0, 300)}`),
      { statusCode: 502 },
    );
  }

  parseJson(text) {
    const value = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
    if (!value) throw Object.assign(new Error(`${this.name} returned an empty response.`), { statusCode: 502 });
    try {
      return JSON.parse(value);
    } catch {
      throw Object.assign(new Error(`${this.name} returned invalid JSON.`), { statusCode: 502 });
    }
  }

  async completeJson(_request) {
    throw new Error("AI provider strategy must implement completeJson().");
  }
}
