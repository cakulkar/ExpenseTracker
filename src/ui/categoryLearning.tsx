/**
 * When someone repeatedly changes a merchant's suggested category to the same thing, offer to remember it as
 * a household rule (stored as a synced, encrypted MerchantRule). Correction counts stay on this device.
 */
import { useSyncExternalStore } from 'react';
import type { LedgerDb } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';
import { recordCorrection, rulePatternFor } from '../domain/classify';
import { normalizeMerchant } from '../domain/expenseQuery';
import type { MerchantRule } from '../domain/types';
import { useApp } from './AppContext';
import { ConfirmDialog, useToast } from './components/common';

interface Offer {
  pattern: string;
  categoryId: string;
  merchantName: string;
}

let current: Offer | null = null;
const listeners = new Set<() => void>();
const setOffer = (o: Offer | null) => {
  current = o;
  listeners.forEach((l) => l());
};

export async function noteCategoryChoice(db: LedgerDb, rules: readonly MerchantRule[], merchantName: string, suggestedId: string | undefined, chosenId: string): Promise<void> {
  if (!suggestedId || suggestedId === chosenId || !merchantName.trim()) return;
  const norm = normalizeMerchant(merchantName);
  const r = recordCorrection((await getSetting(db, 'categoryCorrections')) ?? {}, norm, chosenId);
  await setSetting(db, 'categoryCorrections', r.stats);
  const pattern = rulePatternFor(norm);
  const declined = (await getSetting(db, 'ruleOffersDeclined')) ?? [];
  if (r.offer && !declined.includes(`${pattern}|${chosenId}`) && !rules.some((x) => x.merchantPattern === pattern && x.categoryId === chosenId)) {
    setOffer({ pattern, categoryId: chosenId, merchantName });
  }
}

export function RuleOfferDialog() {
  const offer = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);
  const { repo, db, categoryById } = useApp();
  const toast = useToast();
  if (!offer) return null;
  const cat = categoryById.get(offer.categoryId);
  return (
    <ConfirmDialog
      open
      title="Remember this category?"
      confirmLabel="Always use it"
      onCancel={async () => {
        const d = (await getSetting(db, 'ruleOffersDeclined')) ?? [];
        await setSetting(db, 'ruleOffersDeclined', [...d, `${offer.pattern}|${offer.categoryId}`]);
        setOffer(null);
      }}
      onConfirm={async () => {
        await repo.saveMerchantRule(offer.pattern, offer.categoryId);
        setOffer(null);
        toast(`New rule: “${offer.pattern}” → ${cat?.name ?? 'category'}`);
      }}
    >
      <p>
        You've changed <strong>{offer.merchantName}</strong> to <strong>{cat?.icon} {cat?.name}</strong> more than once. Suggest this category automatically
        for merchants containing “{offer.pattern}”? The rule syncs (encrypted) to both of you, and you can delete it in Settings.
      </p>
    </ConfirmDialog>
  );
}
