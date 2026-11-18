export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtMoney = (n?: number | null, cur = '') => (n == null ? '—' : `${cur} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim());
export const fmtNum = (n?: number | null, digits = 0) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const ago = (d: string | Date) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
/** Value for <input type="datetime-local"> in local time. */
export const toLocalInput = (d: Date | string) => {
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
};
