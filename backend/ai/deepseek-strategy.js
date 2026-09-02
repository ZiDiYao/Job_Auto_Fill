import { AiProviderStrategy } from "./ai-provider-strategy.js";

export class DeepSeekStrategy extends AiProviderStrategy {
  constructor(options) {
    super({ name: "DeepSeek", ...options });
  }

  async completeJson({ system, request, maxTokens = 4000, temperature = 0 }) {
    this.assertConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(request) },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
    if (!response.ok) await this.apiError(response);
    const payload = await response.json();
    return {
      data: this.parseJson(payload?.choices?.[0]?.message?.content),
      model: payload.model || this.model,
      usage: payload.usage || null,
      provider: "deepseek",
    };
  }
}
