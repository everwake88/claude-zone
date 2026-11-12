'use client';
import { saveSheet, publishSheet, deleteSheet } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

type Col = { key: string; header: string; visible: boolean };
type Words = Record<'identity' | 'identitySub' | 'notInSheet' | 'columns' | 'columnsSub' | 'save' | 'saving' | 'titleField', string> & { fields: Record<string, string> };

export function SheetForm({ id, title, columns, identity, words }: { id: string; title: string; columns: Col[]; identity: Record<string, string>; words: Words }) {
  return (
    <ActionForm action={saveSheet} className="grid-2">{(state) => (<>
      <input type="hidden" name="id" value={id} />
      <section className="panel rise" style={{ ['--i' as string]: 2 }} aria-labelledby="map-h">
        <div className="panel-head"><h2 id="map-h">{words.identity}</h2></div>
        <div className="panel-body form">
          <p className="hint">{words.identitySub}</p>
          <div className="two">
            {Object.entries(words.fields).map(([f, label]) => (
              <div className="field" key={f}>
                <label htmlFor={`id_${f}`}>{label}</label>
                <select className="select" id={`id_${f}`} name={`id_${f}`} defaultValue={identity[f] || ''}>
                  <option value="">{words.notInSheet}</option>
                  {columns.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="field">
            <label htmlFor="title">{words.titleField}</label>
            <input className="input" id="title" name="title" defaultValue={title} />
          </div>
        </div>
      </section>
      <section className="panel rise" style={{ ['--i' as string]: 2 }} aria-labelledby="cols-h">
        <div className="panel-head"><h2 id="cols-h">{words.columns}</h2><span className="meta num">{columns.filter((c) => c.visible).length}/{columns.length}</span></div>
        <div className="panel-body form">
          <p className="hint">{words.columnsSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '4px 16px' }}>
            {columns.map((c) => (
              <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, cursor: 'pointer' }}>
                <input type="checkbox" name={`show_${c.key}`} defaultChecked={c.visible} style={{ width: 16, height: 16, accentColor: 'var(--sage)' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.header}</span>
              </label>
            ))}
          </div>
          <div className="form-foot">
            <Submit className="btn" pending={words.saving}>{words.save}</Submit>
            <FormStatus state={state} />
          </div>
        </div>
      </section>
    </>)}</ActionForm>
  );
}

export function PublishButton({ id, label, pending, disabled }: { id: string; label: string; pending: string; disabled?: boolean }) {
  return (
    <ActionForm action={publishSheet} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>{(state) => (<>
      <input type="hidden" name="id" value={id} />
      <FormStatus state={state?.error ? state : null} />
      <Submit pending={pending} disabled={disabled}>{label}</Submit>
    </>)}</ActionForm>
  );
}

export function DeleteForm({ id, words }: { id: string; words: { confirm: string; button: string } }) {
  return (
    <ActionForm action={deleteSheet} className="form" style={{ maxWidth: 420 }}>{(state) => (<>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor="confirm">{words.confirm}</label>
        <input className="input ltr" id="confirm" name="confirm" autoComplete="off" />
      </div>
      <div className="form-foot">
        <Submit className="btn danger">{words.button}</Submit>
        <FormStatus state={state} />
      </div>
    </>)}</ActionForm>
  );
}
