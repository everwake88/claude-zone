'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { X, ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { saveInstructions, addWordRule, deleteWordRule, restoreInstructions } from '@/app/actions';
import type { InstrData, InstrResult } from '@/lib/instructions';

type W = Record<string, string>;
type Msg = { error?: string; message?: string } | null;

function Status({ msg }: { msg: Msg }) {
  if (!msg) return null;
  if (msg.error) return <p className="status err" role="alert">{msg.error}</p>;
  if (msg.message) return <p className="status" role="status">{msg.message}</p>;
  return null;
}

// The whole Agent instructions page below its title. It keeps its own copy of the data, and every
// action answers with a fresh one, so what is on screen is always what was just saved.
export function InstructionsScreen({ initial, w, rtl }: { initial: InstrData; w: W; rtl: boolean }) {
  const [data, setData] = useState(initial);
  const cur = data.versions[0];
  const body = cur?.body ?? '';

  // the text box: what is live, until someone types
  const [value, setValue] = useState(body);
  const [note, setNote] = useState('');
  const liveId = cur?.id;
  useEffect(() => { setValue(body); }, [liveId]);                    // a save or a restore brings the new live text
  const dirty = value.trim() !== body.trim();
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const [saving, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<Msg>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const apply = (r: InstrResult) => { if (r.data) setData(r.data); };

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || saving) return;
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      const r = await saveInstructions(fd);
      setSaveMsg(r);
      if (r.ok) setNote('');
      apply(r);
    });
  }

  // the word list
  const [avoid, setAvoid] = useState('');
  const [say, setSay] = useState('');
  const [adding, startAdd] = useTransition();
  const [wordMsg, setWordMsg] = useState<Msg>(null);
  function addWord(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startAdd(async () => {
      const r = await addWordRule(fd);
      setWordMsg(r);
      if (r.ok) { setAvoid(''); setSay(''); }
      apply(r);
    });
  }
  const [busy, setBusy] = useState<string | null>(null);
  const [, startOther] = useTransition();
  function removeWord(id: string) {
    setBusy('w' + id);
    startOther(async () => { const r = await deleteWordRule(id); apply(r); setBusy(null); });
  }
  function restore(id: string) {
    if (dirty && !window.confirm(w.discard)) return;
    setBusy('v' + id);
    startOther(async () => { const r = await restoreInstructions(id); setSaveMsg(r); apply(r); setBusy(null); });
  }
  const To = rtl ? ArrowLeft : ArrowRight;
  const n = (x: number) => x.toLocaleString(w.locale);

  return (
    <div className="grid-2 rise" style={{ ['--i' as string]: 1 }}>
      <section className="panel" aria-labelledby="ed-h">
        <div className="panel-head">
          <h2 id="ed-h">{w.editorTitle}</h2>
          {cur && <span className="meta">{w.liveSince.replace('{date}', cur.when).replace('{name}', cur.who)}</span>}
        </div>
        <div className="panel-body stack" style={{ gap: 18 }}>
          <form ref={formRef} className="form" onSubmit={save}>
            <input type="hidden" name="base_id" value={cur?.id ?? ''} />
            <div className="field">
              <div className="prompt-top">
                <label htmlFor="body">{w.editor}</label>
                <span className="prompt-meta">
                  {dirty && <span className="pill warn"><span className="dot" />{w.unsaved}</span>}
                  <span className="muted num">{w.chars.replace('{n}', n(value.length))}</span>
                </span>
              </div>
              <textarea id="body" name="body" className="textarea prompt" dir="auto" spellCheck={false} value={value}
                        aria-describedby="body-h" onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); formRef.current?.requestSubmit(); }
                        }} />
              <span className="hint" id="body-h">{w.editorSub}</span>
            </div>
            <div className="field">
              <label htmlFor="note">{w.note}</label>
              <input className="input" id="note" name="note" maxLength={300} placeholder={w.notePh} autoComplete="off"
                     value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="form-foot">
              <button type="submit" className="btn primary" disabled={!dirty || saving} aria-busy={saving || undefined}>{saving ? w.saving : w.save}</button>
              {dirty && <button type="button" className="btn" onClick={() => setValue(body)}>{w.undo}</button>}
              <span className="hint kbd-hint">{w.shortcut}</span>
              <Status msg={saveMsg} />
            </div>
          </form>
          <p className="notice calm"><ShieldCheck aria-hidden="true" />{w.privacy}</p>
          <details className="reads">
            <summary>{w.reads}</summary>
            <p className="hint">{w.readsSub}</p>
            <pre dir="auto" tabIndex={0}>{data.live}</pre>
          </details>
        </div>
      </section>

      <div className="stack" style={{ gap: 'var(--gap)' }}>
        <section className="panel" aria-labelledby="wr-h">
          <div className="panel-head">
            <h2 id="wr-h">{w.words}</h2>
            {data.rules.length > 0 && <span className="meta num">{w.wordCount.replace('{n}', n(data.rules.length))}</span>}
          </div>
          <div className="panel-body stack" style={{ gap: 16 }}>
            <p className="hint">{w.wordsSub}</p>
            {data.rules.length === 0 ? <p className="empty-line">{w.noWords}</p> : (
              <ul className="rules">
                {data.rules.map((r) => (
                  <li key={r.id} className={busy === 'w' + r.id ? 'going' : ''}>
                    <span className="rule">
                      <span className="w-avoid" dir="auto">{r.avoid}</span>
                      {r.say
                        ? <><To aria-hidden="true" className="w-to" /><span className="w-say" dir="auto">{r.say}</span></>
                        : <span className="w-never">{w.never}</span>}
                    </span>
                    <button type="button" className="icon-x" aria-label={w.remove.replace('{w}', r.avoid)}
                            disabled={busy === 'w' + r.id} onClick={() => removeWord(r.id)}><X aria-hidden="true" /></button>
                  </li>
                ))}
              </ul>
            )}
            <form className="form rule-add" onSubmit={addWord}>
              <div className="two">
                <div className="field">
                  <label htmlFor="avoid">{w.dontSay}</label>
                  <input className="input" id="avoid" name="avoid" dir="auto" maxLength={120} required placeholder={w.avoidPh} autoComplete="off"
                         value={avoid} onChange={(e) => setAvoid(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="say">{w.sayInstead}</label>
                  <input className="input" id="say" name="say" dir="auto" maxLength={120} placeholder={w.sayPh} autoComplete="off" aria-describedby="say-h"
                         value={say} onChange={(e) => setSay(e.target.value)} />
                </div>
              </div>
              <span className="hint" id="say-h">{w.sayHint}</span>
              <div className="form-foot">
                <button type="submit" className="btn dark" disabled={adding} aria-busy={adding || undefined}>{adding ? w.saving : w.add}</button>
                <Status msg={wordMsg} />
              </div>
            </form>
          </div>
        </section>

        <section className="panel" aria-labelledby="vh-h">
          <div className="panel-head"><h2 id="vh-h">{w.history}</h2></div>
          <div className="panel-body">
            <p className="hint" style={{ marginBottom: 12 }}>{w.historySub}</p>
            <ol className="versions">
              {data.versions.map((v, i) => (
                <li key={v.id} className={i === 0 ? 'cur' : ''}>
                  <div className="v-row">
                    <div className="v-what">
                      <b className="num">{v.when}</b>
                      <span className="v-tags">
                        {i === 0 && <span className="pill pos"><span className="dot" />{w.current}</span>}
                        {v.isDefault && <span className="pill">{w.original}</span>}
                      </span>
                      <span className="v-sub">
                        {v.who}
                        {v.note ? <> · <span dir="auto">{v.note}</span></> : null}
                        {v.restored ? <> · {w.restoredFrom.replace('{date}', v.restored)}</> : null}
                      </span>
                    </div>
                    {i > 0 && (
                      <button type="button" className="btn sm" disabled={busy === 'v' + v.id} aria-busy={busy === 'v' + v.id || undefined}
                              onClick={() => restore(v.id)}>{w.restore}</button>
                    )}
                  </div>
                  <details className="v-text">
                    <summary>{w.view.replace('{n}', n(v.chars))}</summary>
                    <pre dir="auto" tabIndex={0}>{v.body}</pre>
                  </details>
                </li>
              ))}
            </ol>
            {cur && !cur.isDefault && (
              <button type="button" className="link-btn" style={{ marginTop: 14 }} disabled={busy === 'vdefault'}
                      onClick={() => restore('default')}>{w.backToOriginal}</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
