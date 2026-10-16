import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAiProvider } from "./openai.js";
import type { LlmProvider } from "./types.js";

export type { LlmProvider, ToolCall, ToolDef, LlmRequest } from "./types.js";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-2.0-flash",
} as const;

/**
 * Build a provider from env, or null when NLU is not configured.
 *   LLM_PROVIDER = openai | anthropic | gemini   ("ollama" is an alias for openai + local base URL)
 *   LLM_API_KEY, LLM_MODEL, LLM_BASE_URL
 * A key is required, except for OpenAI-compatible servers on a custom base URL (Ollama needs none).
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): LlmProvider | null {
  let kind = env.LLM_PROVIDER?.trim().toLowerCase();
  if (!kind) return null;
  let baseUrl = env.LLM_BASE_URL?.trim() || undefined;
  if (kind === "ollama") {
    kind = "openai";
    baseUrl ??= "http://localhost:11434/v1";
  }
  if (kind !== "openai" && kind !== "anthropic" && kind !== "gemini") {
    console.warn(`[nlu] unknown LLM_PROVIDER "${kind}", natural language mode disabled`);
    return null;
  }
  const apiKey = env.LLM_API_KEY?.trim() || undefined;
  if (!apiKey && !(kind === "openai" && baseUrl)) return null;
  const cfg = { apiKey, baseUrl, model: env.LLM_MODEL?.trim() || DEFAULT_MODELS[kind] };
  return kind === "openai" ? createOpenAiProvider(cfg) : kind === "anthropic" ? createAnthropicProvider(cfg) : createGeminiProvider(cfg);
}
