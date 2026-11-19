// Integration tests against a real PostgreSQL (seeded). Run: npm test (DATABASE_URL / ADMIN_DATABASE_URL set).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isValidContainerNo, isValidImo, containerCheckDigit } from '@pcs/shared';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { parse, build } from '../src/core/edifact.js';
import { cntr } from '../src/db/seed-data.js';

process.env.LOGIN_RATE_LIMIT = '10000';
const PW = process.env.DEMO_PASSWORD || 'PcsDemo!2026';
let app: any;
const tokens: Record<string, string> = {};

async function as(email: string, method: string, url: string, payload?: unknown) {
  if (!tokens[email]) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    assert.equal(r.statusCode, 200, `login ${email}: ${r.body}`);
    tokens[email] = r.json().token;
  }
  const r = await app.inject({ method, url: `/api${url}`, payload, headers: { authorization: `Bearer ${tokens[email]}` } });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
}

before(async () => {
  await migrate(() => {});
  await seed({ log: () => {} });
  const { buildApp } = await import('../src/server.js');
  app = await buildApp({ logger: false });
});
after(async () => { await app?.close(); const { pool } = await import('../src/core/db.js'); await pool.end(); });

test('reference validators', () => {
  assert.ok(isValidContainerNo('CSQU3054383'));
  assert.ok(!isValidContainerNo('CSQU3054384'));
  assert.equal(containerCheckDigit('CSQU305438'), 3);
  assert.ok(isValidImo('9074729'));
  assert.ok(!isValidImo('9074728'));
});

test('EDIFACT round trip with release characters', () => {
  const raw = build({ sender: 'A', receiver: 'B', ref: 'R1', type: 'CUSCAR', segments: [['FTX', ['AAA'], [''], [''], ["it's 5+3?"]]] });
  const ic = parse(raw);
  assert.equal(ic.messages[0].type, 'CUSCAR');
  assert.equal(ic.messages[0].segments[0].elements[3][0], "it's 5+3?");
});

test('health and authentication', async () => {
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/vessel-calls' })).statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'agent@zzalp.demo', password: 'wrong' } });
  assert.equal(bad.statusCode, 401);
});

test('tenant isolation: a user of one port never sees another port data', async () => {
  const ng = await as('agent@zzbet.demo', 'GET', '/vessel-calls');
  assert.ok(ng.body.length > 0);
  assert.ok(ng.body.every((c: any) => c.call_no.startsWith('ZZBET')));
  const ro = await as('agent@zzalp.demo', 'GET', '/vessel-calls');
  const r = await as('agent@zzbet.demo', 'GET', `/vessel-calls/${ro.body[0].id}`);
  assert.equal(r.status, 404);
});

test('role enforcement: an agent cannot allocate berths or decide clearances', async () => {
  const calls = await as('agent@zzalp.demo', 'GET', '/vessel-calls?status=BERTH_REQUESTED');
  const berths = await as('harbour@zzalp.demo', 'GET', '/ref/berths');
  const r = await as('agent@zzalp.demo', 'POST', `/vessel-calls/${calls.body[0].id}/allocate-berth`, { berthId: berths.body[0].id });
  assert.equal(r.status, 403);
  const pending = await as('border@zzalp.demo', 'GET', '/approvals?status=PENDING');
  assert.ok(pending.body.length > 0, 'border police has pending clearances');
  const wrong = await as('health@zzalp.demo', 'POST', `/approvals/${pending.body.find((a: any) => a.agency === 'BORDER_POLICE').id}/decision`, { status: 'APPROVED' });
  assert.equal(wrong.status, 403);
});

test('berth allocation checks physical fit and window clashes', async () => {
  const calls = await as('harbour@zzalp.demo', 'GET', '/vessel-calls?status=BERTH_REQUESTED');
  const call = calls.body[0];
  const berths = (await as('harbour@zzalp.demo', 'GET', '/ref/berths')).body;
  const small = berths.find((b: any) => b.barge_berth);
  const chk = await as('harbour@zzalp.demo', 'POST', `/vessel-calls/${call.id}/berth-check`, { berthId: small.id });
  assert.equal(chk.body.ok, false);
  assert.ok(chk.body.problems.some((p: string) => p.includes('LOA')));
  const blocked = await as('harbour@zzalp.demo', 'POST', `/vessel-calls/${call.id}/allocate-berth`, { berthId: small.id });
  assert.equal(blocked.status, 409);
});

