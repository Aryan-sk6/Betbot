import { expect, it } from "vitest";
import { createCliSession } from "../src/adapters/cli.js";
import { openDb } from "../src/db/db.js";

it("cli session switches users and advances the clock", async () => {
  const s = createCliSession({ db: openDb(":memory:") });
  await s.handleLine("as rahul: /new Q | closes in 1h");
  expect(await s.handleLine("as khush: /resolve 1 yes")).toContain("Only the market creator");
  await s.handleLine("as rahul: /balance");
  await s.handleLine(":advance 2h");
  expect(await s.handleLine("/bet 1 yes 10")).toContain("closed");
  expect(await s.handleLine("/resolve 1 yes")).toContain("resolved YES");
});
