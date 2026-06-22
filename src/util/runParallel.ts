import { Logger } from "./Logger.js";

export async function runParallel<T, U>(props: {
  items: T[];
  callback: (item: T) => Promise<U>;
  maxConcurrency?: number;
  maxRetries?: number;
  // When true, residual failures (items that exhausted their retries) are
  // logged instead of thrown, and the partial results are returned. This keeps
  // a handful of unreachable repos/branches from aborting the whole sync.
  continueOnError?: boolean;
}): Promise<U[]> {
  const {
    items,
    callback,
    maxConcurrency = 1,
    maxRetries = 0,
    continueOnError = false,
  } = props;
  const failures: unknown[] = [];
  const queue = items.map<[number, T]>((item, index) => [index, item]);
  const results: U[] = [];
  const retries: number[] = [];

  const worker = async (): Promise<void> => {
    const [key, item] = queue.shift() ?? [];
    if (item === undefined || key === undefined) {
      return;
    }
    try {
      results[key] = await callback(item);
      // Succeeded (possibly on a retry) — clear any earlier failure for this
      // item so a transient error that later recovered does not count.
      delete failures[key];
    } catch (error) {
      failures[key] = error;
      const currentRetries = retries[key] ?? 0;
      if (currentRetries < maxRetries) {
        retries[key] = currentRetries + 1;
        queue.unshift([key, item]);
      }
    } finally {
      await worker();
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);

  const residualFailures = failures.filter((failure) => failure !== undefined);
  if (residualFailures.length > 0) {
    if (continueOnError) {
      Logger.error(
        "[runParallel]",
        `${residualFailures.length} item(s) failed after ${maxRetries} retries and were skipped`,
        residualFailures,
      );
    } else {
      throw failures;
    }
  }

  return results;
}
