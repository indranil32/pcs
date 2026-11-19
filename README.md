# PCS — Port Community System

A generic, multi-tenant Port Community System product. Each **port is a tenant**; one deployment can serve
several ports with full data isolation. The product is configured per port (clearance agencies, required FAL forms,
tariffs, currency, VAT, languages, truck slot capacity, barge/rail operations) rather than customised in code.

> Status: **v0.1, working end to end.** Every flow below runs against a real PostgreSQL database and is covered by
> integration tests. External systems (customs, payment gateway, AIS/VTMS, ERP) sit behind adapters that run in
> mock or simulated mode until real endpoints are available.

## What works today

| Area (PRD module) | Capabilities |
|---|---|
| **Platform** (FR-PLT, FR-ORG) | Port-per-tenant with PostgreSQL row-level security · 19 roles · JWT sign-in and `x-api-key` for systems · organisation self-registration with port-admin approval · notifications · audit trail on every change · documents with SHA-256 · stakeholder messages · multilingual portal (language packs per port) |
| **Vessel calls** (FR-VES) | Berthing request → berth allocation (LOA, under-keel clearance and window-clash checks, audited override) → pre-arrival notification → arrival → all fast → departure · berth plan Gantt · cancellation |
| **Single Window** (FR-SWN) | IMO FAL 1–7 forms with validation (FAL 4 excluded by default, per IPCSA/GDPR) · each agency approves, rejects or queries independently, with the agency list configured per port · port entry permit issued automatically when all agencies approve, printable with a QR code anyone can verify · departure clearance |
| **Cargo & customs** (FR-CGO, FR-CUS, FR-CON) | Manifests (portal, REST or EDI CUSCAR) with ISO 6346 / HS / UN/LOCODE validation and amendment versioning · B/L-level customs status exchange (declared → inspection → released / held) · automatic customs holds · container tracking and dwell time |
| **eDO & gate** (FR-GAT) | Electronic delivery order (forwarder requests, shipping line issues with a PIN) · slot-based truck appointment system with capacity per terminal · gate console checking the appointment, eDO, customs release and holds in one step · every gate attempt logged |
| **Hinterland** (FR-TRS) | Inland barge calls (ENI) · rail visits with wagon lists · live picture fed by a VTS over `POST /api/ais/positions` |
| **Dry ports / ICD** (FR-ICD) | Inland facilities register (bonded flag, distance, capacity, free days, transit time) · **bonded transfers** port ↔ dry port by truck, rail or barge: uncleared cargo may only move to a bonded facility; customs approves the transit in the Single Window queue, a transit document with a deadline is issued, the terminal or carrier dispatches, the facility confirms arrival, and overdue or late transits are flagged to customs · customs clearance and eDO delivery at the dry port gate (DO / PIN, customs release, holds checked) · export transfers back to the port terminal |
| **Empty depots** (FR-DEP) | Empty returns with an equipment interchange receipt (EIR) and condition survey (IICL-style damage codes) · M&R repair estimates priced at the port's labour rate, approved or rejected by the owning line, then completed · empty release orders per booking and ISO type, with automatic allocation of a sound empty at the gate · stock by line, type and condition |
| **CFS** (FR-CFS) | LCL destuffing into house-B/L lots with tally (shortages, damage, shed location) · per-lot declaration, customs release, hold or inspection · partial deliveries with EIR · export cargo pre-advice and receipt · stuffing of customs-released lots into an empty with a seal, then export transfer to the port · storage and handling billed through the tariff book (per container, container-day beyond free days, m³, TEU) |
| **Marine services** (FR-MKT, FR-VAS) | Provider catalogue · requests linked to the vessel call · accept, schedule and complete · auto-billing |
| **Finance** (FR-FIN) | Tariff book (per call / GT / LOA-day / TEU / tonne / unit, with minimums and conditions) · invoices rated automatically at each billable event · VAT per port · payment (mock gateway) · ERP journal export |
| **Integration** (FR-INT) | UN/EDIFACT engine: inbound CUSCAR, CODECO, COARRI, BERMAN, CUSRES; outbound APERAK and CUSCAR · webhooks signed with HMAC · transactional outbox (Kafka-ready) · OpenAPI 3 at `/api/docs` |
| **Analytics & GIS** (FR-AI, FR-GIS) | 20 operational KPIs · trends · berth occupancy · clearance time by agency · **public WTO TFA Art. 7.6 average release time** · live port map (AIS simulated in demo) |

## System boundaries

These boundaries follow IPCSA guidance on PCS scope:

- **TOS**: yard planning and equipment stay in the terminal operating system. PCS receives movements (CODECO, COARRI, API) and sends appointments and releases.
- **Customs Management System**: PCS does not assess declarations. It links the declaration number and carries the release or hold status, from customs users or from the customs system via API / CUSRES.

## Architecture

```
apps/api      Fastify (TypeScript) modular monolith — one plugin per PRD bounded context
  migrations/   SQL migrations (tables + row-level security policies)
  src/core/     db (tenant-scoped transactions), auth/RBAC, audit, outbox, approval engine, EDIFACT
  src/modules/  auth · admin · common (approvals, docs) · vessel-calls · cargo · delivery (eDO, trucks, gate)
                operations (services, barge, rail) · finance · edi · analytics (KPIs, GIS)
  src/workers   outbox → webhooks, AIS simulator, no-show sweeper
apps/web      React 19 + Vite + Tailwind portal (role-aware navigation, EN/RO/UK)
packages/shared  roles, state machines, validators (ISO 6346, IMO, UN/LOCODE, ENI) shared by API and portal
infra/        Azure Bicep (Container Apps + PostgreSQL Flexible Server) and GitHub OIDC bootstrap
```

