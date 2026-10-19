import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Budget } from "../src/acp/budget.ts";
import { tempDir } from "./helpers.ts";

const limits = { workSec: 300, submissionSec: 150, finalSec: 150, maxTokens: 1000, maxOutputTokens: 100 };
describe("durable member budget", () => {
  it("keeps the original deadline and usage on resume", async () => {
    const path = join(await tempDir(), "budget.json");
    const first = new Budget(path, limits, 1000);
    first.addUsage(800, 20);
    first.unknownUsage();
    const resumed = new Budget(path, limits, 999999);
    expect(resumed.phase(301000)).toBe("submit");
    expect(resumed.phase(451000)).toBe("final");
    expect(resumed.phase(601000)).toBe("stopped");
    expect(resumed.remaining("stopped", 601000)).toBe(0);
    expect(resumed.exhausted()).toBe(false);
    resumed.addUsage(200, 0);
    expect(resumed.exhausted()).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"usageKnown":false');
    expect(() => new Budget(path, { ...limits, workSec: 600 })).toThrow("limits changed");
  });
  it("does not add unused work time to either submission period", async () => {
    const budget = new Budget(join(await tempDir(), "budget.json"), limits, 1000);
    budget.advance(2000);
    expect(budget.phase(2000)).toBe("submit");
    expect(budget.remaining("submit", 2000)).toBe(150000);
    budget.advance(3000);
    expect(budget.phase(3000)).toBe("final");
    expect(budget.remaining("final", 3000)).toBe(150000);
    budget.advance(4000);
    expect(budget.phase(4000)).toBe("stopped");
    budget.addUsage(1, 100);
    expect(budget.exhausted()).toBe(true);
  });
  it("reserves tokens for submission and never extends an expired deadline", async () => {
    const budget = new Budget(join(await tempDir(), "budget.json"), limits);
    budget.addUsage(700, 0);
    expect(budget.phase()).toBe("submit");
    budget.addUsage(150, 0);
    expect(budget.phase()).toBe("final");
    expect(budget.exhausted()).toBe(false);
    budget.addUsage(150, 0);
    expect(budget.exhausted()).toBe(true);
    const end = Date.now() + 1000000;
    budget.advance(end);
    expect(budget.remaining("final", end - 1)).toBe(0);
  });

  it("fails closed on damaged saved state", async () => {
    const path = join(await tempDir(), "budget.json");
    writeFileSync(path, "{}");
    expect(() => new Budget(path, limits)).toThrow();
  });
});
