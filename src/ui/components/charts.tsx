/**
 * Small, dependency-free SVG charts. Each chart:
 *  - is a <figure> with a caption and an aria-label summary,
 *  - includes a visually hidden data table for screen readers,
 *  - shows exact values on hover/focus (bars are keyboard-focusable),
 *  - uses currency formatting from integer cents.
 */
import { useId, useState, type ReactNode } from 'react';
import { formatCents } from '../../domain/money';

export interface Datum {
  key: string;
  label: string;
  cents: number;
  color?: string;
}

const PALETTE = ['#1f6f5c', '#3b82c4', '#d9822b', '#9c4dcc', '#d6457a', '#2f9e8f', '#b8860b', '#5c6bc0', '#8d6e63', '#607d8b'];

function compact(cents: number): string {
  const d = Math.abs(cents) / 100;
  const s = d >= 1000 ? `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k` : `$${Math.round(d)}`;
  return cents < 0 ? `-${s}` : s;
}

function Frame(props: { title: string; summary: string; table: ReactNode; children: ReactNode; detail?: string | null }) {
  return (
    <figure className="chart" aria-label={`${props.title}. ${props.summary}`}>
      <figcaption className="chart-title">{props.title}</figcaption>
      <div className="chart-detail" aria-live="polite">{props.detail ?? ' '}</div>
      <div aria-hidden="true">{props.children}</div>
      <table className="sr-only">{props.table}</table>
    </figure>
  );
}

