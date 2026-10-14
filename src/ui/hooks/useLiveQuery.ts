import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

/** Re-runs `query` whenever the IndexedDB tables it reads change (including from other tabs). */
export function useLiveQuery<T>(query: () => Promise<T> | T, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: (v) => setValue(v),
      error: () => {
        /* intentionally silent: never log query contents */
      },
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
