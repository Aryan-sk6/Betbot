// Provider-neutral shapes for "give the model some tools and read back one tool call".

export interface JsonSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
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
    detail = "",
  ) {
    super(`${provider} request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
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
  if (!res.ok) throw new LlmError(provider, res.status, await errorDetail(res, cfg.apiKey));
  return res.json();
}

/** The provider's own error text (e.g. "model not found"), with anything key-like removed. */
async function errorDetail(res: Response, apiKey?: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const e = body?.error as { message?: unknown } | string | undefined;
    let msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
    if (apiKey) msg = msg.split(apiKey).join("[redacted]");
    return msg.replace(/[A-Za-z0-9_.\-]{28,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}
