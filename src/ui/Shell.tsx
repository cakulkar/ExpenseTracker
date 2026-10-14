import { useEffect, useMemo, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useRoute, type Route } from './router';
import { useApp } from './AppContext';
import { SyncStatus, useOnline, useToast } from './components/common';
import { HomeScreen } from './screens/HomeScreen';
import { ExpensesScreen } from './screens/ExpensesScreen';
import { ExpenseForm } from './screens/ExpenseForm';
import { SettingsScreen } from './screens/SettingsScreen';
import { BudgetsScreen } from './screens/BudgetsScreen';
import { RecurringScreen } from './screens/RecurringScreen';
import { ScanScreen } from './screens/ScanScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { SyncScreen } from './screens/SyncScreen';
import { RuleOfferDialog } from './categoryLearning';
import { useLiveQuery } from './hooks/useLiveQuery';
import { getSetting, setSetting } from '../db/settings';
import { computeBudgetStatuses, newBudgetAlerts } from '../domain/budget';
import { formatCents } from '../domain/money';
import { monthOf, todayIn } from '../domain/dates';
import type { Expense } from '../domain/types';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  match: Route['name'][];
}

const NAV: NavItem[] = [
  { href: '#/', label: 'Overview', icon: '◎', match: ['home'] },
  { href: '#/expenses', label: 'Expenses', icon: '☰', match: ['expenses', 'expense-edit'] },
  { href: '#/expenses/new', label: 'Add expense', icon: '+', match: ['expense-new'] },
  { href: '#/scan', label: 'Scan receipt', icon: '📷', match: ['scan'] },
  { href: '#/budgets', label: 'Budgets', icon: '◔', match: ['budgets'] },
  { href: '#/recurring', label: 'Recurring', icon: '↻', match: ['recurring'] },
  { href: '#/reports', label: 'Reports & backup', icon: '⇩', match: ['reports'] },
  { href: '#/sync', label: 'Sync & Drive', icon: '☁', match: ['sync'] },
  { href: '#/settings', label: 'Settings', icon: '⚙', match: ['settings'] },
];

const MOBILE_NAV: NavItem[] = [
  { href: '#/', label: 'Overview', icon: '◎', match: ['home'] },
  { href: '#/expenses', label: 'Expenses', icon: '☰', match: ['expenses', 'expense-edit'] },
  { href: '#/scan', label: 'Scan', icon: '📷', match: ['scan'] },
  { href: '#/expenses/new', label: 'Add', icon: '+', match: ['expense-new'] },
  { href: '#/more', label: 'More', icon: '⋯', match: ['more', 'budgets', 'recurring', 'reports', 'sync', 'settings'] },
];

function MoreScreen() {
  const { openConflicts } = useApp();
  return (
    <section aria-labelledby="more-title">
      <h1 id="more-title" tabIndex={-1}>More</h1>
      <ul className="more-list">
        {NAV.filter((n) => !['#/', '#/expenses', '#/expenses/new', '#/scan'].includes(n.href)).map((n) => (
          <li key={n.href}>
            <a href={n.href} className="card more-item">
              <span aria-hidden="true">{n.icon}</span> {n.label}
              {n.href === '#/sync' && openConflicts > 0 && <span className="tag warn">{openConflicts} to review</span>}
            </a>
          </li>
        ))}
        <li><a href="#/expenses/refund" className="card more-item"><span aria-hidden="true">↩</span> Add refund / credit</a></li>
      </ul>
    </section>
  );
}

