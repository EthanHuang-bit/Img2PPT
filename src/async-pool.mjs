export function normalizeConcurrency(value, fallback = 20, maximum = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

export async function mapConcurrent(items, worker, {
  concurrency = 20,
  onSettled
} = {}) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const limit = normalizeConcurrency(concurrency, 20, 20);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
        await onSettled?.({
          index,
          item: list[index],
          status: "fulfilled",
          value: results[index]
        });
      } catch (error) {
        await onSettled?.({
          index,
          item: list[index],
          status: "rejected",
          reason: error
        });
        throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, () => runWorker())
  );
  return results;
}

export async function allSettledConcurrent(items, worker, {
  concurrency = 20,
  onSettled
} = {}) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const limit = normalizeConcurrency(concurrency, 20, 20);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      try {
        const value = await worker(list[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      await onSettled?.({ index, item: list[index], ...results[index] });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, () => runWorker())
  );
  return results;
}

export class Semaphore {
  #active = 0;
  #queue = [];

  constructor(limit = 20) {
    this.limit = normalizeConcurrency(limit, 20, 20);
  }

  get active() {
    return this.#active;
  }

  get pending() {
    return this.#queue.length;
  }

  async acquire() {
    if (this.#active < this.limit) {
      this.#active += 1;
      return this.#releaseFactory();
    }
    return new Promise((resolve) => {
      this.#queue.push(resolve);
    }).then(() => this.#releaseFactory());
  }

  async run(task) {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  #releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) {
        next();
      } else {
        this.#active -= 1;
      }
    };
  }
}
