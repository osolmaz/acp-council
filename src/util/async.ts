export type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

/** Waits for a promise for at most `ms`, and says how it ended. It never throws. */
export function settle<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, ms);
  });
  const result = promise.then(
    (value): Settled<T> => ({ kind: "value", value }),
    (error: unknown): Settled<T> => ({ kind: "error", error }),
  );
  return Promise.race([result, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Waits for a promise for at most `ms`. A timeout throws an error that names `what`. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const result = await settle(promise, ms);
  if (result.kind === "value") {
    return result.value;
  }
  throw result.kind === "timeout" ? new Error(`${what} took longer than ${ms} ms`) : result.error;
}

/** Runs tasks with at most `limit` at the same time, and keeps the results in task order. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
