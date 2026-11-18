// Minimal, dependency-free UN/EDIFACT syntax engine (ISO 9735): parse interchanges and build messages.
export interface Segment { tag: string; elements: string[][] }
export interface Interchange { sender?: string; receiver?: string; ref?: string; messages: { type: string; ref: string; segments: Segment[] }[] }

export function parse(raw: string): Interchange {
  let text = raw.replace(/\r?\n/g, '').trim();
  let comp = ':', elem = '+', rel = '?', term = "'";
  if (text.startsWith('UNA')) {
    comp = text[3]; elem = text[4]; rel = text[6]; term = text[8];
    text = text.slice(9);
  }
  const segs: Segment[] = [];
  const split = (s: string, sep: string) => {
    const out: string[] = []; let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === rel && i + 1 < s.length) { cur += s[++i]; continue; }
      if (s[i] === sep) { out.push(cur); cur = ''; continue; }
      cur += s[i];
    }
    out.push(cur);
    return out;
  };
  // split segments respecting release character
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === rel && i + 1 < text.length) { cur += text[i] + text[i + 1]; i++; continue; }
    if (text[i] === term) { if (cur.trim()) segs.push(toSeg(cur.trim())); cur = ''; continue; }
    cur += text[i];
  }
  if (cur.trim()) segs.push(toSeg(cur.trim()));
  function toSeg(s: string): Segment {
    // keep release chars for component-level split
    const parts: string[] = []; let p = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === rel && i + 1 < s.length) { p += s[i] + s[i + 1]; i++; continue; }
      if (s[i] === elem) { parts.push(p); p = ''; continue; }
      p += s[i];
    }
    parts.push(p);
    return { tag: parts[0], elements: parts.slice(1).map((e) => split(e, comp)) };
  }
  const ic: Interchange = { messages: [] };
  let msg: Interchange['messages'][number] | null = null;
  for (const s of segs) {
    if (s.tag === 'UNB') { ic.sender = s.elements[1]?.[0]; ic.receiver = s.elements[2]?.[0]; ic.ref = s.elements[4]?.[0]; continue; }
    if (s.tag === 'UNH') { msg = { type: s.elements[1]?.[0] ?? '', ref: s.elements[0]?.[0] ?? '', segments: [] }; ic.messages.push(msg); continue; }
    if (s.tag === 'UNT') { msg = null; continue; }
    if (s.tag === 'UNZ' || s.tag === 'UNG' || s.tag === 'UNE') continue;
    msg?.segments.push(s);
  }
  if (!ic.messages.length) throw new Error('No UNH message found in interchange');
  return ic;
}

const esc = (v: string) => v.replace(/([?:+'])/g, '?$1');

/** Build an interchange. segments: [['BGM', ['85'], ['REF'], ['9']], ...] where each element is a component array or string. */
export function build(opts: { sender: string; receiver: string; ref: string; type: string; version?: string; segments: (string | string[])[][] }) {
  const now = new Date();
  const d = now.toISOString().slice(2, 10).replace(/-/g, ''), t = now.toISOString().slice(11, 16).replace(':', '');
  const seg = (tag: string, ...els: (string | string[])[]) => tag + els.map((e) => '+' + (Array.isArray(e) ? e.map((x) => esc(x ?? '')).join(':') : esc(e ?? ''))).join('').replace(/\+*$/, '') + "'";
  const body = opts.segments.map(([tag, ...els]) => seg(tag as unknown as string, ...els));
  const [ver, rel] = (opts.version ?? 'D:95B').split(':');
  const lines = [
    "UNA:+.? '",
    seg('UNB', ['UNOC', '3'], [opts.sender], [opts.receiver], [d, t], [opts.ref]),
    seg('UNH', ['1'], [opts.type, ver, rel, 'UN']),
    ...body,
    seg('UNT', String(body.length + 2), '1'),
    seg('UNZ', '1', opts.ref),
  ];
  return lines.join('\n');
}

export const el = (s: Segment, i: number, j = 0) => s.elements[i]?.[j] ?? '';
export function ediDate(v: string): Date | null {
  if (/^\d{12}$/.test(v)) return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:00Z`);
  if (/^\d{8}$/.test(v)) return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  return null;
}
export const toEdiDate = (d: Date) => d.toISOString().slice(0, 16).replace(/[-T:]/g, '');
