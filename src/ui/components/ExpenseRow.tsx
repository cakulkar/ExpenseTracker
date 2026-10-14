import type { Expense, Receipt } from '../../domain/types';
import { formatCents } from '../../domain/money';
import { formatDate } from '../../domain/dates';
import { useApp } from '../AppContext';
import { useSync } from '../SyncContext';

export function receiptTag(e: Expense, receipt: Receipt | undefined): { label: string; tone: string } | null {
  if (!e.receiptId) return null;
  if (!receipt) return { label: 'Receipt', tone: '' };
  if (receipt.deletionStatus === 'deleted') return { label: 'Receipt expired', tone: '' };
  if (receipt.deletionStatus === 'failed' || receipt.deletionStatus === 'scheduled') return { label: 'Receipt deletion pending', tone: 'warn' };
  if (receipt.uploadStatus === 'uploaded') return { label: 'Receipt in Drive', tone: '' };
  if (receipt.uploadStatus === 'failed') return { label: 'Receipt upload failed', tone: 'warn' };
  return { label: 'Receipt waiting to upload', tone: '' };
}

export function ExpenseRow({ e }: { e: Expense }) {
  const { categoryById, memberById, receiptById, pendingEntityIds } = useApp();
  const { connected } = useSync();
  const cat = categoryById.get(e.subcategoryId ?? e.categoryId) ?? categoryById.get(e.categoryId);
  const parent = cat?.parentCategoryId ? categoryById.get(cat.parentCategoryId) : undefined;
  const catLabel = parent ? `${parent.name} › ${cat!.name}` : cat?.name ?? 'Unknown category';
  const refund = e.kind === 'refund';
  const rt = receiptTag(e, e.receiptId ? receiptById.get(e.receiptId) : undefined);
  return (
    <li>
      <a className={`exp-row ${e.deletedAt ? 'deleted' : ''}`} href={`#/expenses/${e.expenseId}`}>
        <span className="exp-icon" aria-hidden="true" style={{ background: `${(parent ?? cat)?.color ?? '#999'}22` }}>
          {(cat ?? parent)?.icon ?? '❔'}
        </span>
        <span className="exp-main">
          <span className="exp-merchant">{e.merchantName}</span>
          <span className="exp-meta">
            {formatDate(e.transactionDate)} · {catLabel} · {memberById.get(e.paidByMemberId)?.displayName ?? 'Unknown'} paid
            {e.expenseType === 'personal' && ' · Personal'}
          </span>
          <span className="exp-tags">
            {refund && <span className="tag refund">Refund</span>}
            {e.deletedAt && <span className="tag">Deleted</span>}
            {e.verificationStatus === 'needs_review' && <span className="tag warn">Needs review</span>}
            {e.recurringExpenseId && <span className="tag">Recurring</span>}
            {rt && <span className={`tag ${rt.tone}`}>{rt.label}</span>}
            {connected && pendingEntityIds.has(e.expenseId) && <span className="tag">Not synced yet</span>}
          </span>
        </span>
        <span className={`exp-amt ${refund ? 'refund' : ''}`}>
          {refund ? '−' : ''}
          {formatCents(e.totalCents)}
        </span>
      </a>
    </li>
  );
}
