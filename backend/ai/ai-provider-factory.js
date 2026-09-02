import { DeepSeekStrategy } from "./deepseek-strategy.js";
import { OpenAiStrategy } from "./openai-strategy.js";

export class AiProviderFactory {
  constructor({ config = {}, env = process.env, fetchImpl = fetch } = {}) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  normalizeName(name) {
    const normalized = String(name || "deepseek").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "deepseek") return "deepseek";
    if (normalized === "openai") return "openai";
    throw Object.assign(new Error(`Unsupported backend AI provider: ${name}`), { statusCode: 400 });
  }

  create(name) {
    const provider = this.normalizeName(name);
    if (provider === "deepseek") {
      return new DeepSeekStrategy({
        apiKey: this.env.DEEPSEEK_API_KEY || this.config.deepSeek?.apiKey || "",
        baseUrl: this.env.DEEPSEEK_BASE_URL || this.config.deepSeek?.baseUrl || "https://api.deepseek.com",
        model: this.env.DEEPSEEK_MODEL || this.config.deepSeek?.model || "deepseek-v4-flash",
        fetchImpl: this.fetchImpl,
      });
    }
    return new OpenAiStrategy({
      apiKey: this.env.OPENAI_API_KEY || this.config.openAI?.apiKey || "",
      baseUrl: this.env.OPENAI_BASE_URL || this.config.openAI?.baseUrl || "https://api.openai.com/v1",
      model: this.env.OPENAI_MODEL || this.config.openAI?.model || "",
      fetchImpl: this.fetchImpl,
    });
  }

  status() {
    return Object.fromEntries(["deepseek", "openai"].map((name) => {
      const strategy = this.create(name);
      return [name, { configured: strategy.isConfigured(), model: strategy.model || null }];
    }));
  }
}
