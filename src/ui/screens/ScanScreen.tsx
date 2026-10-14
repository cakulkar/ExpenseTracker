/**
 * Receipt capture → crop/rotate/contrast → local OCR → review & confirm → save.
 * Supports camera capture, file upload and multi-file batches. Images never leave the device until the
 * expense is saved and sync uploads them (encrypted by default) to the household Drive.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { navigate } from '../router';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getSetting } from '../../db/settings';
import { sha256Hex } from '../../crypto/crypto';
import { FULL_CROP, canvasToJpeg, decodeImage, enhancedCopy, renderTransformed, thumbnailOf, validateImageFile, type CropRect, type Rotation } from '../../ocr/image';
import { recognizeReceipt, releaseOcr } from '../../ocr/ocr';
import { parseReceipt, uncertainCriticalFields, arithmeticWarning, type ParsedReceipt } from '../../domain/receiptParser';
import { classify, type Classification } from '../../domain/classify';
import { findDuplicates, type DuplicateMatch } from '../../domain/duplicates';
import { centsToInput, formatCents, tryParseCents } from '../../domain/money';
import { formatDate, isValidIsoDate, todayIn } from '../../domain/dates';
import { validateExpenseForm, type ExpenseFormValues } from '../../domain/expenseInput';
import type { Expense, Provenance } from '../../domain/types';
import { ImageEditor } from '../components/ImageEditor';
import { Field, useToast } from '../components/common';
import { noteCategoryChoice } from '../categoryLearning';

type Step = 'pick' | 'edit' | 'reading' | 'review';

interface Prepared {
  file: File;
  hash: string;
  image: ImageBitmap | HTMLImageElement;
}

interface LineItemDraft {
  id: string;
  description: string;
  amount: string;
  quantity?: number;
  unitPriceCents?: number;
  confidence?: number;
  edited: boolean;
}

interface ReviewState {
  parsed: ParsedReceipt | null;
  values: ExpenseFormValues & { time: string; receiptNumber: string; paymentMethod: string };
  prov: Record<string, Provenance>;
  conf: Record<string, number>;
  edited: Set<string>;
  suggestion: Classification;
  lines: LineItemDraft[];
  bytes: ArrayBuffer;
  thumbnail: ArrayBuffer;
  previewUrl: string;
  confirmed: boolean;
}

const FIELD_MAP: Record<string, keyof ParsedReceipt> = {
  merchantName: 'merchant', transactionDate: 'date', amount: 'total', subtotal: 'subtotal', tax: 'tax', tip: 'tip', discount: 'discount',
  time: 'time', receiptNumber: 'receiptNumber', paymentMethod: 'paymentMethod',
};
const PROV_KEY: Record<string, string> = { merchantName: 'merchantName', transactionDate: 'transactionDate', amount: 'totalCents', subtotal: 'subtotalCents', tax: 'taxCents', tip: 'tipCents', discount: 'discountCents' };

export function ScanScreen({ attachTo }: { attachTo?: string }) {
  const { db, repo, categories, members, thisMemberId, timezone, rules, receipts, categoryById, memberById } = useApp();
  const toast = useToast();
  const expenses = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const attachExpense = attachTo ? expenses.find((e) => e.expenseId === attachTo) : undefined;
  const [queue, setQueue] = useState<File[]>([]);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<Step>('pick');
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [enhance, setEnhance] = useState(true);
  const [progress, setProgress] = useState<{ p: number; status: string }>({ p: 0, status: '' });
  const [review, setReview] = useState<ReviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [dupChoice, setDupChoice] = useState<'undecided' | 'keep'>('undecided');
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void releaseOcr(), []);

  const load = async (files: File[], at: number) => {
    setError('');
    const file = files[at];
    if (!file) {
      setStep('pick');
      return;
    }
    const problem = validateImageFile(file);
    if (problem) {
      setError(`${file.name}: ${problem}`);
      setStep('pick');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const [hash, image] = await Promise.all([sha256Hex(buf), decodeImage(file)]);
      setPrepared({ file, hash, image });
      setRotation(0);
      setCrop(FULL_CROP);
      setEnhance(true);
      setReview(null);
      setDupChoice('undecided');
      setStep('edit');
    } catch {
      setError(`${file.name}: this image couldn't be opened.`);
      setStep('pick');
    }
  };

  const onPick = (list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, 20);
    if (!files.length) return;
    setQueue(files);
    setIndex(0);
    void load(files, 0);
  };

  const next = () => {
    const i = index + 1;
    if (i < queue.length) {
      setIndex(i);
      void load(queue, i);
    } else {
      setQueue([]);
      setPrepared(null);
      setReview(null);
      setStep('pick');
      if (attachTo) navigate(`/expenses/${attachTo}`);
    }
  };

  const process = async (runOcr: boolean) => {
    if (!prepared) return;
    setError('');
    setStep('reading');
    setProgress({ p: 0, status: 'Preparing image' });
    try {
      const color = renderTransformed(prepared.image, rotation, crop);
      const [jpeg, thumb] = await Promise.all([canvasToJpeg(color, 0.85), thumbnailOf(color)]);
      let parsed: ParsedReceipt | null = null;
      if (runOcr) {
        const lines = await recognizeReceipt(enhance ? enhancedCopy(color) : color, (p, status) => setProgress({ p, status }));
        parsed = parseReceipt(lines, { today: todayIn(timezone) });
      }
      color.width = color.height = 0;
      const merchant = parsed?.merchant?.value ?? attachExpense?.merchantName ?? '';
      const suggestion = classify({ merchantName: merchant, lineItems: parsed?.lineItems.map((l) => l.description), rules, validCategoryIds: new Set(categories.filter((c) => !c.isArchived).map((c) => c.categoryId)) });
      const values: ReviewState['values'] = {
        kind: 'expense',
        merchantName: merchant,
        transactionDate: parsed?.date?.value ?? attachExpense?.transactionDate ?? '',
        amount: parsed?.total ? centsToInput(parsed.total.value) : attachExpense ? centsToInput(attachExpense.totalCents) : '',
        subtotal: parsed?.subtotal ? centsToInput(parsed.subtotal.value) : '',
        tax: parsed?.tax ? centsToInput(parsed.tax.value) : '',
        tip: parsed?.tip ? centsToInput(parsed.tip.value) : '',
        discount: parsed?.discount ? centsToInput(parsed.discount.value) : '',
        categoryId: attachExpense?.categoryId ?? suggestion.categoryId,
        subcategoryId: attachExpense?.subcategoryId ?? '',
        paidByMemberId: attachExpense?.paidByMemberId ?? thisMemberId ?? members[0]?.memberId ?? '',
        expenseType: attachExpense?.expenseType ?? 'shared',
        notes: attachExpense?.notes ?? '',
        time: parsed?.time?.value ?? '',
        receiptNumber: parsed?.receiptNumber?.value ?? '',
        paymentMethod: parsed?.paymentMethod?.value ?? '',
      };
      const prov: Record<string, Provenance> = {};
      const conf: Record<string, number> = {};
      for (const [field, key] of Object.entries(FIELD_MAP)) {
        const pf = parsed?.[key] as { provenance: Provenance; confidence: number } | undefined;
        if (pf) {
          prov[field] = pf.provenance;
          conf[field] = pf.confidence;
        }
      }
      if (!parsed?.merchant && merchant) prov.merchantName = 'manual';
      prov.categoryId = 'inferred';
      setReview({
        parsed,
        values,
        prov,
        conf,
        edited: new Set(),
        suggestion,
        lines: (parsed?.lineItems ?? []).map((l, i) => ({ id: String(i), description: l.description, amount: centsToInput(l.totalCents), quantity: l.quantity, unitPriceCents: l.unitPriceCents, confidence: l.confidence, edited: false })),
        bytes: await jpeg.arrayBuffer(),
        thumbnail: await thumb.arrayBuffer(),
        previewUrl: URL.createObjectURL(jpeg),
        confirmed: false,
      });
      setStep('review');
    } catch (e) {
      setError(e instanceof Error ? `Couldn't read the receipt: ${e.message}. You can enter the details by hand.` : 'Reading failed');
      setStep('edit');
    }
  };

  useEffect(() => () => {
    if (review?.previewUrl) URL.revokeObjectURL(review.previewUrl);
  }, [review?.previewUrl]);

  const duplicates: DuplicateMatch[] = useMemo(() => {
    if (!review || !prepared) return [];
    return findDuplicates(
      {
        imageHash: prepared.hash,
        merchantName: review.values.merchantName,
        transactionDate: isValidIsoDate(review.values.transactionDate) ? review.values.transactionDate : undefined,
        totalCents: tryParseCents(review.values.amount) ?? undefined,
        receiptNumber: review.values.receiptNumber || undefined,
        excludeExpenseId: attachTo,
      },
      expenses,
      receipts,
    );
  }, [review, prepared, expenses, receipts, attachTo]);

  if (attachTo && !attachExpense && expenses.length > 0) {
    return (
      <section>
        <h1 tabIndex={-1}>Expense not found</h1>
        <a className="btn" href="#/expenses">Back</a>
      </section>
    );
  }

  const setVal = (k: keyof ReviewState['values'], v: string) => {
    if (!review) return;
    const edited = new Set(review.edited);
    edited.add(k);
    const prov = { ...review.prov, [k]: 'manual' as Provenance };
    setReview({ ...review, values: { ...review.values, [k]: v }, edited, prov });
  };

  const uncertain = review?.parsed ? uncertainCriticalFields(review.parsed).filter((f) => !review.edited.has(f === 'merchant' ? 'merchantName' : f === 'date' ? 'transactionDate' : 'amount')) : review ? ['merchant', 'date', 'total'].filter((f) => !review.edited.has(f === 'merchant' ? 'merchantName' : f === 'date' ? 'transactionDate' : 'amount')) : [];
  const live = review
    ? arithmeticWarning({
        subtotal: tryParseCents(review.values.subtotal) !== null ? { value: tryParseCents(review.values.subtotal)!, confidence: 1, provenance: 'extracted' } : undefined,
        tax: tryParseCents(review.values.tax) !== null ? { value: tryParseCents(review.values.tax)!, confidence: 1, provenance: 'extracted' } : undefined,
        tip: tryParseCents(review.values.tip) !== null ? { value: tryParseCents(review.values.tip)!, confidence: 1, provenance: 'extracted' } : undefined,
        discount: tryParseCents(review.values.discount) !== null ? { value: tryParseCents(review.values.discount)!, confidence: 1, provenance: 'extracted' } : undefined,
        total: tryParseCents(review.values.amount) !== null ? { value: tryParseCents(review.values.amount)!, confidence: 1, provenance: 'extracted' } : undefined,
        lineItems: [],
      })
    : null;

  const save = async (mode: 'verified' | 'needs_review', mergeInto?: string) => {
    if (!review || !prepared) return;
    const known = { categoryIds: new Set(categories.map((c) => c.categoryId)), memberIds: new Set(members.map((m) => m.memberId)) };
    const v = validateExpenseForm(review.values, known);
    if (!v.ok) {
      setError(Object.values(v.errors).join(' · '));
      return;
    }
    if (mode === 'verified' && uncertain.length && !review.confirmed) {
      setError('Please check the highlighted fields and tick the confirmation box.');
      return;
    }
    const lineItems = review.lines
      .map((l) => ({ description: l.description, totalCents: tryParseCents(l.amount), quantity: l.quantity, unitPriceCents: l.unitPriceCents, confidence: l.confidence, manuallyVerified: l.edited }))
      .filter((l): l is typeof l & { totalCents: number } => l.totalCents !== null && l.description.trim().length > 0);
    const image = { bytes: review.bytes, thumbnail: review.thumbnail, mimeType: 'image/jpeg', hash: prepared.hash, originalFileName: prepared.file.name };
    const encryptImages = (await getSetting(db, 'encryptReceipts')) ?? true;
    setSaving(true);
    setError('');
    try {
      const target = mergeInto ?? attachTo;
      if (target) {
        if (attachTo) {
          const ext = v.value;
          await repo.updateExpense(attachTo, ext, { verificationStatus: mode });
        }
        await repo.attachReceipt(target, image, { encryptImages, timezone, lineItems });
        toast(mergeInto ? 'Receipt image added to the existing expense' : 'Receipt attached');
      } else {
        const provenance: Record<string, Provenance> = {};
        for (const [field, key] of Object.entries(PROV_KEY)) if (review.prov[field]) provenance[key] = review.prov[field]!;
        provenance.categoryId = review.edited.has('categoryId') ? 'manual' : 'inferred';
        await repo.createExpenseFromReceipt(
          {
            expense: { ...v.value, transactionTime: review.values.time || undefined, receiptNumber: review.values.receiptNumber || undefined, paymentMethod: review.values.paymentMethod || undefined },
            provenance,
            ocrConfidence: review.parsed?.ocrConfidence,
            verificationStatus: mode,
            lineItems,
            image,
            encryptImages,
          },
          timezone,
        );
        toast(`Saved ${v.value.merchantName} · ${formatCents(v.value.totalCents)}${queue.length > 1 ? ` (${index + 1} of ${queue.length})` : ''}`);
      }
      await noteCategoryChoice(db, rules, v.value.merchantName, review.suggestion.categoryId, v.value.categoryId);
      setSaving(false);
      next();
    } catch (e) {
      setSaving(false);
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const badge = (field: string) => {
    const p = review?.prov[field];
    const c = review?.conf[field];
    if (!p) return <span className="badge missing">Not found</span>;
    if (p === 'manual') return <span className="badge manual">Entered by you</span>;
    if (p === 'inferred') return <span className="badge inferred">Guessed — check</span>;
    if (c !== undefined && c < 0.75) return <span className="badge low">Low confidence</span>;
    return <span className="badge extracted">Read from receipt</span>;
  };
  const low = (field: string) => {
    const p = review?.prov[field];
    return !p || p === 'inferred' || (p === 'extracted' && (review?.conf[field] ?? 1) < 0.75);
  };

  return (
    <section aria-labelledby="scan-title">
      <div className="page-head">
        <h1 id="scan-title" tabIndex={-1}>{attachExpense ? `Attach receipt · ${attachExpense.merchantName}` : 'Scan receipt'}</h1>
        {queue.length > 1 && <span className="tag">Receipt {index + 1} of {queue.length}</span>}
      </div>
      {error && <div className="banner warn" role="alert">{error}</div>}

      {step === 'pick' && (
        <div className="card scan-pick">
          <p>Take a photo of a receipt or choose images. Text is read <strong>on this device</strong> — nothing is sent to an online service.</p>
          <div className="row gap wrap">
            <button className="btn primary big" onClick={() => cameraRef.current?.click()}>📷 Take photo</button>
            <button className="btn ghost big" onClick={() => filesRef.current?.click()}>🖼️ Choose images</button>
          </div>
          <input ref={cameraRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" aria-label="Take photo" onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
          <input ref={filesRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple={!attachTo} aria-label="Choose receipt images" onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
          <ul className="muted small">
            <li>JPEG, PNG or WebP, up to 15 MB each. Choose up to 20 at once to process them one after another.</li>
            <li>Flat, well-lit receipts on a dark background read best.</li>
            <li>The first scan downloads the reading engine (about 4 MB) from this app; after that it works offline.</li>
          </ul>
        </div>
      )}

      {step === 'edit' && prepared && (
        <div className="card">
          <ImageEditor image={prepared.image} rotation={rotation} crop={crop} enhance={enhance} onRotation={setRotation} onCrop={setCrop} onEnhance={setEnhance} />
          <div className="row gap wrap between">
            <div className="row gap wrap">
              <button className="btn ghost" onClick={() => cameraRef.current?.click()}>Retake</button>
              <button className="btn ghost" onClick={() => filesRef.current?.click()}>Replace</button>
              <input ref={cameraRef} className="sr-only" type="file" accept="image/*" capture="environment" aria-label="Retake photo" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const q = [...queue]; q[index] = f; setQueue(q); void load(q, index); } e.target.value = ''; }} />
              <input ref={filesRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Replace image" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const q = [...queue]; q[index] = f; setQueue(q); void load(q, index); } e.target.value = ''; }} />
              {queue.length > 1 && <button className="btn ghost" onClick={next}>Skip this one</button>}
            </div>
            <div className="row gap wrap">
              <button className="btn ghost" onClick={() => void process(false)}>Enter details by hand</button>
              <button className="btn primary" onClick={() => void process(true)}>Read receipt</button>
            </div>
          </div>
        </div>
      )}

      {step === 'reading' && (
        <div className="card center" aria-busy="true">
          <p><strong>Reading the receipt on this device…</strong></p>
          <progress max={1} value={progress.p} aria-label="OCR progress" />
          <p className="muted small">{progress.status}</p>
        </div>
      )}

      {step === 'review' && review && (
        <div className="review-grid">
          <div className="card review-image">
            <img src={review.previewUrl} alt="Receipt photo" />
            {review.parsed && <p className="muted small">Text confidence: {Math.round(review.parsed.ocrConfidence * 100)}%{review.parsed.retailerProfile ? ` · ${review.parsed.retailerProfile} layout` : ''}</p>}
          </div>
          <form className="card form review-form" onSubmit={(e) => { e.preventDefault(); void save('verified'); }} noValidate>
            <h2>Check the details</h2>
            {(review.parsed?.warnings.length || live) && (
              <ul className="banner warn block" role="status">
                {[...(review.parsed?.warnings ?? []).filter((w) => !/add up/.test(w)), ...(live ? [live] : [])].map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}

            {duplicates.length > 0 && dupChoice === 'undecided' && (
              <div className="banner bad block" role="alert">
                <p><strong>Possible duplicate.</strong> Nothing will be deleted — choose what to do:</p>
                <ul className="plain-list">
                  {duplicates.slice(0, 3).map((d) => (
                    <li key={d.expense.expenseId}>
                      <a href={`#/expenses/${d.expense.expenseId}`} target="_blank" rel="noreferrer">
                        {d.expense.merchantName} · {formatDate(d.expense.transactionDate)} · {formatCents(d.expense.totalCents)} · {memberById.get(d.expense.paidByMemberId)?.displayName}
                      </a>
                      <span className="muted small"> — {d.reasons.join('; ')}</span>
                      {!attachTo && !d.expense.receiptId && (
                        <button type="button" className="btn small" onClick={() => void save('verified', d.expense.expenseId)}>Add this image to it</button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="row gap">
                  <button type="button" className="btn small" onClick={() => setDupChoice('keep')}>It's different — keep both</button>
                  <button type="button" className="btn ghost small" onClick={next}>Discard this scan</button>
                </div>
              </div>
            )}

            <fieldset disabled={saving}>
              <div className="grid2">
                <Field id="rv-merchant" label="Merchant">
                  <input id="rv-merchant" className={low('merchantName') ? 'low' : ''} value={review.values.merchantName} onChange={(e) => setVal('merchantName', e.target.value)} />
                  {badge('merchantName')}
                </Field>
                <Field id="rv-total" label="Total paid (USD)">
                  <input id="rv-total" inputMode="decimal" className={low('amount') ? 'low' : ''} value={review.values.amount} onChange={(e) => setVal('amount', e.target.value)} />
                  {badge('amount')}
                </Field>
              </div>
              <div className="grid3">
                <Field id="rv-date" label="Date">
                  <input id="rv-date" type="date" className={low('transactionDate') ? 'low' : ''} value={review.values.transactionDate} onChange={(e) => setVal('transactionDate', e.target.value)} />
                  {badge('transactionDate')}
                </Field>
                <Field id="rv-time" label="Time"><input id="rv-time" type="time" value={review.values.time} onChange={(e) => setVal('time', e.target.value)} /></Field>
                <Field id="rv-num" label="Receipt #"><input id="rv-num" value={review.values.receiptNumber} maxLength={30} onChange={(e) => setVal('receiptNumber', e.target.value)} /></Field>
              </div>
              <div className="grid4">
                {(['subtotal', 'tax', 'tip', 'discount'] as const).map((k) => (
                  <Field key={k} id={`rv-${k}`} label={k[0]!.toUpperCase() + k.slice(1)}>
                    <input id={`rv-${k}`} inputMode="decimal" placeholder="—" value={review.values[k]} onChange={(e) => setVal(k, e.target.value)} />
                    {review.prov[k] && badge(k)}
                  </Field>
                ))}
              </div>
              <div className="grid3">
                <Field id="rv-cat" label="Category" hint={!review.edited.has('categoryId') ? `Suggested: ${review.suggestion.reason}` : undefined}>
                  <select id="rv-cat" value={review.values.categoryId} onChange={(e) => { setVal('categoryId', e.target.value); setReview((r) => (r ? { ...r, values: { ...r.values, categoryId: e.target.value, subcategoryId: '' } } : r)); }}>
                    {categories.filter((c) => !c.isArchived).map((c) => <option key={c.categoryId} value={c.categoryId}>{c.parentCategoryId ? `  ↳ ${c.name}` : `${c.icon} ${c.name}`}</option>)}
                  </select>
                </Field>
                <Field id="rv-paid" label="Who paid">
                  <select id="rv-paid" value={review.values.paidByMemberId} onChange={(e) => setVal('paidByMemberId', e.target.value)}>
                    {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
                  </select>
                </Field>
                <Field id="rv-type" label="Shared or personal">
                  <select id="rv-type" value={review.values.expenseType} onChange={(e) => setVal('expenseType', e.target.value)}>
                    <option value="shared">Shared</option><option value="personal">Personal</option>
                  </select>
                </Field>
              </div>
              <Field id="rv-pay" label="Payment method (only if printed)" hint="Card numbers are never stored."><input id="rv-pay" value={review.values.paymentMethod} maxLength={30} onChange={(e) => setVal('paymentMethod', e.target.value)} /></Field>
              <Field id="rv-notes" label="Notes"><textarea id="rv-notes" rows={2} value={review.values.notes} onChange={(e) => setVal('notes', e.target.value)} /></Field>

              <details className="line-items" open={review.lines.length > 0 && review.lines.length <= 12}>
                <summary>Line items ({review.lines.length})</summary>
                <table>
                  <thead><tr><th>Item</th><th>Amount</th><th><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>
                    {review.lines.map((l, i) => (
                      <tr key={l.id} className={(l.confidence ?? 1) < 0.75 ? 'low' : ''}>
                        <td><input aria-label={`Item ${i + 1} description`} value={l.description} onChange={(e) => setReview({ ...review, lines: review.lines.map((x) => (x.id === l.id ? { ...x, description: e.target.value, edited: true } : x)) })} /></td>
                        <td><input aria-label={`Item ${i + 1} amount`} inputMode="decimal" value={l.amount} onChange={(e) => setReview({ ...review, lines: review.lines.map((x) => (x.id === l.id ? { ...x, amount: e.target.value, edited: true } : x)) })} /></td>
                        <td><button type="button" className="btn ghost small" aria-label={`Remove item ${i + 1}`} onClick={() => setReview({ ...review, lines: review.lines.filter((x) => x.id !== l.id) })}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn ghost small" onClick={() => setReview({ ...review, lines: [...review.lines, { id: crypto.randomUUID(), description: '', amount: '', edited: true }] })}>+ Add item</button>
              </details>

              {uncertain.length > 0 && (
                <label className="check confirm">
                  <input type="checkbox" checked={review.confirmed} onChange={(e) => setReview({ ...review, confirmed: e.target.checked })} />
                  I checked the {uncertain.map((u) => (u === 'total' ? 'total' : u)).join(', ')} — they're correct.
                </label>
              )}
            </fieldset>
            <div className="row gap wrap between">
              <button type="button" className="btn ghost" onClick={() => setStep('edit')}>Back to image</button>
              <div className="row gap wrap">
                {!attachTo && <button type="button" className="btn ghost" disabled={saving || (duplicates.length > 0 && dupChoice === 'undecided')} onClick={() => void save('needs_review')}>Save, review later</button>}
                <button type="submit" className="btn primary" disabled={saving || (duplicates.length > 0 && dupChoice === 'undecided')}>{saving ? 'Saving…' : attachTo ? 'Attach receipt' : 'Save expense'}</button>
              </div>
            </div>
            <p className="muted small">
              {categoryById.get(review.values.categoryId)?.name ?? ''} · The image is kept on this device until it's uploaded to your household Google Drive{' '}
              (encrypted), then deleted from Drive two years after the purchase date. The expense record stays.
            </p>
          </form>
        </div>
      )}
    </section>
  );
}
