'use client';
import { useEffect, useState } from 'react';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch, Item, ItemBranch } from '@/lib/types';
import { Button, Checkbox, Field, Input, Modal, Select, useAction } from '../ui';
import { useTenant } from '../tenant';

type Mode = 'percent' | 'amount' | 'set' | 'reset';
export interface PriceChange { mode: Mode; value?: number; from?: 'current' | 'restaurant'; round?: number; choices?: boolean }

// the same rounding as the database (everwake.round_price): to the nearest step, 0 = to the piastre
const roundTo = (p: number, step: number) => step > 0 ? Math.round(p / step) * step : Math.round(p * 100) / 100;

// New prices for many dishes at one branch: by %, by an amount, one price, or back to the restaurant's.
export function BranchPriceModal({ open, items, branch, overrides, onClose, onApply }:
  { open: boolean; items: Item[]; branch: Branch; overrides: Map<string, ItemBranch>; onClose: () => void; onApply: (p: PriceChange) => void }) {
  const { tenant } = useTenant();
  const t = useT();
  const [mode, setMode] = useState<Mode>('percent');
  const [value, setValue] = useState('10');
  const [from, setFrom] = useState<'current' | 'restaurant'>('current');
  const [round, setRound] = useState('1');
  const [choices, setChoices] = useState(true);
  useEffect(() => { if (open) { setMode('percent'); setValue('10'); setFrom('current'); setRound('1'); setChoices(true); } }, [open]);

  const v = Number(value);
  const bad = mode !== 'reset' && (value.trim() === '' || isNaN(v) || (mode === 'set' && v < 0) || (mode === 'percent' && v <= -100));
  const next = (i: Item) => {
    const cur = overrides.get(`${i.id}:${branch.id}`)?.price ?? i.price;
    if (mode === 'reset') return i.price;
    if (mode === 'set') return v;
    const base = from === 'restaurant' ? i.price : cur;
    if (base == null) return cur;
    return Math.max(0, roundTo(mode === 'percent' ? base * (1 + v / 100) : base + v, Number(round)));
  };
  const sym = tenant.currency_symbol;

  return (
    <Modal open={open} onClose={onClose} title={t('Prices at {branch}', { branch: branch.name_en || branch.name_ar })}
      footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="gold" disabled={bad} onClick={() => onApply(mode === 'reset' ? { mode, choices }
          : { mode, value: v, from, round: Number(round), choices: mode === 'percent' && choices })}>{t('Apply to {n} dishes', { n: items.length })}</Button></>}>
      <div className="space-y-3">
        <Field label={t('Change')}>
          <Select value={mode} onChange={e => setMode(e.target.value as Mode)}>
            <option value="percent">{t('Up or down by a percentage')}</option>
            <option value="amount">{t('Up or down by an amount')}</option>
            <option value="set">{t('One price for all of them')}</option>
            <option value="reset">{t('Back to the restaurant’s price')}</option>
          </Select>
        </Field>
        {mode !== 'reset' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={mode === 'percent' ? t('Percent (minus to lower)') : mode === 'amount' ? t('Amount ({currency}, minus to lower)', { currency: tenant.currency }) : t('Price ({currency})', { currency: tenant.currency })}>
              <Input type="number" step="0.5" value={value} onChange={e => setValue(e.target.value)} />
            </Field>
            {mode !== 'set' && (
              <Field label={t('Round to')}>
                <Select value={round} onChange={e => setRound(e.target.value)}>
                  <option value="1">{t('whole numbers')}</option><option value="5">{t('the nearest 5')}</option>
                  <option value="0.5">{t('halves')}</option><option value="0">{t('exact')}</option>
                </Select>
              </Field>
            )}
            {mode !== 'set' && (
              <Field label={t('Starting from')} className="col-span-2">
                <Select value={from} onChange={e => setFrom(e.target.value as 'current' | 'restaurant')}>
                  <option value="current">{t('this branch’s price now')}</option>
                  <option value="restaurant">{t('the restaurant’s price')}</option>
                </Select>
              </Field>
            )}
          </div>
        )}
        {(mode === 'percent' || mode === 'reset') && (
          <Checkbox checked={choices} onChange={setChoices} label={mode === 'percent' ? t('Choice prices too (sizes, add-ons)') : t('Choice prices back to the restaurant’s too')} />
        )}
        <div className="rounded-lg bg-paper p-3 text-xs">
          <p className="mb-1 font-medium text-muted">{t('Preview')}</p>
          {items.slice(0, 6).map(i => {
            const cur = overrides.get(`${i.id}:${branch.id}`)?.price ?? i.price;
            return <p key={i.id} className="flex justify-between gap-2"><span dir="auto" className="truncate">{i.name_ar}</span>
              <span className="whitespace-nowrap">{money(cur, sym)} → <strong>{bad ? '…' : money(next(i), sym)}</strong></span></p>;
          })}
          {items.length > 6 && <p className="text-muted">{t('and {n} more', { n: items.length - 6 })}</p>}
        </div>
      </div>
    </Modal>
  );
}

// A branch set up like another one, or back to the restaurant's menu.
export function CopyBranchModal({ open, branch, branches, onClose, onDone }:
  { open: boolean; branch: Branch; branches: Branch[]; onClose: () => void; onDone: () => void }) {
  const { tenant } = useTenant();
  const t = useT();
  const { busy, run } = useAction();
  const others = branches.filter(b => b.id !== branch.id);
  const [from, setFrom] = useState('');
  useEffect(() => { if (open) setFrom(others[0]?.id || ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const name = (b: Branch) => b.name_en || b.name_ar;

  const go = () => run(async () => {
    const { error } = await sb().rpc('copy_branch_menu', { p_tenant: tenant.id, p_from: from || null, p_to: branch.id });
    if (error) throw new Error(error.message);
    onDone();
  }, from ? t('{branch} now has the same menu as {other}', { branch: name(branch), other: name(others.find(b => b.id === from)!) })
          : t('{branch} is back to the restaurant’s menu', { branch: name(branch) }));

  return (
    <Modal open={open} onClose={onClose} title={t('Set up {branch}’s menu', { branch: name(branch) })}
      footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button><Button variant="gold" busy={busy} onClick={go}>{t('Set it up')}</Button></>}>
      <div className="space-y-3 text-sm">
        <Field label={t('The same as')}>
          <Select value={from} onChange={e => setFrom(e.target.value)}>
            {others.map(b => <option key={b.id} value={b.id}>{name(b)}</option>)}
            <option value="">{t('The restaurant’s menu — every dish at the restaurant’s prices')}</option>
          </Select>
        </Field>
        <p className="text-muted">{from
          ? t('Which dishes and categories are served, the prices and the choice prices become the same as {other}’s. Stock switches stay as they are.', { other: name(others.find(b => b.id === from) || branch) })
          : t('Every dish goes back on this branch’s menu at the restaurant’s prices and choices. Stock switches stay as they are.')}</p>
      </div>
    </Modal>
  );
}
