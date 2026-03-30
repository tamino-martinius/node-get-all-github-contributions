export async function runParallel<T, U>(props: {
  items: T[];
  callback: (item: T) => Promise<U>;
  maxConcurrency?: number;
  maxRetries?: number;
}): Promise<U[]> {
  const { items, callback, maxConcurrency = 1, maxRetries = 0 } = props;
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

  if (failures.length > 0) {
    throw failures;
  }

  return results;
}