/** Shows each budget threshold crossing once per month on this device. */
function useBudgetAlerts() {
  const { db, budgets, categoryParents, categoryById, timezone } = useApp();
  const toast = useToast();
  const month = monthOf(todayIn(timezone));
  const expenses = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const statuses = useMemo(() => computeBudgetStatuses(budgets, expenses, month, categoryParents), [budgets, expenses, month, categoryParents]);
  // Keys already handled in this session, updated synchronously so overlapping runs can't alert twice.
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!statuses.length) return;
    void (async () => {
      const shown = new Set([...((await getSetting(db, 'budgetAlertsShown')) ?? []), ...handled.current]);
      const fresh = newBudgetAlerts(statuses, shown).filter((a) => !handled.current.has(a.key));
      for (const a of fresh) handled.current.add(a.key);
      if (!fresh.length) return;
      // Show only the highest new threshold per budget.
      const best = new Map<string, (typeof fresh)[number]>();
      for (const a of fresh) if ((best.get(a.status.budget.budgetId)?.threshold ?? -1) < a.threshold) best.set(a.status.budget.budgetId, a);
      for (const a of best.values()) {
        const name = a.status.budget.categoryId ? categoryById.get(a.status.budget.categoryId)?.name ?? 'Category' : 'Overall';
        toast(
          a.threshold >= 100
            ? `${name} budget exceeded: ${formatCents(a.status.spentCents)} of ${formatCents(a.status.limitCents)}`
            : `${name} budget is ${Math.floor(a.status.percentUsed)}% used (${formatCents(a.status.remainingCents)} left)`,
          a.threshold >= 100 ? 'error' : 'ok',
        );
      }
      for (const a of fresh) shown.add(a.key);
      await setSetting(db, 'budgetAlertsShown', [...shown].slice(-500));
    })();
  }, [statuses, db, categoryById, toast]);
}

export function Shell() {
  const route = useRoute();
  const { lock, openConflicts } = useApp();
  const online = useOnline();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  useBudgetAlerts();

  // Move focus to the page heading on navigation so screen readers announce the new page.
  useEffect(() => {
    mainEl?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [route, mainEl]);

  let page;
  switch (route.name) {
    case 'home': page = <HomeScreen />; break;
    case 'expenses': page = <ExpensesScreen />; break;
    case 'expense-new': page = <ExpenseForm key={`new-${route.kind}`} mode="new" kind={route.kind} />; break;
    case 'expense-edit': page = <ExpenseForm key={route.id} mode="edit" id={route.id} />; break;
    case 'scan': page = <ScanScreen key={route.attachTo ?? 'new'} attachTo={route.attachTo} />; break;
    case 'budgets': page = <BudgetsScreen />; break;
    case 'recurring': page = <RecurringScreen />; break;
    case 'reports': page = <ReportsScreen />; break;
    case 'sync': page = <SyncScreen />; break;
    case 'settings': page = <SettingsScreen />; break;
    case 'more': page = <MoreScreen />; break;
  }

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainEl?.focus(); }}>Skip to content</a>
      <nav className="sidenav" aria-label="Main">
        <p className="brand">PocketLedger</p>
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className={n.match.includes(route.name) ? 'active' : ''} aria-current={n.match.includes(route.name) ? 'page' : undefined}>
            <span aria-hidden="true" className="nav-icon">{n.icon}</span> {n.label}
            {n.href === '#/sync' && openConflicts > 0 && <span className="tag warn">{openConflicts}</span>}
          </a>
        ))}
        <button className="btn ghost small lock-btn" onClick={lock}>Lock now</button>
      </nav>

      <div className="content">
        <header className="topbar">
          <SyncStatus />
          <button className="btn ghost small mobile-only" onClick={lock} aria-label="Lock app">🔒</button>
        </header>
        {!online && <div className="banner info" role="status">You're offline. Everything you enter is saved on this device and syncs later.</div>}
        {needRefresh && (
          <div className="banner info" role="status">
            A new version is ready.
            <button className="btn small" onClick={() => void updateServiceWorker(true)}>Update now</button>
          </div>
        )}
        <main id="main" ref={setMainEl} tabIndex={-1}>{page}</main>
      </div>

      <nav className="bottomnav" aria-label="Main">
        {MOBILE_NAV.map((n) => (
          <a key={n.href} href={n.href} className={`${n.match.includes(route.name) ? 'active' : ''} ${n.label === 'Add' ? 'add' : ''}`} aria-current={n.match.includes(route.name) ? 'page' : undefined}>
            <span aria-hidden="true" className="bn-icon">{n.icon}</span>
            <span className="bn-label">{n.label}</span>
          </a>
        ))}
      </nav>
      <RuleOfferDialog />
    </div>
  );
}
