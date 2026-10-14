import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { LedgerDb } from '../db/schema';
import type { LedgerRepo } from '../db/repo';
import type { Budget, Category, Household, HouseholdMember, MerchantRule, Receipt, RecurringExpense } from '../domain/types';
import { useLiveQuery } from './hooks/useLiveQuery';
import { getSetting } from '../db/settings';

export interface AppData {
  db: LedgerDb;
  repo: LedgerRepo;
  household: Household | undefined;
  members: HouseholdMember[];
  categories: Category[];
  /** Parent category id for each category (subcategories map to their parent). */
  categoryParents: Map<string, string | undefined>;
  categoryById: Map<string, Category>;
  memberById: Map<string, HouseholdMember>;
  budgets: Budget[];
  recurring: RecurringExpense[];
  receipts: Receipt[];
  receiptById: Map<string, Receipt>;
  rules: MerchantRule[];
  thisMemberId: string | undefined;
  pendingOps: number;
  /** Records with local changes not yet uploaded. */
  pendingEntityIds: Set<string>;
  openConflicts: number;
  lastSyncAt: string | null;
  timezone: string;
  lock: () => void;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ db, repo, lock, children }: { db: LedgerDb; repo: LedgerRepo; lock: () => void; children: ReactNode }) {
  const household = useLiveQuery(() => db.household.toCollection().first(), [db], undefined);
  const members = useLiveQuery(() => db.members.toArray(), [db], [] as HouseholdMember[]);
  const categories = useLiveQuery(() => db.categories.toArray(), [db], [] as Category[]);
  const budgets = useLiveQuery(() => db.budgets.filter((b) => !b.deletedAt).toArray(), [db], [] as Budget[]);
  const recurring = useLiveQuery(() => db.recurring.filter((r) => !r.deletedAt).toArray(), [db], [] as RecurringExpense[]);
  const receipts = useLiveQuery(() => db.receipts.toArray(), [db], [] as Receipt[]);
  const rules = useLiveQuery(() => db.merchantRules.filter((r) => !r.deletedAt).toArray(), [db], [] as MerchantRule[]);
  const thisMemberId = useLiveQuery(() => getSetting(db, 'memberId'), [db], undefined);
  const lastSyncAt = useLiveQuery(async () => (await getSetting(db, 'lastSyncAt')) ?? null, [db], null);
  const pendingList = useLiveQuery(async () => (await db.syncOps.where('syncStatus').equals('pending').toArray()).map((o) => o.entityId), [db], [] as string[]);
  const pendingOps = pendingList.length;
  const openConflicts = useLiveQuery(() => db.conflicts.filter((c) => !c.resolvedAt).count(), [db], 0);

  const value = useMemo<AppData>(() => {
    const sortedMembers = [...members].sort((a, b) => (a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'owner' ? -1 : 1));
    const sortedCats = [...categories].sort((a, b) => {
      if (a.categoryId === 'cat-uncategorized') return 1;
      if (b.categoryId === 'cat-uncategorized') return -1;
      return a.name.localeCompare(b.name);
    });
    if (thisMemberId && repo.memberId !== thisMemberId) repo.setMemberId(thisMemberId);
    return {
      db,
      repo,
      household,
      members: sortedMembers,
      categories: sortedCats,
      categoryParents: new Map(categories.map((c) => [c.categoryId, c.parentCategoryId])),
      categoryById: new Map(categories.map((c) => [c.categoryId, c])),
      memberById: new Map(members.map((m) => [m.memberId, m])),
      budgets,
      recurring,
      receipts,
      receiptById: new Map(receipts.map((r) => [r.receiptId, r])),
      rules,
      thisMemberId,
      pendingOps,
      pendingEntityIds: new Set(pendingList),
      openConflicts,
      lastSyncAt,
      timezone: household?.timezone ?? 'America/Detroit',
      lock,
    };
  }, [db, repo, household, members, categories, budgets, recurring, receipts, rules, thisMemberId, pendingOps, pendingList, openConflicts, lastSyncAt, lock]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
