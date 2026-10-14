import { useEffect, useState } from 'react';

/**
 * Minimal hash router. Hash routes work on GitHub Pages (no server rewrites) and offline.
 */
export type Route =
  | { name: 'home' }
  | { name: 'expenses' }
  | { name: 'expense-new'; kind: 'expense' | 'refund' }
  | { name: 'expense-edit'; id: string }
  | { name: 'scan'; attachTo?: string }
  | { name: 'budgets' }
  | { name: 'recurring' }
  | { name: 'reports' }
  | { name: 'sync' }
  | { name: 'settings' }
  | { name: 'more' };

const ID = /^[\w-]{8,64}$/;

export function parseHash(hash: string): Route {
  const [rawPath, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = (rawPath || '/').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'expenses':
      if (parts[1] === 'new') return { name: 'expense-new', kind: 'expense' };
      if (parts[1] === 'refund') return { name: 'expense-new', kind: 'refund' };
      if (parts[1] && ID.test(parts[1])) return { name: 'expense-edit', id: parts[1] };
      return { name: 'expenses' };
    case 'scan': {
      const a = params.get('attach');
      return { name: 'scan', attachTo: a && ID.test(a) ? a : undefined };
    }
    case 'budgets':
      return { name: 'budgets' };
    case 'recurring':
      return { name: 'recurring' };
    case 'reports':
      return { name: 'reports' };
    case 'sync':
      return { name: 'sync' };
    case 'settings':
      return { name: 'settings' };
    case 'more':
      return { name: 'more' };
    default:
      return { name: 'home' };
  }
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
