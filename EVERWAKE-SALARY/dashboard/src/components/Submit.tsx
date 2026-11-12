'use client';
import { createContext, startTransition, useActionState, useContext, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from '@/app/actions';

const Busy = createContext(false);

// A form for a server action that keeps what was typed when the action answers with an error
// (a plain <form action> resets every field afterwards, success or not). resetOnOk clears it after a success.
export function ActionForm({ action, children, className, style, resetOnOk }: {
  action: (s: FormState, fd: FormData) => Promise<FormState>;
  children: (state: FormState) => React.ReactNode;
  className?: string; style?: React.CSSProperties; resetOnOk?: boolean;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (resetOnOk && state?.ok) ref.current?.reset(); }, [state, resetOnOk]);
  return (
    <form ref={ref} className={className} style={style}
          onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); startTransition(() => run(fd)); }}>
      <Busy.Provider value={pending}>{children(state)}</Busy.Provider>
    </form>
  );
}

// a submit button that says it is working while the form is on its way
export function Submit({ children, pending, className = 'btn primary', disabled }: {
  children: React.ReactNode; pending?: React.ReactNode; className?: string; disabled?: boolean;
}) {
  const s = useFormStatus();
  const busy = useContext(Busy) || s.pending;
  return (
    <button type="submit" className={className} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && pending ? pending : children}
    </button>
  );
}

export function FormStatus({ state }: { state: FormState }) {
  if (!state) return null;
  if (state.error) return <p className="status err" role="alert">{state.error}</p>;
  if (state.message) return <p className="status" role="status">{state.message}</p>;
  return null;
}