**Tenant isolation.** The API connects as `pcs_app`, a non-owner role that is subject to RLS. Every request runs in a
transaction with `app.tenant_id` set, and every operational table has a `tenant_isolation` policy. Even a query
missing its `WHERE tenant_id` cannot leak another port's data.

**Why TypeScript end to end**: one language across API, portal,
EDI tooling and the shared domain model lets one team move faster on 27 modules. The module boundaries map one-to-one
to the PRD, so splitting into services later (e.g. EDI gateway, gate) is mechanical. The outbox already records every
domain event for a Kafka producer.

## Run locally

```bash
docker compose up --build          # → http://localhost:4000  (API docs at /api/docs)
```

Or without Docker (Node 22 and PostgreSQL 16):

```bash
npm ci
export ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pcs
export DATABASE_URL=postgres://pcs_app:pcs_app@localhost:5432/pcs
npm run db:migrate && npm run db:seed
npm run dev:api     # :4000
npm run dev:web     # :5173 (proxies /api)
npm test            # integration tests against a real database
```

### Demo data

Two **fictional** ports are seeded: **Demo Port Alpha (ZZALP)**, with EUR, three language packs, border police,
barges and rail, and **Demo Port Beta (ZZBET)**, with USD, immigration and maritime administration. All names,
vessels, B/Ls and containers are synthetic; UN/LOCODEs use the ISO user-assigned country code `ZZ`, and map
coordinates sit in open ocean near 0°/0°. Accounts follow `<role>@zzalp.demo` / `<role>@zzbet.demo`. Roles: agent,
harbour, customs, border, health, immigration, maritime, line, forwarder, haulier, terminal, barge, rail, services,
finance, portadmin, exec, and the inland facility operators icd (dry port), depot (empty depot) and cfs. The platform admin is `admin@pcs.demo`. The password is `DEMO_PASSWORD` (default
`PcsDemo!2026` locally; generated on Azure).

Suggested demo path (about 15 min): agent creates a call, submits the berthing request → harbour master allocates
a berth (try an undersized berth to see the checks) → agent fills in the FAL forms and submits pre-arrival → each
agency approves in the clearance queue → the permit appears with its QR code → agent submits the manifest →
forwarder links a declaration → customs releases → forwarder requests the eDO, the line issues it → haulier books a
slot → terminal processes gate in and out → departure → invoice → pay.

Inland path (about 10 min): forwarder requests a bonded transfer of an uncleared B/L to the dry port → customs approves
it in the clearance queue (transit document issued) → terminal dispatches → `icd` confirms arrival → customs releases
→ eDO → `icd` delivers at its gate. At the depot, `depot` receives an empty with a damage survey and sends a repair
estimate that the `line` approves; the line issues an empty release that the depot fulfils. At the CFS, `cfs` destuffs
an LCL box into house B/Ls, customs releases a lot, and the CFS delivers it in part.

## Deploy to Azure (GitHub Actions)

The pipeline (`.github/workflows/ci-cd.yml`): typecheck and integration
tests → security scans (npm audit, gitleaks, Trivy, Bicep build) → image build, scan and boot smoke test → push to
GHCR → **Bicep deployment** (infrastructure and new image in one step) → health wait → smoke tests against Azure →
automatic rollback on failure.

PCS can share an existing resource group's **Container Apps environment** and **PostgreSQL server**
(`SHARED_RESOURCE_GROUP`). It gets its own `pcs` database with roles `pcs_owner` (migrations) and `pcs_app`
(runtime, row-level security), so the other app's data is not touched and PCS never stores that server's admin
password. The deploy job creates the database and roles idempotently, using the admin connection read from the app
that owns the server and a temporary firewall rule for the runner. No GitHub secrets are needed: PCS passwords are
generated on the first deploy and kept only in the PCS container app's secrets.

One-time setup:

1. In Azure Cloud Shell, run `bash infra/github-oidc-setup.sh <shared-resource-group>`. It creates `rg-pcs-dev`
   and a federated identity with Contributor on both resource groups, then prints five variables.
2. In GitHub, go to **Settings → Environments → `azure-dev` → Variables** and add `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `SHARED_RESOURCE_GROUP`.
3. GitHub may send an **ID-based OIDC subject** (`repo:<owner>@<ownerId>/<repo>@<repoId>:environment:azure-dev`).
   If Azure login fails with AADSTS700213, add a federated credential with the subject shown in the error.
4. Make the GHCR package public (or switch to a private registry), then re-run the workflow.

Until the variables exist, the deploy job skips with a warning, so CI still passes. `infra/prod.bicepparam` holds
production settings (General Purpose PostgreSQL, no demo seed, no AIS simulator).

## Live demo (Azure, dev)

https://ca-pcsdev-tzfhzwahj7vd6.redplant-0c2283f6.centralindia.azurecontainerapps.io (synthetic data). Demo users
`<role>@zzalp.demo` / `<role>@zzbet.demo`; read the password with
`az containerapp secret show -g rg-pcs-dev -n ca-pcsdev-tzfhzwahj7vd6 --secret-name demo-password --query value -o tsv`.

## Roadmap to production

- Real adapters: national customs systems, payment gateways, AIS/VTMS feed, ERP posting, qualified electronic signatures
- Entra ID / SAML SSO for authority users
- Mobile app (FR-MOB), AI features (ETA prediction, OCR, port copilot on on-prem Ollama), compliance tracker
- Kafka producer on the outbox; VNet-integrated PostgreSQL with a private endpoint; blob storage for large documents
- Requirement-ID traceability against the PRD (module codes are already in the source headers)
