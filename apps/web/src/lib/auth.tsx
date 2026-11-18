import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@pcs/shared';
import { api, post, session, patch } from './api';
import { setLang, type Lang } from './i18n';

export interface Me {
  user: { id?: string; email?: string; name: string; roles: Role[]; lang?: Lang; orgId?: string; orgName?: string; orgType?: string };
  tenant: { id: string; code: string; name: string; currency: string; settings: any };
  tenants: { id: string; code: string; name: string }[];
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  has: (...roles: Role[]) => boolean;
  switchTenant: (id: string) => void;
  changeLang: (l: Lang) => void;
}
const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(session.token());
  const q = useQuery({ queryKey: ['me', token, session.tenant()], queryFn: () => api<Me>('/auth/me'), enabled: !!token, retry: false, staleTime: 60_000 });
  const me = token ? (q.data ?? null) : null;
  useEffect(() => { if (me?.user.lang) setLang(me.user.lang); }, [me?.user.lang]);

  const value: AuthCtx = {
    me,
    loading: !!token && q.isLoading,
    async login(email, password) {
      const r = await post<{ token: string }>('/auth/login', { email, password });
      session.setToken(r.token);
      session.setTenant(null);
      setToken(r.token);
      await qc.invalidateQueries();
    },
    logout() {
      session.setToken(null);
      session.setTenant(null);
      setToken(null);
      qc.clear();
    },
    has: (...roles) => !!me && (me.user.roles.includes('SYS_ADMIN') || roles.some((r) => me.user.roles.includes(r))),
    switchTenant(id) {
      session.setTenant(id);
      qc.clear();
      location.href = '/';
    },
    changeLang(l) {
      setLang(l);
      if (me?.user.id) patch('/auth/me', { lang: l }).catch(() => {});
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
