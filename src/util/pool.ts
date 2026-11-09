/**
 * Runs `fn` over all items with a maximum number of parallel workers.
 * Preserves the order of the results.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const workers = Math.min(Math.max(Math.floor(concurrency), 1), items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
