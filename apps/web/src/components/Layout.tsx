import { useState, type ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  LayoutDashboard, Ship, CalendarRange, ShieldCheck, Package, FileCheck2, Truck, DoorOpen, Waves, TrainFront, Anchor, Receipt,
  Percent, ArrowLeftRight, Map, Settings, Bell, LogOut, ChevronDown, Globe, BookOpen,
} from 'lucide-react';
import type { Role } from '@pcs/shared';
import { useAuth } from '../lib/auth';
import { useT, useLang, type Lang } from '../lib/i18n';
import { api, post } from '../lib/api';
import { ago, label } from '../lib/format';

interface NavItem { to: string; key: string; icon: any; roles?: Role[] }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: '', items: [{ to: '/', key: 'dashboard', icon: LayoutDashboard }] },
  {
    group: 'operations', items: [
      { to: '/vessel-calls', key: 'vesselCalls', icon: Ship },
      { to: '/berth-plan', key: 'berthPlan', icon: CalendarRange, roles: ['HARBOUR_MASTER', 'PORT_ADMIN', 'TERMINAL_OPERATOR', 'SHIPPING_AGENT', 'SHIPPING_LINE', 'EXECUTIVE'] },
      { to: '/clearance', key: 'clearance', icon: ShieldCheck, roles: ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'BORDER_POLICE', 'PORT_HEALTH', 'MARITIME_SAFETY', 'PORT_ADMIN', 'EXECUTIVE'] },
      { to: '/cargo', key: 'cargo', icon: Package },
      { to: '/services', key: 'services', icon: Anchor, roles: ['SHIPPING_AGENT', 'SHIPPING_LINE', 'SERVICE_PROVIDER', 'HARBOUR_MASTER', 'PORT_ADMIN', 'TERMINAL_OPERATOR', 'EXECUTIVE'] },
      { to: '/map', key: 'map', icon: Map },
    ],
  },
  {
    group: 'hinterland', items: [
      { to: '/delivery-orders', key: 'deliveryOrders', icon: FileCheck2, roles: ['FREIGHT_FORWARDER', 'SHIPPING_LINE', 'SHIPPING_AGENT', 'HAULIER', 'TERMINAL_OPERATOR', 'CUSTOMS', 'PORT_ADMIN', 'EXECUTIVE'] },
      { to: '/trucks', key: 'trucks', icon: Truck, roles: ['HAULIER', 'TERMINAL_OPERATOR', 'PORT_ADMIN', 'EXECUTIVE', 'FREIGHT_FORWARDER'] },
      { to: '/gate', key: 'gate', icon: DoorOpen, roles: ['TERMINAL_OPERATOR', 'PORT_ADMIN'] },
      { to: '/barges', key: 'barges', icon: Waves, roles: ['BARGE_OPERATOR', 'HARBOUR_MASTER', 'TERMINAL_OPERATOR', 'PORT_ADMIN', 'EXECUTIVE'] },
      { to: '/rail', key: 'rail', icon: TrainFront, roles: ['RAIL_OPERATOR', 'TERMINAL_OPERATOR', 'HARBOUR_MASTER', 'PORT_ADMIN', 'EXECUTIVE'] },
    ],
  },
  {
    group: 'commercial', items: [
      { to: '/finance', key: 'finance', icon: Receipt },
      { to: '/tariffs', key: 'tariffs', icon: Percent, roles: ['FINANCE', 'PORT_ADMIN', 'EXECUTIVE'] },
    ],
  },
  {
    group: 'platform', items: [
      { to: '/edi', key: 'edi', icon: ArrowLeftRight },
      { to: '/admin', key: 'admin', icon: Settings },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, has, logout, switchTenant, changeLang } = useAuth();
  const t = useT();
  const lang = useLang();
  const nav = useNavigate();
  const [bell, setBell] = useState(false);
  const [menu, setMenu] = useState(false);
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api<any[]>('/notifications'), refetchInterval: 20_000 });
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;
  const langs: Lang[] = (me?.tenant.settings?.languages as Lang[]) ?? ['en'];

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col bg-navy-900 text-slate-300 md:flex">
        <Link to="/" className="flex items-center gap-2.5 px-5 py-4">
          <img src="/favicon.svg" className="h-8 w-8" alt="" />
          <div>
            <div className="text-sm font-semibold leading-tight text-white">Maqta PCS</div>
            <div className="text-[11px] leading-tight text-teal-400">{me?.tenant.name}</div>
          </div>
        </Link>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.roles || has(...i.roles));
            if (!items.length) return null;
            return (
              <div key={g.group} className="mt-3">
                {g.group && <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t(g.group)}</div>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-navy-700 text-white' : 'hover:bg-navy-800 hover:text-white')}>
                    <i.icon className="h-4 w-4" />{t(i.key)}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <a href="/api/docs" target="_blank" rel="noreferrer" className="mx-3 mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-400 hover:bg-navy-800 hover:text-white"><BookOpen className="h-3.5 w-3.5" />API documentation</a>
        <div className="border-t border-navy-800 px-5 py-3 text-[11px] text-slate-500">Maqta Technologies (TradeTech) · AD Ports Group</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b border-slate-200 bg-white px-4">
          {me?.tenants?.length ? (
            <select value={me.tenant.id} onChange={(e) => switchTenant(e.target.value)} className="mr-auto rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {me.tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          ) : <div className="mr-auto text-sm font-medium text-navy-900 md:hidden">{me?.tenant.name}</div>}
          {langs.length > 1 && (
            <div className="flex items-center gap-1 rounded-md border border-slate-200 p-0.5">
              <Globe className="ml-1 h-3.5 w-3.5 text-slate-400" />
              {langs.map((l) => (
                <button key={l} onClick={() => changeLang(l)} className={clsx('rounded px-1.5 py-0.5 text-xs font-medium uppercase', lang === l ? 'bg-navy-900 text-white' : 'text-slate-500 hover:bg-slate-100')}>{l}</button>
              ))}
            </div>
          )}
          <div className="relative">
            <button onClick={() => setBell(!bell)} className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label={t('notifications')}>
              <Bell className="h-5 w-5" />
              {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">{unread}</span>}
            </button>
            {bell && (
              <div className="absolute right-0 z-[1100] mt-2 w-96 rounded-xl border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                  <span className="text-sm font-semibold">{t('notifications')}</span>
                  <button className="text-xs text-teal-600 hover:underline" onClick={() => post('/notifications/read').then(() => notes.refetch())}>Mark all read</button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto">
                  {(notes.data ?? []).slice(0, 30).map((n) => (
                    <button key={n.id} onClick={() => { setBell(false); if (n.link) nav(n.link); post('/notifications/read', { ids: [n.id] }).then(() => notes.refetch()); }}
                      className={clsx('block w-full border-b border-slate-50 px-4 py-2.5 text-left hover:bg-slate-50', !n.read && 'bg-teal-50/40')}>
                      <div className="flex items-start gap-2">
                        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', { critical: 'bg-red-500', warning: 'bg-amber-500', success: 'bg-emerald-500', info: 'bg-sky-500' }[n.severity as string] ?? 'bg-sky-500')} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-800">{n.title}</div>
                          {n.body && <div className="truncate text-xs text-slate-500">{n.body}</div>}
                          <div className="text-[11px] text-slate-400">{ago(n.created_at)}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                  {!notes.data?.length && <div className="p-6 text-center text-sm text-slate-400">No notifications</div>}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button onClick={() => setMenu(!menu)} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-xs font-semibold text-white">{(me?.user.name ?? '').replace(/[^\p{L} ]/gu, '').split(' ').filter(Boolean).map((x) => x[0]).slice(0, 2).join('').toUpperCase()}</div>
              <div className="hidden text-left sm:block">
                <div className="text-sm font-medium leading-tight">{me?.user.name}</div>
                <div className="text-[11px] leading-tight text-slate-500">{me?.user.orgName ?? 'Platform'} · {me?.user.roles.map(label).join(', ')}</div>
              </div>
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </button>
            {menu && (
              <div className="absolute right-0 z-[1100] mt-2 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
                <button onClick={() => { logout(); nav('/login'); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"><LogOut className="h-4 w-4" />{t('signOut')}</button>
              </div>
            )}
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6" onClick={() => { setBell(false); setMenu(false); }}>{children}</main>
      </div>
    </div>
  );
}