test('full arrival clearance issues a port entry permit once every agency approves', async () => {
  const pending = (await as('portadmin@zzalp.demo', 'GET', '/vessel-calls?status=PRE_ARRIVAL_SUBMITTED')).body[0];
  const aps = (await as('portadmin@zzalp.demo', 'GET', `/approvals?entityId=${pending.id}`)).body.filter((a: any) => a.status === 'PENDING');
  const login: Record<string, string> = { BORDER_POLICE: 'border', PORT_HEALTH: 'health', CUSTOMS: 'customs', HARBOUR_MASTER: 'harbour' };
  for (const ap of aps) {
    const r = await as(`${login[ap.agency]}@zzalp.demo`, 'POST', `/approvals/${ap.id}/decision`, { status: 'APPROVED' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const after = (await as('agent@zzalp.demo', 'GET', `/vessel-calls/${pending.id}`)).body;
  assert.equal(after.status, 'ARRIVAL_CLEARED');
  assert.match(after.entry_permit_no, /^ZZALP-PEP-/);
  const permit = await as('agent@zzalp.demo', 'GET', `/vessel-calls/${pending.id}/permit`);
  assert.equal(permit.status, 200);
});

test('gate rejects a truck when customs has not released the cargo', async () => {
  const bls = (await as('forwarder@zzalp.demo', 'GET', '/bls?customsStatus=DECLARED')).body;
  const bl = bls[0];
  const d = await as('forwarder@zzalp.demo', 'POST', '/delivery-orders', { blId: bl.id });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  await as('line@zzalp.demo', 'POST', `/delivery-orders/${d.body.id}/issue`, { validUntil: new Date(Date.now() + 5 * 864e5), haulierOrgId: undefined });
  const full = (await as('forwarder@zzalp.demo', 'GET', `/bls/${bl.id}`)).body;
  const terminals = (await as('haulier@zzalp.demo', 'GET', '/ref/terminals')).body;
  const slot = new Date(); slot.setUTCMinutes(0, 0, 0);
  const ta = await as('haulier@zzalp.demo', 'POST', '/truck-appointments', { terminalId: terminals.find((t: any) => t.code === 'CT1').id, direction: 'IMPORT_PICKUP', containerNo: full.containers[0].container_no, doId: d.body.id, truckPlate: 'CT77TST', slotStart: slot });
  assert.equal(ta.status, 200, JSON.stringify(ta.body));
  const gate = await as('terminal@zzalp.demo', 'POST', '/gate/transactions', { terminalId: ta.body.terminal_id, direction: 'IN', truckPlate: 'CT77TST', token: ta.body.token });
  assert.equal(gate.body.result, 'REJECTED');
  assert.match(gate.body.reason, /Customs status is DECLARED/);
  // customs releases → truck now accepted
  await as('customs@zzalp.demo', 'POST', `/bls/${bl.id}/customs-status`, { status: 'RELEASED' });
  const again = await as('terminal@zzalp.demo', 'POST', '/gate/transactions', { terminalId: ta.body.terminal_id, direction: 'IN', truckPlate: 'CT77TST', token: ta.body.token });
  assert.equal(again.body.result, 'ACCEPTED', JSON.stringify(again.body));
});

test('EDI CUSCAR creates a manifest and invalid containers are rejected with APERAK', async () => {
  const call = (await as('agent@zzbet.demo', 'GET', '/vessel-calls?status=PRE_ARRIVAL_SUBMITTED')).body[0];
  const good = cntr('BETU', '555001');
  const seg = (k: string) => `UNA:+.? 'UNB+UNOC:3+AGENT+ZZBET+261118:1200+X1'UNH+1+CUSCAR:D:95B:UN'BGM+85+M1+9'RFF+ATZ:${call.call_no}'CNI+1+BL1'RFF+BM:BETBL0001'NAD+CN+++National Distribution (demo)'LOC+9+ZZEST'LOC+11+ZZBET'GID+1+40'FTX+AAA+++Rice in bags'EQD+CN+${k}+22G1+++5'UNT+11+1'UNZ+1+X1'`;
  const ok = await as('agent@zzbet.demo', 'POST', '/edi/inbound', { raw: seg(good) });
  assert.equal(ok.body.messages[0].status, 'PROCESSED', JSON.stringify(ok.body));
  assert.match(ok.body.messages[0].aperak, /BGM\+23\+1\+29/);
  const bad = await as('agent@zzbet.demo', 'POST', '/edi/inbound', { raw: seg('BETU5550010') });
  assert.equal(bad.body.messages[0].status, 'ERROR');
  assert.match(bad.body.messages[0].errors.join(' '), /ISO 6346/);
});

test('invoices are rated from the tariff book and can be paid', async () => {
  const inv = (await as('agent@zzalp.demo', 'GET', '/invoices?status=ISSUED')).body.find((i: any) => i.entity_type === 'vessel_call');
  assert.ok(inv, 'agent has an issued vessel-call invoice');
  const full = (await as('agent@zzalp.demo', 'GET', `/invoices/${inv.id}`)).body;
  assert.ok(full.lines.length >= 3);
  assert.equal(Math.round((full.subtotal + full.tax) * 100), Math.round(full.total * 100));
  const pay = await as('agent@zzalp.demo', 'POST', `/invoices/${inv.id}/pay`, { method: 'CARD' });
  assert.equal(pay.status, 200);
  assert.equal((await as('agent@zzalp.demo', 'GET', `/invoices/${inv.id}`)).body.status, 'PAID');
});

test('organisation self-registration needs port admin approval before sign-in', async () => {
  const ports = (await app.inject({ url: '/api/public/ports' })).json();
  const ro = ports.find((p: any) => p.code === 'ZZALP');
  const email = `newagent${Date.now()}@example.com`;
  const r = await app.inject({ method: 'POST', url: '/api/public/register', payload: { tenantId: ro.id, organisation: { name: `Test Agency ${Date.now()}`, type: 'SHIPPING_AGENT', registrationNo: 'J13/1/2026', email }, user: { name: 'Tester', email, password: 'Password123!' } } });
  assert.equal(r.statusCode, 200, r.body);
  const denied = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Password123!' } });
  assert.equal(denied.statusCode, 403);
  await as('portadmin@zzalp.demo', 'POST', `/organisations/${r.json().id}/status`, { status: 'ACTIVE' });
  const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Password123!' } });
  assert.equal(ok.statusCode, 200);
});
