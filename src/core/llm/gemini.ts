import { postJson, type LlmProvider, type ProviderConfig } from "./types.js";

export function createGeminiProvider(cfg: ProviderConfig): LlmProvider {
  const base = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  return {
    name: "gemini",
    async call(req) {
      const data = await postJson(
        "gemini",
        // The key goes in a header, never the URL, so it can't leak through logged URLs or errors.
        `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`,
        { "x-goog-api-key": cfg.apiKey ?? "" },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                // Gemini rejects empty `properties`, so parameterless tools omit the schema.
                ...(t.parameters.properties && Object.keys(t.parameters.properties).length ? { parameters: t.parameters } : {}),
              })),
            },
          ],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
        },
        cfg,
      );
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const fc = parts.find((p) => p?.functionCall)?.functionCall;
      return fc?.name ? { name: fc.name, arguments: fc.args ?? {} } : null;
    },
  };
}
