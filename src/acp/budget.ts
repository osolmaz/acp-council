import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

const limitsSchema = z.object({
  workSec: z.number().positive(),
  submissionSec: z.number().positive(),
  finalSec: z.number().positive(),
  maxTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});
export type SessionBudget = z.infer<typeof limitsSchema>;

const stateSchema = z.object({
  limits: limitsSchema,
  started: z.number(),
  workEnd: z.number(),
  submitEnd: z.number(),
  finalEnd: z.number(),
  tokens: z.number().nonnegative(),
  output: z.number().nonnegative(),
  usageKnown: z.boolean(),
});
export type BudgetPhase = "work" | "submit" | "final" | "stopped";

/** One member's wall-clock allowance survives adapter replacement and run resume. */
export class Budget {
  private state: z.infer<typeof stateSchema>;
  readonly limits: SessionBudget;
  private readonly path: string;

  constructor(path: string, limits: SessionBudget, now = Date.now()) {
    this.path = path;
    this.limits = limits;
    this.state = existsSync(path)
      ? stateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : {
          limits: limitsSchema.parse(limits),
          started: now,
          workEnd: now + limits.workSec * 1000,
          submitEnd: now + (limits.workSec + limits.submissionSec) * 1000,
          finalEnd: now + (limits.workSec + limits.submissionSec + limits.finalSec) * 1000,
          tokens: 0,
          output: 0,
          usageKnown: true,
        };
    if (JSON.stringify(this.state.limits) !== JSON.stringify(limitsSchema.parse(limits))) {
      throw new Error("member limits changed during resume");
    }
    this.save();
  }

  private save(): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.state));
    renameSync(`${this.path}.tmp`, this.path);
  }

  phase(now = Date.now()): BudgetPhase {
    if (now < this.state.workEnd) return "work";
    if (now < this.state.submitEnd) return "submit";
    return now < this.state.finalEnd ? "final" : "stopped";
  }

  remaining(phase: BudgetPhase, now = Date.now()): number {
    const end = phase === "work" ? this.state.workEnd : phase === "submit" ? this.state.submitEnd : this.state.finalEnd;
    return phase === "stopped" ? 0 : Math.max(0, end - now);
  }

  /** Early submission never inherits unused investigation time. */
  advance(now = Date.now()): void {
    const phase = this.phase(now);
    if (phase === "work") {
      this.state.workEnd = now;
      this.state.submitEnd = Math.min(this.state.submitEnd, now + this.limits.submissionSec * 1000);
      this.state.finalEnd = Math.min(this.state.finalEnd, this.state.submitEnd + this.limits.finalSec * 1000);
    } else if (phase === "submit") {
      this.state.submitEnd = now;
      this.state.finalEnd = Math.min(this.state.finalEnd, now + this.limits.finalSec * 1000);
    } else {
      this.state.finalEnd = Math.min(this.state.finalEnd, now);
    }
    this.save();
  }

  addUsage(tokens: number, output: number): void {
    this.state.tokens += tokens;
    this.state.output += output;
    const fraction = this.phase() === "work" ? 0.7 : 0.85;
    if ((this.phase() === "work" || this.phase() === "submit") && this.reached(fraction)) this.advance();
    this.save();
  }

  unknownUsage(): void {
    this.state.usageKnown = false;
    this.save();
  }

  exhausted(): boolean {
    return this.reached(1);
  }

  private reached(fraction: number): boolean {
    return (
      this.state.tokens >= this.limits.maxTokens * fraction ||
      this.state.output >= this.limits.maxOutputTokens * fraction
    );
  }
}
