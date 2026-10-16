import type { EngineOptions } from "../core/engine.js";

/** What index.ts hands to every adapter; each adapter adds its own isAdmin. */
export type AdapterBase = Omit<EngineOptions, "isAdmin" | "now">;

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

export interface AdminParticipant {
  id: string;
  lid?: string;
  phoneNumber?: string;
  admin?: string | null;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}

/** Admin lookup against a group's participant list, cached per group. */
export function createAdminChecker(
  getMetadata: (groupId: string) => Promise<{ participants: AdminParticipant[] }>,
  ttlMs = 60_000,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { at: number; admins: Set<string> }>();
  return async (groupId: string, userId: string): Promise<boolean> => {
    let entry = cache.get(groupId);
    if (!entry || now() - entry.at > ttlMs) {
      const meta = await getMetadata(groupId);
      const admins = new Set<string>();
      for (const p of meta.participants) {
        if (!(p.admin || p.isAdmin || p.isSuperAdmin)) continue;
        // A participant can be known by several ids (e.g. WhatsApp LID and phone JID).
        for (const id of [p.id, p.lid, p.phoneNumber]) if (id) admins.add(id);
      }
      entry = { at: now(), admins };
      cache.set(groupId, entry);
    }
    return entry.admins.has(userId);
  };
}
