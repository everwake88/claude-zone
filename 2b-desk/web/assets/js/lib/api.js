// Talking to the 2B Desk server.
const CFG = window.DESK_CONFIG || {};
const BASE = String(CFG.apiUrl || '').replace(/\/+$/, '');
const KEY = 'desk.token';

let token = null;
try {
  token = localStorage.getItem(KEY);
} catch {
  /* private mode: the session lasts as long as the tab */
}

export const getToken = () => token;
export function setToken(t) {
  token = t || null;
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

let signedOut = () => {};
export const onSignedOut = (fn) => (signedOut = fn);

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== '/api/auth/login') signedOut(data?.error);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data);
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);

export function wsUrl() {
  const base = BASE || location.origin;
  return base.replace(/^http/, 'ws') + '/ws';
}

export async function download(path, filename) {
  const res = await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Download failed.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
