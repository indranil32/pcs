// Demo seed: reference data via SQL, then live scenarios driven through the real API (so seeding exercises every flow).
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { withTenant, one, insert } from '../core/db.js';
import { PORTS, VESSELS, LOCATIONS, cntr } from './seed-data.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'PcsDemo!2026';
const H = 36e5, D = 864e5;

const ROLE_LOGIN: Record<string, string> = {
  PORT_ADMIN: 'portadmin', HARBOUR_MASTER: 'harbour', FINANCE: 'finance', EXECUTIVE: 'exec', CUSTOMS: 'customs', BORDER_POLICE: 'border',
  PORT_HEALTH: 'health', IMMIGRATION: 'immigration', MARITIME_SAFETY: 'maritime', SHIPPING_AGENT: 'agent', SHIPPING_LINE: 'line',
  FREIGHT_FORWARDER: 'forwarder', HAULIER: 'haulier', BARGE_OPERATOR: 'barge', RAIL_OPERATOR: 'rail', TERMINAL_OPERATOR: 'terminal', SERVICE_PROVIDER: 'services',
};

export async function seed(opts: { force?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const existing = await withTenant('*', (c) => one(c, 'SELECT count(*)::int AS n FROM tenants'));
  if (existing!.n > 0 && !opts.force) { log('seed: data present, skipping'); return; }
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const ids: any = {};

  await withTenant('*', async (c) => {
    for (const [code, name, country] of LOCATIONS) await c.query('INSERT INTO locations VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, name, country]);
    for (const v of VESSELS) await c.query(`INSERT INTO vessels (imo,name,type,flag,gt,dwt,loa,beam,max_draft,call_sign,mmsi) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (imo) DO NOTHING`,
      [v.imo, v.name, v.type, v.flag, v.gt, v.dwt, v.loa, v.beam, v.max_draft, v.call_sign, v.mmsi]);
    await c.query(`INSERT INTO users (email,name,password_hash,roles) VALUES ('admin@pcs.demo','Platform Administrator',$1,'{SYS_ADMIN}') ON CONFLICT DO NOTHING`, [hash]);

    for (const p of PORTS) {
      const t = await insert(c, 'tenants', { code: p.code, name: p.name, country: p.country, timezone: p.timezone, currency: p.currency, lat: p.lat, lon: p.lon, settings: JSON.stringify(p.settings) });
      const pid: any = (ids[p.code] = { tenant: t.id, orgs: {} as Record<string, string>, terminals: {} as Record<string, string>, berths: {} as Record<string, string> });
      const dom = `${p.code.toLowerCase()}.demo`;
      const addUser = (orgId: string, roles: string[], login: string, name: string) =>
        c.query('INSERT INTO users (tenant_id, org_id, email, name, password_hash, roles, lang) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [t.id, orgId, `${login}@${dom}`, name, hash, roles, p.code === 'ROCND' && login !== 'agent' ? 'en' : 'en']);
      for (const [name, type, roles] of p.authorities) {
        const o = await insert(c, 'organisations', { tenant_id: t.id, name, type, email: `info@${dom}`, status: 'ACTIVE', registration_no: 'GOV' });
        for (const r of roles) { await addUser(o.id, [r], ROLE_LOGIN[r], `${r.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase())} (${p.code})`); pid.orgs[r] = o.id; }
      }
      let ti = 0;
      for (const tm of p.terminals) {
        let op = await one(c, 'SELECT id FROM organisations WHERE tenant_id=$1 AND name=$2', [t.id, tm.operator]);
        if (!op) {
          op = await insert(c, 'organisations', { tenant_id: t.id, name: tm.operator, type: 'TERMINAL_OPERATOR', email: `ops@${dom}`, status: 'ACTIVE', registration_no: `TO-${tm.code}` });
          await addUser(op.id, ['TERMINAL_OPERATOR'], ti === 0 ? 'terminal' : `terminal${ti + 1}`, `${tm.operator} Gate Supervisor`);
          ti++;
        }
        const row = await insert(c, 'terminals', { tenant_id: t.id, code: tm.code, name: tm.name, type: tm.type, operator_org_id: op.id, lat: tm.lat, lon: tm.lon });
        pid.terminals[tm.code] = row.id;
        if (!pid.orgs.TERMINAL_OPERATOR) pid.orgs.TERMINAL_OPERATOR = op.id;
      }
      for (const [code, name, term, len, depth, lat, lon, barge] of p.berths as any) {
        const b = await insert(c, 'berths', { tenant_id: t.id, terminal_id: pid.terminals[term], code, name, length_m: len, depth_m: depth, lat, lon, barge_berth: !!barge });
        pid.berths[code] = b.id;
      }
      let sp = 0;
      for (const [name, type] of p.commercial) {
        const o = await insert(c, 'organisations', { tenant_id: t.id, name, type, email: `contact@${dom}`, status: 'ACTIVE', registration_no: `REG-${Math.floor(Math.random() * 1e6)}`, tax_id: `${p.country}${Math.floor(Math.random() * 1e8)}` });
        const role = type as string;
        const login = role === 'SERVICE_PROVIDER' ? (sp++ === 0 ? 'services' : 'bunkers') : ROLE_LOGIN[role];
        await addUser(o.id, [role], login, `${name.replace(' (demo)', '')} User`);
        pid.orgs[login === 'bunkers' ? 'BUNKERS' : role] = o.id;
      }
      for (const [code, name, applies, basis, rate, min] of p.tariffs) await insert(c, 'tariffs', { tenant_id: t.id, code, name, applies_to: applies, basis, rate, min_amount: min, currency: p.currency });
      const cur = p.currency, k = p.code === 'NGAPP' ? 180 : 1;
      const offers: [string, string, string, number][] = [
        [pid.orgs.SERVICE_PROVIDER, 'PILOTAGE', 'JOB', 1800 * k], [pid.orgs.SERVICE_PROVIDER, 'TOWAGE', 'TUG_HOUR', 1400 * k], [pid.orgs.SERVICE_PROVIDER, 'MOORING', 'JOB', 600 * k],
        [pid.orgs.BUNKERS, 'BUNKERING', 'TONNE', 3100 * k], [pid.orgs.BUNKERS, 'FRESH_WATER', 'TONNE', 25 * k], [pid.orgs.SERVICE_PROVIDER, 'WASTE_COLLECTION', 'M3', 220 * k],
      ];
      for (const [org, type, unit, price] of offers) await insert(c, 'service_offerings', { tenant_id: t.id, org_id: org, service_type: type, unit, unit_price: price, currency: cur, description: `${type.replace('_', ' ').toLowerCase()} — 24/7` });
    }
  });
  log('seed: reference data loaded');

  // ---------------- live scenarios through the API ----------------
  process.env.LOGIN_RATE_LIMIT ??= '10000';
  const { buildApp } = await import('../server.js');
  const app = await buildApp({ logger: false });
  const tokens = new Map<string, string>();
  const login = async (email: string) => {
    if (!tokens.has(email)) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
      if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.body}`);
      tokens.set(email, r.json().token);
    }
    return tokens.get(email)!;
  };

  for (const p of PORTS) {
    const dom = `${p.code.toLowerCase()}.demo`;
    const pid = ids[p.code];
    const call = async (who: string, method: string, url: string, payload?: unknown) => {
      const r = await app.inject({ method: method as any, url: `/api${url}`, payload: payload as any, headers: { authorization: `Bearer ${await login(`${who}@${dom}`)}` } });
      if (r.statusCode >= 400) throw new Error(`${who} ${method} ${url} → ${r.statusCode} ${r.body}`);
      return r.json();
    };
    const vessels = p.code === 'ROCND' ? VESSELS.slice(0, 4).concat(VESSELS[6]) : VESSELS.slice(3, 8);
    const berthsFor = Object.entries(pid.berths).filter(([code]) => !code.startsWith('B') || code.startsWith('B3') || code === 'B80').filter(([code]) => !code.startsWith('BG') && !code.startsWith('J')) as [string, string][];
    const vid = async (imo: string) => (await withTenant('*', (c) => one(c, 'SELECT id FROM vessels WHERE imo=$1', [imo])))!.id;
    const fal = async (id: string, v: any, dg: boolean) => {
      await call('agent', 'PUT', `/vessel-calls/${id}/fal/1`, { masterName: 'Capt. A. Demo', portOfArrival: p.code, lastPortOfCall: p.lastPorts[0], briefCargoDescription: 'Containers / general cargo', nationalityOfShip: v.flag, grossTonnage: v.gt });
      await call('agent', 'PUT', `/vessel-calls/${id}/fal/2`, { items: [{ blNo: 'SEE-MANIFEST', description: 'As per CUSCAR manifest', packages: 1 }] });
      await call('agent', 'PUT', `/vessel-calls/${id}/fal/3`, { stores: [{ article: 'Provisions', quantity: '2 t' }, { article: 'Lubricating oil', quantity: '8 m3' }] });
      await call('agent', 'PUT', `/vessel-calls/${id}/fal/5`, { crew: Array.from({ length: 18 }, (_, i) => ({ familyName: `Crew${i + 1}`, givenNames: 'Demo', rank: i === 0 ? 'Master' : i < 4 ? 'Officer' : 'Rating', nationality: ['PH', 'UA', 'RO', 'IN'][i % 4], idDocNo: `SB${100000 + i}` })) });
      if (dg) await call('agent', 'PUT', `/vessel-calls/${id}/fal/7`, { items: [{ unNumber: 'UN1203', properShippingName: 'GASOLINE', class: '3', quantity: '20 t', containerNo: cntr('EUXU', '700001') }] });
    };
    const clearAll = async (id: string, stage: string) => {
      const aps = await call('portadmin', 'GET', `/approvals?entityId=${id}`);
      for (const ap of aps.filter((x: any) => x.stage === stage && x.status === 'PENDING')) await call(ROLE_LOGIN[ap.agency], 'POST', `/approvals/${ap.id}/decision`, { status: 'APPROVED' });
    };
    const owner = p.code === 'ROCND' ? 'EUXU' : 'GGLU';
    let serial = 100000;
    const manifest = (nBl: number) => ({
      direction: 'IMPORT',
      bls: Array.from({ length: nBl }, (_, i) => ({
        blNo: `${owner}${p.code.slice(2)}${String(serial + i * 7).slice(-6)}`, shipper: ['Anatolia Textiles (demo)', 'Shanghai Machinery Co (demo)', 'Hamburg Chemicals (demo)'][i % 3],
        consignee: ['Danubius Retail SRL (demo)', 'Agro Import SA (demo)', 'Eko Distribution Ltd (demo)'][i % 3], forwarderOrgId: pid.orgs.FREIGHT_FORWARDER,
        pol: p.lastPorts[i % p.lastPorts.length], pod: p.code, description: ['Textiles', 'Machinery parts', 'Plastic granules', 'Frozen poultry', 'Ceramic tiles'][i % 5],
        hsCode: ['520812', '847990', '390110', '020714', '690721'][i % 5], packages: 100 + i * 13, grossKg: 18000 + i * 900,
        containers: Array.from({ length: 1 + (i % 3) }, () => ({ containerNo: cntr(owner, String(serial++)), isoType: serial % 2 ? '45G1' : '22G1', sealNo: `SL${serial}`, grossKg: 21000 })),
      })),
    });

    // Historical calls (departed) → KPIs, invoices, release-time history
    const history: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = vessels[i];
      const eta = new Date(Date.now() - (24 - i * 7) * D);
      const vc = await call('agent', 'POST', '/vessel-calls', { vesselId: await vid(v.imo), voyage_in: `H${i}W`, voyageIn: `${i + 41}W`, voyageOut: `${i + 41}E`, lastPort: p.lastPorts[i], nextPort: p.lastPorts[i + 1], eta, etd: new Date(eta.getTime() + 2 * D), arrivalDraft: v.max_draft - 1, lineOrgId: pid.orgs.SHIPPING_LINE, cargoSummary: 'Containers' });
      await call('agent', 'POST', `/vessel-calls/${vc.id}/berth-request`);
      await call('harbour', 'POST', `/vessel-calls/${vc.id}/allocate-berth`, { berthId: berthsFor[i % berthsFor.length][1], override: true });
      await fal(vc.id, v, false);
      await call('agent', 'POST', `/vessel-calls/${vc.id}/pre-arrival`);
      await clearAll(vc.id, 'ARRIVAL');
      await call('agent', 'POST', `/vessel-calls/${vc.id}/manifests`, manifest(4));
      await call('harbour', 'POST', `/vessel-calls/${vc.id}/arrived`, { at: new Date(eta.getTime() + (i + 1) * H) });
      await call('harbour', 'POST', `/vessel-calls/${vc.id}/berthed`, { at: new Date(eta.getTime() + (i + 4) * H) });
      await call('agent', 'POST', `/vessel-calls/${vc.id}/departure-request`);
      await clearAll(vc.id, 'DEPARTURE');
      await call('harbour', 'POST', `/vessel-calls/${vc.id}/departed`, { at: new Date(eta.getTime() + (40 + i * 6) * H) });
      history.push(vc.id);
    }
    // Backdate cargo and clearance history for realistic KPIs
    await withTenant(pid.tenant, async (c) => {
      await c.query(`UPDATE bills_of_lading b SET customs_status='RELEASED', declared_at = vc.ata - interval '20 hours' + (random()*interval '10 hours'),
          released_at = vc.ata + (random()*interval '30 hours') + interval '4 hours', declaration_no = 'DEC' || substr(md5(b.bl_no),1,8)
        FROM manifests m JOIN vessel_calls vc ON vc.id=m.call_id WHERE b.manifest_id=m.id AND vc.id = ANY($1)`, [history]);
      await c.query(`UPDATE containers k SET status='GATED_OUT', holds='{}', discharged_at = vc.berthed_at + (random()*interval '20 hours'),
          gated_out_at = vc.berthed_at + interval '1 day' + (random()*interval '5 days') FROM vessel_calls vc WHERE k.call_id=vc.id AND vc.id = ANY($1)`, [history]);
      await c.query(`UPDATE approvals a SET created_at = vc.eta - interval '30 hours', decided_at = vc.eta - interval '30 hours' + (random()*interval '9 hours')
        FROM vessel_calls vc WHERE a.entity_id=vc.id AND vc.id = ANY($1)`, [history]);
      await c.query(`UPDATE invoices i SET issued_at = vc.atd, due_at = vc.atd + interval '14 days' FROM vessel_calls vc WHERE i.entity_id=vc.id AND vc.id = ANY($1)`, [history]);
      // historical truck traffic
      await c.query(`INSERT INTO truck_appointments (tenant_id, appt_no, terminal_id, haulier_org_id, direction, container_no, truck_plate, slot_start, slot_end, token, status, gate_in_at, gate_out_at)
        SELECT $1, $2 || '-TA-H' || lpad(g::text, 4, '0'), $3, $4, 'IMPORT_PICKUP', k.container_no, $5 || (1000+g), k.gated_out_at - interval '1 hour', k.gated_out_at, upper(substr(md5(random()::text),1,8)),
               'GATED_OUT', k.gated_out_at - interval '40 minutes' - (random()*interval '30 minutes'), k.gated_out_at
        FROM (SELECT k.*, row_number() OVER () AS g FROM containers k WHERE k.call_id = ANY($6)) k`, [pid.tenant, p.code, pid.terminals[p.terminals[0].code], pid.orgs.HAULIER, p.code === 'ROCND' ? 'CT' : 'LAG', history]);
      await c.query(`INSERT INTO gate_events (tenant_id, terminal_id, appointment_id, truck_plate, container_no, direction, source, result, at)
        SELECT tenant_id, terminal_id, id, truck_plate, container_no, d, 'ANPR', 'ACCEPTED', CASE WHEN d='IN' THEN gate_in_at ELSE gate_out_at END FROM truck_appointments, unnest(ARRAY['IN','OUT']) d WHERE appt_no LIKE '%-TA-H%'`);
    });

    // Current call 1: berthed, manifest, partial customs releases, DO, today's truck flow
    const v1 = vessels[3];
    const eta1 = new Date(Date.now() - 20 * H);
    const c1 = await call('agent', 'POST', '/vessel-calls', { vesselId: await vid(v1.imo), voyageIn: '052W', voyageOut: '052E', lastPort: p.lastPorts[3], nextPort: p.lastPorts[4], eta: eta1, etd: new Date(eta1.getTime() + 3 * D), arrivalDraft: v1.max_draft - 0.8, lineOrgId: pid.orgs.SHIPPING_LINE, dangerousGoods: true, cargoSummary: '1,850 TEU discharge / 1,200 TEU load' });
    await call('agent', 'POST', `/vessel-calls/${c1.id}/berth-request`);
    await call('harbour', 'POST', `/vessel-calls/${c1.id}/allocate-berth`, { berthId: berthsFor[0][1], override: true });
    await fal(c1.id, v1, true);
    await call('agent', 'POST', `/vessel-calls/${c1.id}/pre-arrival`);
    await clearAll(c1.id, 'ARRIVAL');
    const m1 = await call('agent', 'POST', `/vessel-calls/${c1.id}/manifests`, manifest(6));
    await call('harbour', 'POST', `/vessel-calls/${c1.id}/arrived`, { at: new Date(eta1.getTime() + 1.5 * H) });
    await call('harbour', 'POST', `/vessel-calls/${c1.id}/berthed`, { at: new Date(eta1.getTime() + 4 * H) });
    const bls = await call('forwarder', 'GET', `/bls?callId=${c1.id}`);
    for (const [i, bl] of bls.entries()) {
      for (const k of (await call('forwarder', 'GET', `/bls/${bl.id}`)).containers) await call('terminal', 'POST', '/containers/events', { containerNo: k.container_no, event: 'DISCHARGED', at: new Date(eta1.getTime() + (5 + i) * H) });
      if (i < 4) await call('forwarder', 'POST', `/bls/${bl.id}/declaration`, { declarationNo: `${p.code === 'ROCND' ? 'RO' : 'NG'}DEC2026${String(4410 + i)}` });
      if (i < 2) await call('customs', 'POST', `/bls/${bl.id}/customs-status`, { status: 'RELEASED', remarks: 'Released — green channel' });
      if (i === 2) await call('customs', 'POST', `/bls/${bl.id}/customs-status`, { status: 'UNDER_INSPECTION', remarks: 'Selected for physical examination' });
    }
    const d1 = await call('forwarder', 'POST', '/delivery-orders', { blId: bls[0].id, haulierOrgId: pid.orgs.HAULIER });
    await call('line', 'POST', `/delivery-orders/${d1.id}/issue`, { validUntil: new Date(Date.now() + 7 * D) });
    await call('forwarder', 'POST', '/delivery-orders', { blId: bls[1].id, haulierOrgId: pid.orgs.HAULIER });
    const bl0 = await call('forwarder', 'GET', `/bls/${bls[0].id}`);
    const slot = new Date(); slot.setUTCMinutes(0, 0, 0);
    const ta = await call('haulier', 'POST', '/truck-appointments', { terminalId: pid.terminals[p.terminals[0].code], direction: 'IMPORT_PICKUP', containerNo: bl0.containers[0].container_no, doId: d1.id, truckPlate: p.code === 'ROCND' ? 'CT21PCS' : 'LAG482XA', driverName: 'Demo Driver', slotStart: slot });
    await call('terminal', 'POST', '/gate/transactions', { terminalId: pid.terminals[p.terminals[0].code], direction: 'IN', truckPlate: ta.truck_plate, token: ta.token, source: 'ANPR' });
    await call('terminal', 'POST', '/gate/transactions', { terminalId: pid.terminals[p.terminals[0].code], direction: 'OUT', truckPlate: ta.truck_plate, source: 'ANPR' });
    await call('terminal', 'POST', '/gate/transactions', { terminalId: pid.terminals[p.terminals[0].code], direction: 'IN', truckPlate: p.code === 'ROCND' ? 'B999XYZ' : 'KJA001ZZ', source: 'ANPR' }); // rejected: no appointment
    if (bl0.containers[1]) await call('haulier', 'POST', '/truck-appointments', { terminalId: pid.terminals[p.terminals[0].code], direction: 'IMPORT_PICKUP', containerNo: bl0.containers[1].container_no, doId: d1.id, truckPlate: p.code === 'ROCND' ? 'CT34PCS' : 'LAG913XB', driverName: 'Second Driver', slotStart: new Date(slot.getTime() + 2 * H) });
    const offers = await call('agent', 'GET', '/service-offerings');
    const pick = (t: string) => offers.find((o: any) => o.service_type === t);
    const s1 = await call('agent', 'POST', '/service-requests', { offeringId: pick('PILOTAGE').id, callId: c1.id, requestedFor: eta1 });
    await call('services', 'POST', `/service-requests/${s1.id}/accept`);
    await call('services', 'POST', `/service-requests/${s1.id}/complete`, { completedAt: new Date(eta1.getTime() + 3 * H) });
    await call('agent', 'POST', '/service-requests', { offeringId: pick('BUNKERING').id, callId: c1.id, quantity: 350, requestedFor: new Date(Date.now() + 10 * H) });

    // Current call 2: pre-arrival submitted, partly cleared
    const v2 = vessels[4];
    const eta2 = new Date(Date.now() + 30 * H);
    const c2 = await call('agent', 'POST', '/vessel-calls', { vesselId: await vid(v2.imo), voyageIn: '118N', voyageOut: '118S', lastPort: p.lastPorts[1], nextPort: p.lastPorts[2], eta: eta2, etd: new Date(eta2.getTime() + 2 * D), arrivalDraft: v2.max_draft - 1, lineOrgId: pid.orgs.SHIPPING_LINE, cargoSummary: 'Mixed cargo' });
    await call('agent', 'POST', `/vessel-calls/${c2.id}/berth-request`);
    await call('harbour', 'POST', `/vessel-calls/${c2.id}/allocate-berth`, { berthId: berthsFor[2][1], override: true });
    await fal(c2.id, v2, false);
    await call('agent', 'POST', `/vessel-calls/${c2.id}/pre-arrival`);
    const aps = (await call('portadmin', 'GET', `/approvals?entityId=${c2.id}`)).filter((x: any) => x.agency === 'CUSTOMS' || x.agency === 'HARBOUR_MASTER');
    for (const ap of aps) await call(ROLE_LOGIN[ap.agency], 'POST', `/approvals/${ap.id}/decision`, { status: 'APPROVED' });
    await call('agent', 'POST', '/service-requests', { offeringId: pick('TOWAGE').id, callId: c2.id, quantity: 2, requestedFor: eta2 });

    // Current call 3: berthing request waiting for the harbour master; call 4: draft
    const v3 = vessels[2];
    const eta3 = new Date(Date.now() + 3 * D);
    await call('agent', 'POST', '/vessel-calls', { vesselId: await vid(v3.imo), voyageIn: '007', voyageOut: '007', lastPort: p.lastPorts[2], nextPort: p.lastPorts[0], eta: eta3, etd: new Date(eta3.getTime() + 3 * D), arrivalDraft: v3.max_draft - 2, requestedBerthId: berthsFor[berthsFor.length - 1][1], cargoSummary: 'Bulk' })
      .then((r) => call('agent', 'POST', `/vessel-calls/${r.id}/berth-request`));
    const v4 = vessels[1];
    await call('agent', 'POST', '/vessel-calls', { vesselId: await vid(v4.imo), voyageIn: '221W', voyageOut: '221E', lastPort: p.lastPorts[4], eta: new Date(Date.now() + 6 * D), etd: new Date(Date.now() + 7.5 * D), cargoSummary: 'Containers' });

    // Barges and rail
    const bargeBerth = Object.entries(pid.berths).find(([code]) => code.startsWith('BG') || code.startsWith('J'))![1];
    const b1 = await call('barge', 'POST', '/barge-calls', { bargeName: p.code === 'ROCND' ? 'DUNAREA 7' : 'LAGOON 3', eni: p.code === 'ROCND' ? '45001234' : '61004321', convoyRef: 'CV-12', origin: p.code === 'ROCND' ? 'RSBEG' : 'NGLOS', destination: p.code, terminalId: pid.terminals.BARGE, berthId: bargeBerth, eta: new Date(Date.now() - 30 * H), tonnage: 1650, cargoDescription: 'Grain (wheat)' });
    for (const a of ['notify', 'arrive', 'start']) await call(a === 'notify' ? 'barge' : 'harbour', 'POST', `/barge-calls/${b1.id}/${a}`, a === 'arrive' ? { at: new Date(Date.now() - 26 * H) } : {});
    await call('harbour', 'POST', `/barge-calls/${b1.id}/depart`, { at: new Date(Date.now() - 6 * H) });
    const b2 = await call('barge', 'POST', '/barge-calls', { bargeName: p.code === 'ROCND' ? 'GALATI 12' : 'LAGOON 5', eni: p.code === 'ROCND' ? '45009876' : '61009876', origin: p.code === 'ROCND' ? 'ROGLU' : 'NGLOS', destination: p.code, terminalId: pid.terminals.BARGE, eta: new Date(Date.now() + 14 * H), tonnage: 1200, cargoDescription: 'Steel coils' });
    await call('barge', 'POST', `/barge-calls/${b2.id}/notify`);
    const r1 = await call('rail', 'POST', '/rail-visits', { trainNo: p.code === 'ROCND' ? 'CFR-80451' : 'NRC-2207', direction: 'OUTBOUND', terminalId: pid.terminals[p.terminals[0].code], origin: p.code, destination: p.code === 'ROCND' ? 'HUBUD' : 'NGKAN', eta: new Date(Date.now() + 8 * H), wagons: [{ wagonNo: '31 53 4560 001-2', containers: [], cargo: 'Containers', tonnes: 52 }, { wagonNo: '31 53 4560 002-0', containers: [], cargo: 'Containers', tonnes: 48 }] });
    await call('rail', 'POST', `/rail-visits/${r1.id}/announce`);

    // EDI: a terminal CODECO (gate-out) to populate the EDI monitor and APERAK flow
    const codeco = `UNA:+.? 'UNB+UNOC:3+${p.terminals[0].code}+${p.code}+${new Date().toISOString().slice(2, 10).replace(/-/g, '')}:1200+DEMO0001'UNH+1+CODECO:D:95B:UN'BGM+34+GI001+9'DTM+7:${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '')}:203'EQD+CN+${bl0.containers[0].container_no}+45G1:102:5++3+5'UNT+5+1'UNZ+1+DEMO0001'`;
    await call('terminal', 'POST', '/edi/inbound', { raw: codeco });
    void m1;
    log(`seed: ${p.code} scenarios complete`);
  }
  await app.close();
  log(process.env.DEMO_PASSWORD ? "seed: done — demo users use the DEMO_PASSWORD secret" : `seed: done — demo password "${DEMO_PASSWORD}"`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  seed({ force: process.argv.includes('--force') }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
