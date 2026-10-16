// Provider-neutral shapes for "give the model some tools and read back one tool call".

export interface JsonSchema {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmRequest {
  system: string;
  user: string;
  tools: ToolDef[];
}

export interface ToolCall {
  name: string;
  arguments: unknown;
}

export interface LlmProvider {
  readonly name: string;
  /** Returns the first tool call the model made, or null if it answered in prose. */
  call(req: LlmRequest): Promise<ToolCall | null>;
}

export interface ProviderConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Thrown for HTTP errors. Carries only the status, never the request (it holds the API key). */
export class LlmError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} request failed with HTTP ${status}`);
  }
}

export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  cfg: ProviderConfig,
): Promise<any> {
  const res = await (cfg.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new LlmError(provider, res.status);
  return res.json();
}
