// Reference-data validators used at every entry point (UI, REST API, EDI).

/** ISO 6346 container number check digit (e.g. MSCU1234565). */
export function isValidContainerNo(raw: string): boolean {
  const s = raw.replace(/\s|-/g, '').toUpperCase();
  if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(s)) return false;
  const values: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    values[ch] = v++;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i];
    const n = /\d/.test(c) ? Number(c) : values[c];
    sum += n * 2 ** i;
  }
  return (sum % 11) % 10 === Number(s[10]);
}

/** Compute the ISO 6346 check digit for a 10-char prefix (owner+category+serial). */
export function containerCheckDigit(prefix10: string): number {
  for (let d = 0; d <= 9; d++) if (isValidContainerNo(prefix10 + d)) return d;
  return -1;
}

/** IMO ship identification number (7 digits, weighted check digit). */
export function isValidImo(raw: string | number): boolean {
  const s = String(raw).replace(/^IMO\s*/i, '');
  if (!/^\d{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(s[i]) * (7 - i);
  return sum % 10 === Number(s[6]);
}

/** UN/LOCODE, e.g. ROCND, NGAPP. */
export function isValidUnlocode(s: string): boolean {
  return /^[A-Z]{2}[A-Z2-9]{3}$/.test(s);
}

/** European Number of Identification for inland vessels (ENI) — 8 digits. */
export function isValidEni(s: string): boolean {
  return /^\d{8}$/.test(s);
}

export function teuOf(isoType: string | null | undefined): number {
  if (!isoType) return 1;
  return isoType.startsWith('4') || isoType.startsWith('L') ? 2 : 1;
}
