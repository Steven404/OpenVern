// In-process promise-chain mutex.

export interface Mutex {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T> | T): Promise<T> {
      const result = tail.then(fn);
      // A failure must not poison the chain.
      tail = result.catch(() => {});
      return result;
    },
  };
}

const fileLocks = new Map<string, { mutex: Mutex; pending: number }>();

/** Serialises `fn` against every other call with the same `key` (a file path) in this process. */
export async function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  let entry = fileLocks.get(key);
  if (!entry) {
    entry = { mutex: createMutex(), pending: 0 };
    fileLocks.set(key, entry);
  }
  entry.pending++;
  try {
    return await entry.mutex.run(fn);
  } finally {
    if (--entry.pending === 0) fileLocks.delete(key);
  }
}