function DataTable({ rows, valueHeader = 'Amount' }: { rows: Array<[string, string]>; valueHeader?: string }) {
  return (
    <>
      <thead>
        <tr>
          <th>Item</th>
          <th>{valueHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([a, b], i) => (
          <tr key={i}>
            <td>{a}</td>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

// ---------- Donut ----------

export function DonutChart({ title, data, centerLabel }: { title: string; data: Datum[]; centerLabel: string }) {
  const [active, setActive] = useState<string | null>(null);
  const positive = data.filter((d) => d.cents > 0);
  const total = positive.reduce((s, d) => s + d.cents, 0);
  const r = 70;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const act = positive.find((d) => d.key === active);
  const pct = (cents: number) => (total > 0 ? Math.round((cents * 100) / total) : 0);
  return (
    <Frame
      title={title}
      summary={positive.map((d) => `${d.label} ${formatCents(d.cents)} (${pct(d.cents)}%)`).join('; ') || 'No spending'}
      table={<DataTable rows={positive.map((d) => [d.label, `${formatCents(d.cents)} (${pct(d.cents)}%)`])} />}
      detail={act ? `${act.label}: ${formatCents(act.cents)} · ${pct(act.cents)}%` : null}
    >
      <div className="donut-wrap">
        <svg viewBox="0 0 200 200" className="donut" role="presentation">
          <circle cx="100" cy="100" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="28" />
          {positive.map((d, i) => {
            const len = (d.cents / total) * c;
            const el = (
              <circle
                key={d.key}
                cx="100"
                cy="100"
                r={r}
                fill="none"
                stroke={d.color ?? PALETTE[i % PALETTE.length]}
                strokeWidth={active === d.key ? 34 : 28}
                strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${c}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 100 100)"
                onMouseEnter={() => setActive(d.key)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive(active === d.key ? null : d.key)}
              >
                <title>{`${d.label}: ${formatCents(d.cents)}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
          <text x="100" y="96" textAnchor="middle" className="donut-total">{compact(total)}</text>
          <text x="100" y="116" textAnchor="middle" className="donut-sub">{centerLabel}</text>
        </svg>
        <ul className="legend">
          {positive.slice(0, 8).map((d, i) => (
            <li key={d.key}>
              <button type="button" className={`legend-item ${active === d.key ? 'on' : ''}`} onFocus={() => setActive(d.key)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(d.key)} onMouseLeave={() => setActive(null)}>
                <span className="swatch" style={{ background: d.color ?? PALETTE[i % PALETTE.length] }} />
                <span className="legend-label">{d.label}</span>
                <span className="legend-value">{pct(d.cents)}%</span>
              </button>
            </li>
          ))}
          {positive.length > 8 && <li className="muted small">+{positive.length - 8} more</li>}
        </ul>
      </div>
    </Frame>
  );
}

// ---------- Vertical bars ----------

export function BarChart({ title, data, highlightKey, height = 180 }: { title: string; data: Datum[]; highlightKey?: string; height?: number }) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => Math.abs(d.cents)));
  const W = Math.max(280, data.length * 44);
  const H = height;
  const bw = (W - 20) / data.length;
  const act = data.find((d) => d.key === active);
  return (
    <Frame
      title={title}
      summary={data.map((d) => `${d.label} ${formatCents(d.cents)}`).join('; ')}
      table={<DataTable rows={data.map((d) => [d.label, formatCents(d.cents)])} />}
      detail={act ? `${act.label}: ${formatCents(act.cents)}` : null}
    >
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="bars-svg" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <line key={t} x1="10" x2={W - 10} y1={H - (H - 20) * t} y2={H - (H - 20) * t} className="gridline" />
        ))}
        {data.map((d, i) => {
          const h = (Math.abs(d.cents) / max) * (H - 20);
          const x = 10 + i * bw + bw * 0.15;
          const isHi = d.key === highlightKey;
          return (
            <g key={d.key} onMouseEnter={() => setActive(d.key)} onMouseLeave={() => setActive(null)} onClick={() => setActive(d.key)}>
              <rect x={10 + i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={x} y={H - h} width={bw * 0.7} height={Math.max(h, d.cents ? 1 : 0)} rx="3" className={`bar ${isHi ? 'hi' : ''} ${active === d.key ? 'active' : ''}`} style={d.color ? { fill: d.color } : undefined}>
                <title>{`${d.label}: ${formatCents(d.cents)}`}</title>
              </rect>
              <text x={x + bw * 0.35} y={H + 16} textAnchor="middle" className="axis-label">{d.label}</text>
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}

// ---------- Daily trend (daily bars + cumulative line) ----------

export function TrendChart({ title, points, budgetCents }: { title: string; points: Array<{ label: string; cents: number; cumulative: number }>; budgetCents?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 640;
  const H = 180;
  const maxCum = Math.max(1, budgetCents ?? 0, ...points.map((p) => p.cumulative));
  const maxDay = Math.max(1, ...points.map((p) => p.cents));
  const step = (W - 20) / Math.max(1, points.length);
  const y = (v: number) => H - 10 - (Math.max(v, 0) / maxCum) * (H - 30);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${10 + i * step + step / 2},${y(p.cumulative)}`).join(' ');
  const act = active !== null ? points[active] : undefined;
  const gid = useId();
  return (
    <Frame
      title={title}
      summary={points.length ? `Running total reaches ${formatCents(points[points.length - 1]!.cumulative)}` : 'No data'}
      table={<DataTable rows={points.filter((p) => p.cents !== 0).map((p) => [p.label, `${formatCents(p.cents)} (running ${formatCents(p.cumulative)})`])} />}
      detail={act ? `${act.label}: ${formatCents(act.cents)} that day · ${formatCents(act.cumulative)} so far` : null}
    >
      <svg viewBox={`0 0 ${W} ${H + 20}`} className="trend-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {budgetCents ? <line x1="10" x2={W - 10} y1={y(budgetCents)} y2={y(budgetCents)} className="budget-line" /> : null}
        {points.map((p, i) => (
          <rect key={i} x={10 + i * step + step * 0.2} width={step * 0.6} y={H - 10 - (Math.max(p.cents, 0) / maxDay) * (H - 30) * 0.45} height={(Math.max(p.cents, 0) / maxDay) * (H - 30) * 0.45} className="day-bar" />
        ))}
        {points.length > 0 && <path d={`${path} L${10 + (points.length - 1) * step + step / 2},${H - 10} L${10 + step / 2},${H - 10} Z`} fill={`url(#${gid})`} />}
        <path d={path} className="trend-line" />
        {points.map((_, i) => (
          <rect key={`h${i}`} x={10 + i * step} width={step} y="0" height={H} fill="transparent" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} onClick={() => setActive(i)} />
        ))}
        {act && <circle cx={10 + active! * step + step / 2} cy={y(act.cumulative)} r="4" className="trend-dot" />}
        {points.map((p, i) => (i % 7 === 0 || i === points.length - 1 ? <text key={`t${i}`} x={10 + i * step + step / 2} y={H + 14} textAnchor="middle" className="axis-label">{p.label}</text> : null))}
      </svg>
      {budgetCents ? <p className="chart-note"><span className="budget-key" /> Overall budget {formatCents(budgetCents)}</p> : null}
    </Frame>
  );
}

// ---------- Horizontal comparison (budget vs actual, per-person) ----------

export interface CompareRow {
  key: string;
  label: string;
  actual: number;
  target?: number;
  color?: string;
}

export function CompareBars({ title, rows, targetLabel = 'Budget', actualLabel = 'Spent' }: { title: string; rows: CompareRow[]; targetLabel?: string; actualLabel?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.actual), r.target ?? 0)));
  return (
    <Frame
      title={title}
      summary={rows.map((r) => `${r.label}: ${actualLabel} ${formatCents(r.actual)}${r.target !== undefined ? ` of ${formatCents(r.target)}` : ''}`).join('; ')}
      table={<DataTable valueHeader={actualLabel} rows={rows.map((r) => [r.label, `${formatCents(r.actual)}${r.target !== undefined ? ` / ${targetLabel} ${formatCents(r.target)}` : ''}`])} />}
    >
      <ul className="hbars">
        {rows.map((r) => {
          const over = r.target !== undefined && r.actual > r.target;
          return (
            <li key={r.key} title={`${r.label}: ${formatCents(r.actual)}${r.target !== undefined ? ` of ${formatCents(r.target)}` : ''}`}>
              <span className="hb-label">{r.label}</span>
              <span className="hb-track">
                <span className={`hb-fill ${over ? 'over' : ''}`} style={{ width: `${(Math.max(r.actual, 0) / max) * 100}%`, background: over ? undefined : r.color }} />
                {r.target !== undefined && <span className="hb-target" style={{ left: `${(r.target / max) * 100}%` }} />}
              </span>
              <span className="hb-value">
                {formatCents(r.actual)}
                {r.target !== undefined && <span className="muted"> / {formatCents(r.target)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}
