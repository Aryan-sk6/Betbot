import { postJson, type LlmProvider, type ProviderConfig } from "./types.js";

export function createAnthropicProvider(cfg: ProviderConfig): LlmProvider {
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    name: "anthropic",
    async call(req) {
      const data = await postJson(
        "anthropic",
        `${base}/v1/messages`,
        { "x-api-key": cfg.apiKey ?? "", "anthropic-version": "2023-06-01" },
        {
          model: cfg.model,
          max_tokens: 300,
          temperature: 0,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          tool_choice: { type: "any" },
        },
        cfg,
      );
      const block = (data?.content ?? []).find((b: any) => b?.type === "tool_use");
      return block?.name ? { name: block.name, arguments: block.input } : null;
    },
  };
}
