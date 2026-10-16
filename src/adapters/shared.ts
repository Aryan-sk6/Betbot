import type { EngineOptions } from "../core/engine.js";

/** What index.ts hands to every adapter. */
export type AdapterBase = Omit<EngineOptions, "now">;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sends one message at a time with a pause between sends, to avoid bursts. */
export class SendQueue<T = string> {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly send: (to: string, payload: T) => Promise<unknown>,
    private readonly delayMs = 700,
    private readonly sleep: (ms: number) => Promise<void> = sleepMs,
  ) {}

  enqueue(to: string, payload: T): Promise<void> {
    const run = this.tail.then(async () => {
      try {
        await this.send(to, payload);
      } catch (err) {
        console.error("[queue] send failed:", err);
      }
      await this.sleep(this.delayMs);
    });
    this.tail = run;
    return run;
  }
}
