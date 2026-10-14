import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import type { Expense } from '../../domain/types';
import { computeTotals, filterExpenses, sortExpenses, type ExpenseFilter } from '../../domain/expenseQuery';
import { formatCents } from '../../domain/money';
import { addMonthsToMonth, formatDate, formatMonth, isValidIsoDate, monthOf, monthRange, todayIn } from '../../domain/dates';
import { computeBudgetStatuses } from '../../domain/budget';
import { computeInsights, dailySeries, monthlySeries } from '../../domain/insights';
import { ExpenseRow } from '../components/ExpenseRow';
import { EmptyState } from '../components/common';
import { BarChart, CompareBars, DonutChart, TrendChart } from '../components/charts';
import { useSyncStatus, STATE_LABEL } from '../../sync/status';

type Scope = 'all' | 'shared' | 'personal';

export function HomeScreen() {
  const { db, categoryById, categoryParents, categories, members, memberById, timezone, pendingOps, household, budgets, recurring, receipts, openConflicts } = useApp();
  const sync = useSyncStatus();
  const today = todayIn(timezone);
  const [month, setMonth] = useState(() => monthOf(today));
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(monthRange(monthOf(today)).from);
  const [to, setTo] = useState(today);
  const [scope, setScope] = useState<Scope>('all');
  const [member, setMember] = useState('');
  const [category, setCategory] = useState('');

  const all = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const range = custom && isValidIsoDate(from) && isValidIsoDate(to) && from <= to ? { from, to } : monthRange(month);

  // One filter object drives every card, chart and list on this page.
  const baseFilter: ExpenseFilter = useMemo(
    () => ({
      expenseType: scope === 'all' ? undefined : scope,
      paidByMemberId: member || undefined,
      categoryIds: category ? [category] : undefined,
    }),
    [scope, member, category],
  );
  const nonDateFiltered = useMemo(() => filterExpenses(all, baseFilter, categoryParents), [all, baseFilter, categoryParents]);
  const list = useMemo(() => filterExpenses(nonDateFiltered, { from: range.from, to: range.to }), [nonDateFiltered, range.from, range.to]);
  const totals = useMemo(() => computeTotals(list, categoryParents), [list, categoryParents]);
  const recent = useMemo(() => sortExpenses(list, 'date', 'desc').slice(0, 8), [list]);

  const budgetMonth = custom ? monthOf(range.to) : month;
  const statuses = useMemo(() => computeBudgetStatuses(budgets, all, budgetMonth, categoryParents), [budgets, all, budgetMonth, categoryParents]);
  const overall = statuses.find((s) => !s.budget.categoryId);
  const insights = useMemo(
    () => computeInsights({ month: budgetMonth, today, expenses: all, categories: categoryById, categoryParents, budgetStatuses: statuses, recurring, receipts }),
    [budgetMonth, today, all, categoryById, categoryParents, statuses, recurring, receipts],
  );
  const pendingUploads = receipts.filter((r) => r.deletionStatus === 'active' && r.uploadStatus !== 'uploaded').length;

  const donut = [...totals.byCategory.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, cents]) => ({ key: id, label: categoryById.get(id)?.name ?? 'Unknown', cents, color: categoryById.get(id)?.color }));
  const endMonth = monthOf(range.to);
  const months = monthlySeries(nonDateFiltered, endMonth, 6).map((m) => ({ key: m.month, label: formatMonth(m.month).slice(0, 3), cents: m.cents }));
  const daily = custom ? null : dailySeries(list, month).map((d) => ({ label: String(Number(d.date.slice(8))), cents: d.cents, cumulative: d.cumulative }));
  const budgetRows = statuses.map((s) => ({
    key: s.budget.budgetId,
    label: s.budget.categoryId ? categoryById.get(s.budget.categoryId)?.name ?? 'Category' : 'Overall',
    actual: s.spentCents,
    target: s.limitCents,
  }));
  const memberRows = members.map((m, i) => ({ key: m.memberId, label: m.displayName, actual: totals.byMember.get(m.memberId) ?? 0, color: i === 0 ? '#1f6f5c' : '#3b82c4' }));
  const rangeLabel = custom ? `${formatDate(range.from)} – ${formatDate(range.to)}` : formatMonth(month);
  const topCats = categories.filter((c) => !c.parentCategoryId);

  return (
    <section aria-labelledby="home-title">
      <div className="page-head">
        <h1 id="home-title" tabIndex={-1}>{household?.displayName ?? 'Overview'}</h1>
        {!custom && (
          <div className="month-pick" role="group" aria-label="Month">
            <button className="btn ghost icon" aria-label="Previous month" onClick={() => setMonth((m) => addMonthsToMonth(m, -1))}>‹</button>
            <label className="sr-only" htmlFor="month">Month</label>
            <input id="month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            <button className="btn ghost icon" aria-label="Next month" onClick={() => setMonth((m) => addMonthsToMonth(m, 1))}>›</button>
          </div>
        )}
      </div>

      <div className="dash-filters card" role="group" aria-label="Dashboard filters">
        <label className="check"><input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} /> Custom dates</label>
        {custom && (
          <>
            <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        <label>Show
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="all">All household</option><option value="shared">Shared only</option><option value="personal">Personal only</option>
          </select>
        </label>
        <label>Paid by
          <select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">Everyone</option>
            {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
          </select>
        </label>
        <label>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {topCats.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="cards">
        <div className="stat">
          <span className="stat-label">Household spending</span>
          <span className="stat-value">{formatCents(totals.netCents)}</span>
          <span className="stat-sub">{rangeLabel}{totals.refundCents > 0 && ` · after ${formatCents(totals.refundCents)} refunds`}</span>
        </div>
        <div className="stat"><span className="stat-label">Shared</span><span className="stat-value">{formatCents(totals.sharedCents)}</span></div>
        <div className="stat"><span className="stat-label">Personal</span><span className="stat-value">{formatCents(totals.personalCents)}</span></div>
        <a className={`stat link ${overall && overall.level !== 'ok' ? `lvl-${overall.level}` : ''}`} href="#/budgets">
          <span className="stat-label">Remaining budget</span>
          <span className="stat-value">{overall ? formatCents(overall.remainingCents) : '—'}</span>
          <span className="stat-sub">{overall ? `${Math.floor(overall.percentUsed)}% of ${formatCents(overall.limitCents)} · ${formatMonth(budgetMonth)}` : 'No overall budget set'}</span>
        </a>
        <div className="stat"><span className="stat-label">Transactions</span><span className="stat-value">{totals.count}</span></div>
        <a className="stat link" href="#/sync">
          <span className="stat-label">Uploads &amp; sync</span>
          <span className="stat-value">{pendingUploads + pendingOps + openConflicts}</span>
          <span className="stat-sub">
            {pendingUploads} receipt{pendingUploads === 1 ? '' : 's'} pending · {pendingOps} change{pendingOps === 1 ? '' : 's'} · {STATE_LABEL[sync.state]}
            {openConflicts > 0 && ` · ${openConflicts} conflict${openConflicts > 1 ? 's' : ''}`}
          </span>
        </a>
      </div>

      {insights.length > 0 && (
        <div className="card insights">
          <h2>Insights</h2>
          <ul>
            {insights.slice(0, 6).map((i) => (
              <li key={i.id} className={`insight ${i.severity}`}>
                <div>
                  <strong>{i.link ? <a href={i.link}>{i.title}</a> : i.title}</strong>
                  <p>{i.detail}</p>
                  <details>
                    <summary>How is this calculated?</summary>
                    <p>{i.how}</p>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {all.filter((e) => !e.deletedAt).length === 0 ? (
        <EmptyState title="No expenses yet">
          <p className="muted">Add an expense or scan a receipt to see your dashboard.</p>
          <div className="row gap center-row">
            <a className="btn primary" href="#/expenses/new">Add an expense</a>
            <a className="btn ghost" href="#/scan">Scan a receipt</a>
          </div>
        </EmptyState>
      ) : (
        <>
          <div className="chart-grid">
            <div className="card">
              {donut.length ? <DonutChart title={`Spending by category · ${rangeLabel}`} data={donut} centerLabel="total" /> : <EmptyState title={`No spending in ${rangeLabel}`} />}
            </div>
            <div className="card">
              <BarChart title="Spending by month (last 6 months)" data={months} highlightKey={endMonth} />
            </div>
            {daily && (
              <div className="card wide">
                <TrendChart title={`Daily spending · ${formatMonth(month)}`} points={daily} budgetCents={scope === 'all' && !member && !category ? overall?.limitCents : undefined} />
              </div>
            )}
            <div className="card">
              {budgetRows.length ? (
                <CompareBars title={`Budget vs actual · ${formatMonth(budgetMonth)}`} rows={budgetRows} />
              ) : (
                <div className="chart"><p className="chart-title">Budget vs actual</p><p className="muted">No budgets yet. <a href="#/budgets">Set a monthly budget</a>.</p></div>
              )}
            </div>
            <div className="card">
              <CompareBars title={`Paid by each person · ${rangeLabel}`} rows={memberRows} actualLabel="Paid" />
            </div>
          </div>

          <div className="card">
            <div className="row between">
              <h2>Recent transactions</h2>
              <a href="#/expenses" className="small">See all</a>
            </div>
            {recent.length ? <ul className="exp-list compact">{recent.map((e) => <ExpenseRow key={e.expenseId} e={e} />)}</ul> : <p className="muted">Nothing matches these filters.</p>}
          </div>
          <p className="muted small">Budgets use {formatMonth(budgetMonth)}; charts and totals use the filters above. {memberById.size} household members.</p>
        </>
      )}
    </section>
  );
}
