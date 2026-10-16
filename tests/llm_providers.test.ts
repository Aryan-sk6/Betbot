import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../src/core/llm/anthropic.js";
import { createGeminiProvider } from "../src/core/llm/gemini.js";
import { createOpenAiProvider } from "../src/core/llm/openai.js";
import { LlmError, type LlmRequest } from "../src/core/llm/types.js";

const req: LlmRequest = {
  system: "sys",
  user: "usr",
  tools: [
    { name: "submit_command", description: "d", parameters: { type: "object", properties: { type: { type: "string" } }, required: ["type"] } },
    { name: "no_command", description: "d", parameters: { type: "object", properties: {} } },
  ],
};

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const sent = (f: ReturnType<typeof reply>) => {
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

describe("OpenAI-compatible", () => {
  it("sends tools and parses stringified arguments", async () => {
    const f = reply({ choices: [{ message: { tool_calls: [{ function: { name: "submit_command", arguments: '{"type":"balance"}' } }] } }] });
    const p = createOpenAiProvider({ apiKey: "sk-secret", model: "m", fetch: f as unknown as typeof fetch });
    expect(await p.call(req)).toEqual({ name: "submit_command", arguments: { type: "balance" } });
    const s = sent(f);
    expect(s.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(s.headers.authorization).toBe("Bearer sk-secret");
    expect(s.body.tool_choice).toBe("required");
    expect(s.body.tools[0]).toMatchObject({ type: "function", function: { name: "submit_command" } });
  });

  it("works against a custom base URL (Ollama) without a key", async () => {
    const f = reply({ choices: [{ message: { content: "hello" } }] });
    const p = createOpenAiProvider({ baseUrl: "http://localhost:11434/v1/", model: "llama3.1", fetch: f as unknown as typeof fetch });
    expect(await p.call(req)).toBeNull();
    const s = sent(f);
    expect(s.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(s.headers.authorization).toBeUndefined();
    expect(s.body.tool_choice).toBe("auto");
  });

  it("returns null on malformed argument JSON", async () => {
    const f = reply({ choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{oops" } }] } }] });
    expect(await createOpenAiProvider({ model: "m", fetch: f as unknown as typeof fetch }).call(req)).toBeNull();
  });
});

describe("Anthropic", () => {
  it("maps tools to input_schema and reads tool_use", async () => {
    const f = reply({ content: [{ type: "text", text: "..." }, { type: "tool_use", name: "submit_command", input: { type: "help" } }] });
    const p = createAnthropicProvider({ apiKey: "sk-ant-secret", model: "claude-haiku-5-5", fetch: f as unknown as typeof fetch });
    expect(await p.call(req)).toEqual({ name: "submit_command", arguments: { type: "help" } });
    const s = sent(f);
    expect(s.url).toBe("https://api.anthropic.com/v1/messages");
    expect(s.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(s.body.tool_choice).toEqual({ type: "any" });
    expect(s.body.tools[0].input_schema.required).toEqual(["type"]);
    expect(s.body.system).toBe("sys");
  });
});

describe("Gemini", () => {
  it("keeps the API key out of the URL and reads functionCall", async () => {
    const f = reply({ candidates: [{ content: { parts: [{ functionCall: { name: "submit_command", args: { type: "markets" } } }] } }] });
    const p = createGeminiProvider({ apiKey: "AIza-secret", model: "gemini-2.0-flash", fetch: f as unknown as typeof fetch });
    expect(await p.call(req)).toEqual({ name: "submit_command", arguments: { type: "markets" } });
    const s = sent(f);
    expect(s.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
    expect(s.url).not.toContain("AIza");
    expect(s.headers["x-goog-api-key"]).toBe("AIza-secret");
    expect(s.body.toolConfig.functionCallingConfig.mode).toBe("ANY");
    const decls = s.body.tools[0].functionDeclarations;
    expect(decls[0].parameters).toBeDefined();
    expect(decls[1].parameters).toBeUndefined(); // empty-property tool has no schema
  });
});

describe("errors", () => {
  it("HTTP errors carry the status but never the key", async () => {
    const f = reply({ error: "nope" }, 401);
    const p = createOpenAiProvider({ apiKey: "sk-secret", model: "m", fetch: f as unknown as typeof fetch });
    const err = await p.call(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toBe("openai request failed with HTTP 401: nope");
    expect(String(err.stack)).not.toContain("sk-secret");
  });

  it("includes the provider's reason but redacts the key if it is echoed back", async () => {
    const f = reply({ error: { message: "models/foo is not found. bad key sk-secret-1234 AIzaSyA1234567890abcdefghijklmnopqrstu" } }, 404);
    const p = createOpenAiProvider({ apiKey: "sk-secret-1234", model: "foo", fetch: f as unknown as typeof fetch });
    const err = await p.call(req).catch((e) => e);
    expect(err.message).toContain("models/foo is not found");
    expect(err.message).not.toContain("sk-secret-1234");
    expect(err.message).not.toContain("AIzaSy");
  });
});
