import { AiProviderStrategy } from "./ai-provider-strategy.js";

export class OpenAiStrategy extends AiProviderStrategy {
  constructor(options) {
    super({ name: "OpenAI", ...options });
  }

  async completeJson({ system, request, maxTokens = 4000 }) {
    this.assertConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        instructions: system,
        input: JSON.stringify(request),
        text: { format: { type: "json_object" } },
        max_output_tokens: maxTokens,
        store: false,
      }),
    });
    if (!response.ok) await this.apiError(response);
    const payload = await response.json();
    const outputText = payload.output_text || (Array.isArray(payload.output)
      ? payload.output.flatMap((item) => item?.content || [])
        .find((content) => content?.type === "output_text")?.text
      : "");
    return {
      data: this.parseJson(outputText),
      model: payload.model || this.model,
      usage: payload.usage || null,
      provider: "openai",
    };
  }
}
