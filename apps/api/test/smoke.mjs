// Post-deployment smoke test: node apps/api/test/smoke.mjs   (BASE_URL, DEMO_PASSWORD)
const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const PW = process.env.DEMO_PASSWORD ?? 'PcsDemo!2026';
let failed = 0;
const check = async (name, fn) => {
  const t = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t} ms)`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
};
const get = async (path, token) => {
  const r = await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const login = async (email) => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error(`login ${email} → HTTP ${r.status}`);
  return (await r.json()).token;
};

await check('health', async () => { const h = await get('/health'); if (h.status !== 'ok') throw new Error(JSON.stringify(h)); });
await check('portal served', async () => { const html = await get('/'); if (!html.includes('<div id="root">')) throw new Error('index.html missing'); });
await check('OpenAPI docs', async () => { await get('/api/docs/json'); });
await check('public ports', async () => { const p = await get('/api/public/ports'); if (!p.length) throw new Error('no ports'); });
await check('WTO 7.6 release time (public)', async () => { await get('/api/public/ZZALP/release-time'); });
for (const email of ['agent@zzalp.demo', 'harbour@zzalp.demo', 'customs@zzbet.demo']) {
  await check(`login + data as ${email}`, async () => {
    const tok = await login(email);
    const calls = await get('/api/vessel-calls', tok);
    if (!Array.isArray(calls) || !calls.length) throw new Error('no vessel calls');
    await get('/api/analytics/kpis', tok);
    await get('/api/notifications', tok);
  });
}
await check('tenant isolation', async () => {
  const tok = await login('agent@zzbet.demo');
  const calls = await get('/api/vessel-calls', tok);
  if (calls.some((c) => !c.call_no.startsWith('ZZBET'))) throw new Error('foreign port data visible');
});
await check('inland facilities (dry port, depot, CFS)', async () => {
  const tok = await login('portadmin@zzalp.demo');
  const f = await get('/api/facilities', tok);
  for (const t of ['DRY_PORT', 'EMPTY_DEPOT', 'CFS']) if (!f.some((x) => x.type === t)) throw new Error(`no ${t}`);
  await get('/api/inland-transfers', tok);
  await get(`/api/facilities/${f[0].id}`, tok);
});
if (failed) { console.error(`${failed} smoke check(s) failed`); process.exit(1); }
console.log('all smoke checks passed');
