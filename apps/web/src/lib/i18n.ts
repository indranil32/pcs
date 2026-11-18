// Trilingual UI (Romanian / English / Ukrainian) per the Constanța requirement; other ports default to English.
import { useSyncExternalStore } from 'react';

export type Lang = 'en' | 'ro' | 'uk';
let current: Lang = ((): Lang => { try { return (localStorage.getItem('pcs.lang') as Lang) || 'en'; } catch { return 'en'; } })();
const listeners = new Set<() => void>();

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem('pcs.lang', l); } catch { /* ignore */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
export const useLang = () => useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => current);

const D: Record<string, [string, string, string]> = {
  // [en, ro, uk]
  dashboard: ['Dashboard', 'Tablou de bord', 'Панель'],
  vesselCalls: ['Vessel calls', 'Escale nave', 'Заходи суден'],
  berthPlan: ['Berth plan', 'Plan dane', 'План причалів'],
  clearance: ['Clearance queue', 'Coadă avizare', 'Черга погоджень'],
  cargo: ['Cargo & customs', 'Marfă și vamă', 'Вантаж і митниця'],
  deliveryOrders: ['Delivery orders', 'Ordine de livrare', 'Накази на видачу'],
  trucks: ['Truck appointments', 'Programări camioane', 'Записи вантажівок'],
  gate: ['Gate console', 'Consolă poartă', 'Консоль воріт'],
  barges: ['Barge calls', 'Escale barje', 'Заходи барж'],
  rail: ['Rail', 'Feroviar', 'Залізниця'],
  services: ['Marine services', 'Servicii portuare', 'Морські послуги'],
  finance: ['Invoices & payments', 'Facturi și plăți', 'Рахунки та платежі'],
  tariffs: ['Tariffs', 'Tarife', 'Тарифи'],
  edi: ['EDI monitor', 'Monitor EDI', 'Монітор EDI'],
  map: ['Port map', 'Hartă port', 'Карта порту'],
  admin: ['Administration', 'Administrare', 'Адміністрування'],
  operations: ['Operations', 'Operațiuni', 'Операції'],
  hinterland: ['Hinterland', 'Hinterland', 'Хінтерланд'],
  commercial: ['Commercial', 'Comercial', 'Комерція'],
  platform: ['Platform', 'Platformă', 'Платформа'],
  signIn: ['Sign in', 'Autentificare', 'Увійти'],
  signOut: ['Sign out', 'Deconectare', 'Вийти'],
  email: ['Email', 'Email', 'Ел. пошта'],
  password: ['Password', 'Parolă', 'Пароль'],
  search: ['Search', 'Caută', 'Пошук'],
  new: ['New', 'Nou', 'Новий'],
  save: ['Save', 'Salvează', 'Зберегти'],
  cancel: ['Cancel', 'Anulează', 'Скасувати'],
  submit: ['Submit', 'Trimite', 'Надіслати'],
  approve: ['Approve', 'Aprobă', 'Погодити'],
  reject: ['Reject', 'Respinge', 'Відхилити'],
  query: ['Raise query', 'Solicită clarificări', 'Запит'],
  status: ['Status', 'Stare', 'Статус'],
  vessel: ['Vessel', 'Navă', 'Судно'],
  agent: ['Agent', 'Agent', 'Агент'],
  berth: ['Berth', 'Dană', 'Причал'],
  eta: ['ETA', 'ETA', 'ETA'],
  etd: ['ETD', 'ETD', 'ETD'],
  notifications: ['Notifications', 'Notificări', 'Сповіщення'],
  noData: ['Nothing here yet', 'Nimic deocamdată', 'Поки що нічого'],
  register: ['Register your organisation', 'Înregistrați organizația', 'Зареєструвати організацію'],
  actions: ['Actions', 'Acțiuni', 'Дії'],
  details: ['Details', 'Detalii', 'Деталі'],
  documents: ['Documents', 'Documente', 'Документи'],
  history: ['History', 'Istoric', 'Історія'],
  messages: ['Messages', 'Mesaje', 'Повідомлення'],
  pending: ['Pending', 'În așteptare', 'Очікує'],
  all: ['All', 'Toate', 'Усі'],
  welcome: ['Port Community System', 'Sistemul Comunității Portuare', 'Система портової спільноти'],
  tagline: ['One window for every port stakeholder — vessels, cargo, customs, gates and payments.', 'O singură fereastră pentru toți actorii portuari — nave, marfă, vamă, porți și plăți.', 'Єдине вікно для всіх учасників порту — судна, вантажі, митниця, ворота та платежі.'],
  demoAccounts: ['Demo accounts', 'Conturi demo', 'Демо-акаунти'],
};

export function t(key: string): string {
  const row = D[key];
  if (!row) return key;
  return row[current === 'ro' ? 1 : current === 'uk' ? 2 : 0];
}
export function useT() {
  useLang();
  return t;
}
