// One app-wide state object. Components subscribe to the slice they use and
// re-render only when that slice changes.
import { useEffect, useReducer, useRef } from './h.js';

let state = {};
const subs = new Set();

export const getState = () => state;

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next) return;
  state = { ...state, ...next };
  for (const fn of subs) fn();
}

export function initState(initial) {
  state = initial;
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export function useStore(select) {
  const [, force] = useReducer((x) => x + 1, 0);
  const sel = useRef(select);
  sel.current = select;
  const value = select(state);
  const last = useRef(value);
  last.current = value;
  useEffect(() => {
    const fn = () => {
      const v = sel.current(state);
      if (!same(v, last.current)) force();
    };
    subs.add(fn);
    fn(); // state may have changed between render and this effect
    return () => subs.delete(fn);
  }, []);
  return value;
}
