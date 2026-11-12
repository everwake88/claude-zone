'use client';
import { useState } from 'react';
import { saveIdentity } from '@/app/actions';
import { ActionForm, Submit, FormStatus } from './Submit';

const FIELDS = ['full_name', 'national_id', 'work_id', 'phone'] as const;
type F = (typeof FIELDS)[number];
type S = Record<`ask_${F}`, boolean> & { phone_must_match_sender: boolean; hidden_number_ask_phone: boolean; name_min_words: number; work_id_digits_only: boolean;
  work_id_min_length: number; work_id_max_length: number; verified_hours: number };

export function IdentityForm({ initial, w, p }: { initial: S; w: Record<string, string>; p: Record<string, string> }) {
  const [s, setS] = useState(initial);
  const set = (k: keyof S, v: boolean | number) => setS((x) => ({ ...x, [k]: v }));
  const asked = FIELDS.filter((f) => s[`ask_${f}`]);
  const noId = !s.ask_national_id && !s.ask_work_id;

  return (
    <ActionForm action={saveIdentity} className="grid-2">{(state) => (<>
      <div className="stack">
        <section className="panel rise" style={{ ['--i' as string]: 1 }} aria-labelledby="ask-h">
          <div className="panel-head"><h2 id="ask-h">{w.ask}</h2></div>
          <div className="panel-body">
            {FIELDS.map((f) => (
              <label className="choice" key={f}>
                <input type="checkbox" name={`ask_${f}`} checked={s[`ask_${f}`]} onChange={(e) => set(`ask_${f}`, e.target.checked)} />
                <span className="c-title">{w[f]}</span>
                <span className="c-hint">{w[`${f}Hint`]}</span>
              </label>
            ))}
            {noId && <p className="notice neg" role="alert" style={{ marginTop: 8 }}>{w.needOne}</p>}
            <div className="switch-row">
              <div>
                <div className="c-title" style={{ fontWeight: 500 }} id="match-l">{w.match}</div>
                <div className="hint">{w.matchHint}</div>
              </div>
              <span className="switch">
                <input type="checkbox" role="switch" name="phone_must_match_sender" aria-labelledby="match-l" checked={s.phone_must_match_sender}
                       onChange={(e) => set('phone_must_match_sender', e.target.checked)} />
                <span />
              </span>
            </div>
            <label className={`choice nested${s.phone_must_match_sender ? '' : ' off'}`}>
              <input type="checkbox" name="hidden_number_ask_phone" checked={s.hidden_number_ask_phone} disabled={!s.phone_must_match_sender}
                     onChange={(e) => set('hidden_number_ask_phone', e.target.checked)} />
              <span className="c-title">{w.hiddenAsk}</span>
              <span className="c-hint">{w.hiddenAskHint}</span>
            </label>
          </div>
        </section>
        <section className="panel rise" style={{ ['--i' as string]: 2 }} aria-labelledby="fmt-h">
          <div className="panel-head"><h2 id="fmt-h">{w.formats}</h2></div>
          <div className="panel-body form">
            <div className="field">
              <label htmlFor="name_min_words">{w.minWords}</label>
              <input className="input short num" type="number" min={1} max={6} id="name_min_words" name="name_min_words"
                     value={s.name_min_words} onChange={(e) => set('name_min_words', Number(e.target.value))} />
            </div>
            <div className="field">
              <span className="label" id="wid-l">{w.wid}</span>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }} role="group" aria-labelledby="wid-l">
                <span className="muted">{w.from}</span>
                <input className="input short num" type="number" min={1} max={30} name="work_id_min_length" aria-label={`${w.wid} ${w.from}`} defaultValue={s.work_id_min_length} />
                <span className="muted">{w.to}</span>
                <input className="input short num" type="number" min={1} max={40} name="work_id_max_length" aria-label={`${w.wid} ${w.to}`} defaultValue={s.work_id_max_length} />
              </div>
            </div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" name="work_id_digits_only" defaultChecked={s.work_id_digits_only} style={{ width: 16, height: 16, accentColor: 'var(--sage)' }} />
              {w.digitsOnly}
            </label>
            <div className="field">
              <label htmlFor="verified_hours">{w.hours}</label>
              <input className="input short num" type="number" min={0} max={720} id="verified_hours" name="verified_hours" aria-describedby="vh-h" defaultValue={s.verified_hours} />
              <span className="hint" id="vh-h">{w.hoursHint}</span>
            </div>
            <div className="form-foot">
              <Submit disabled={noId}>{w.save}</Submit>
              <FormStatus state={state} />
            </div>
          </div>
        </section>
      </div>

      <section className="panel rise" aria-labelledby="pv-h" style={{ position: 'sticky', top: 24, ['--i' as string]: 2 }}>
        <div className="panel-head"><h2 id="pv-h">{w.preview}</h2></div>
        <div className="panel-body">
          <p className="hint" style={{ marginBottom: 12 }}>{w.previewSub}</p>
          <div className="wa" data-ui dir="rtl" lang="ar">
            <div className="b out">{p.ask}<time>10:02</time></div>
            <div className="b in">{p.hello}<time>10:02</time></div>
            {asked.map((f, i) => (
              <Pair key={f} ask={i === 0 ? `${p[f]}` : p[f]} answer={p[`a_${f}`]} bad={f === 'national_id' ? p.badId : undefined} retry={f === 'national_id' ? p.a_national_id : undefined} />
            ))}
            {s.phone_must_match_sender && <div className="sys" dir="auto">{w.matchNote}{s.hidden_number_ask_phone ? ` ${w.hiddenNote}` : ''}</div>}
            <div className="b in">{p.ok}<time>10:04</time></div>
          </div>
        </div>
      </section>
    </>)}</ActionForm>
  );
}

function Pair({ ask, answer, bad, retry }: { ask: string; answer: string; bad?: string; retry?: string }) {
  return (
    <>
      <div className="b in">{ask}<time>10:03</time></div>
      {bad ? (
        <>
          <div className="b out ltr" style={{ justifySelf: 'end' }}>{answer.slice(0, 13)}<time>10:03</time></div>
          <div className="b in">{bad}<time>10:03</time></div>
          <div className="b out ltr" style={{ justifySelf: 'end' }}>{retry}<time>10:03</time></div>
        </>
      ) : <div className="b out">{answer}<time>10:03</time></div>}
    </>
  );
}
