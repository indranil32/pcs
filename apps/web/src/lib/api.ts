// Thin API client: JWT from localStorage, optional port (tenant) override for platform admins.
const TOKEN = 'pcs.token';
const TENANT = 'pcs.tenant';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export const session = {
  token: () => store.get(TOKEN),
  setToken: (t: string | null) => store.set(TOKEN, t),
  tenant: () => store.get(TENANT),
  setTenant: (t: string | null) => store.set(TENANT, t),
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const t = session.token();
  if (t) headers.authorization = `Bearer ${t}`;
  const tenant = session.tenant();
  if (tenant) headers['x-tenant-id'] = tenant;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const r = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  if (r.status === 401 && t) { session.setToken(null); location.href = '/login'; }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`, details;
    try { const j = await r.json(); msg = j.error ?? msg; details = j.details; } catch { /* not json */ }
    if (Array.isArray(details) && details[0]?.message) msg += `: ${details.map((d: any) => `${d.path?.join('.') ?? ''} ${d.message}`).join('; ')}`;
    throw new ApiError(r.status, msg, details);
  }
  if (opts.raw) return r as unknown as T;
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('json') ? r.json() : r.text()) as Promise<T>;
}

export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export async function download(path: string, filename: string) {
  const r = await api<Response>(path, { raw: true });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
