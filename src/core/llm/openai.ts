import { postJson, type LlmProvider, type ProviderConfig } from "./types.js";

/** OpenAI-compatible chat completions. Works with OpenAI, Ollama, vLLM, LM Studio, OpenRouter, ... */
export function createOpenAiProvider(cfg: ProviderConfig): LlmProvider {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  // Only the real OpenAI API reliably supports forcing a tool call; local servers may reject it.
  const toolChoice = base === "https://api.openai.com/v1" ? "required" : "auto";
  return {
    name: "openai",
    async call(req) {
      const data = await postJson(
        "openai",
        `${base}/chat/completions`,
        cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        {
          model: cfg.model,
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: toolChoice,
        },
        cfg,
      );
      const call = data?.choices?.[0]?.message?.tool_calls?.[0]?.function;
      if (!call?.name) return null;
      try {
        return { name: call.name, arguments: typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments };
      } catch {
        return null;
      }
    },
  };
}
