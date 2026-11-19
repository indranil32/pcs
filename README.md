# Maqta PCS — Port Community System

Multi-tenant Port Community System by **Maqta Technologies (TradeTech) · AD Ports Group**, built from the generic
PCS PRD v2.1, the Romania (Port of Constanța) requirements matrix and the Nigeria (NPA / Lagos-Apapa) proposal.
Each **port is a tenant**; one deployment can serve several ports with full data isolation.

> Status: **v0.1, working end to end.** Every flow below runs against a real PostgreSQL database and is covered by
> integration tests. External systems (customs, payment gateway, AIS/VTMS, ERP) sit behind adapters that run in
> mock or simulated mode until real endpoints are available.

## What works today

| Area (PRD module) | Capabilities |
|---|---|
| **Platform** (FR-PLT, FR-ORG) | Port-per-tenant with PostgreSQL row-level security · 18 roles · JWT sign-in and `x-api-key` for systems · organisation self-registration with port-admin approval · notifications · audit trail on every change · documents with SHA-256 · stakeholder messages · EN / RO / UK portal |
| **Vessel calls** (FR-VES) | Berthing request → berth allocation (LOA, under-keel clearance and window-clash checks, audited override) → pre-arrival notification → arrival → all fast → departure · berth plan Gantt · cancellation |
| **Single Window** (FR-SWN) | IMO FAL 1–7 forms with validation (FAL 4 excluded by default, per IPCSA/GDPR) · each agency approves, rejects or queries independently, with the agency list configured per port · port entry permit issued automatically when all agencies approve, printable with a QR code anyone can verify · departure clearance |
| **Cargo & customs** (FR-CGO, FR-CUS, FR-CON) | Manifests (portal, REST or EDI CUSCAR) with ISO 6346 / HS / UN/LOCODE validation and amendment versioning · B/L-level customs status exchange (declared → inspection → released / held) · automatic customs holds · container tracking and dwell time |
| **eDO & gate** (FR-GAT) | Electronic delivery order (forwarder requests, shipping line issues with a PIN) · slot-based truck appointment system with capacity per terminal · gate console checking the appointment, eDO, customs release and holds in one step · every gate attempt logged |
| **Hinterland** (FR-TRS) | Danube / inland barge calls (ENI) · rail visits with wagon lists |
| **Marine services** (FR-MKT, FR-VAS) | Provider catalogue · requests linked to the vessel call · accept, schedule and complete · auto-billing |
| **Finance** (FR-FIN) | Tariff book (per call / GT / LOA-day / TEU / tonne / unit, with minimums and conditions) · invoices rated automatically at each billable event · VAT per port · payment (mock gateway) · ERP journal export |
| **Integration** (FR-INT) | UN/EDIFACT engine: inbound CUSCAR, CODECO, COARRI, BERMAN, CUSRES; outbound APERAK and CUSCAR · webhooks signed with HMAC · transactional outbox (Kafka-ready) · OpenAPI 3 at `/api/docs` |
| **Analytics & GIS** (FR-AI, FR-GIS) | 20 operational KPIs · trends · berth occupancy · clearance time by agency · **public WTO TFA Art. 7.6 average release time** · live port map (AIS simulated in demo) |

## System boundaries

These boundaries follow Annex 3 of the Constanța offer:

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

**Why TypeScript end to end** (and not the Angular / .NET stack in the proposals): one language across API, portal,
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

Two ports are seeded: **Port of Constanța (ROCND)**, with RON, trilingual UI, border police and barges, and
**Lagos Port Complex, Apapa (NGAPP)**, with NGN, immigration, NIMASA and NICIS II. Authorities and terminals mirror the
real ports; every commercial party, vessel, B/L and container is fictitious. Accounts follow `<role>@rocnd.demo` /
`<role>@ngapp.demo`. Roles: agent, harbour, customs, border, health, immigration, maritime, line, forwarder, haulier,
terminal, barge, rail, services, finance, portadmin, exec. The platform admin is `admin@pcs.demo`. The password is
`DEMO_PASSWORD` (default `PcsDemo!2026` locally; set a secret in Azure).

Suggested demo path (about 15 min): agent creates a call, submits the berthing request → harbour master allocates
a berth (try an undersized berth to see the checks) → agent fills in the FAL forms and submits pre-arrival → each
agency approves in the clearance queue → the permit appears with its QR code → agent submits the manifest →
forwarder links a declaration → customs releases → forwarder requests the eDO, the line issues it → haulier books a
slot → terminal processes gate in and out → departure → invoice → pay.

## Deploy to Azure (GitHub Actions)

The pipeline (`.github/workflows/ci-cd.yml`) follows the same pattern as port-esg: typecheck and integration
tests → security scans (npm audit, gitleaks, Trivy, Bicep build) → image build, scan and boot smoke test → push to
GHCR → **Bicep deployment** (infrastructure and new image in one step) → health wait → smoke tests against Azure →
automatic rollback on failure.

PCS shares the ESG app's **Container Apps environment** and **PostgreSQL server**. It gets its own `pcs` database
with roles `pcs_owner` (migrations) and `pcs_app` (runtime, row-level security), so ESG data is not touched and
PCS never stores ESG's admin password. The deploy job creates the database and roles idempotently, using ESG's
connection read from Azure and a temporary firewall rule for the runner. No GitHub secrets are needed: PCS
passwords are generated on the first deploy and kept only in the PCS container app's secrets.

One-time setup:

1. In Azure Cloud Shell, run `bash infra/github-oidc-setup.sh`. It creates `rg-pcs-dev` and a federated identity
   with Contributor on the PCS and ESG resource groups, then prints five variables.
2. In GitHub, go to **Settings → Environments → `azure-dev` → Variables** and add `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `ESG_RESOURCE_GROUP`. Optionally add a
   secret `PCS_DEMO_PASSWORD`; otherwise one is generated. Read it with
   `az containerapp secret show -g rg-pcs-dev -n <app> --secret-name demo-password`.
3. Make the GHCR package `ghcr.io/indranil32/pcs` **public**, as for port-esg, then re-run the workflow.

Until the variables exist, the deploy job skips with a warning, so CI still passes. `infra/prod.bicepparam` holds
production settings (UAE North, General Purpose PostgreSQL, no demo seed, no AIS simulator).

## Roadmap to production

- Real adapters: Romanian customs / NICIS II, payment gateways (Remita, bank), AIS/VTMS feed, ERP posting, EU MSW / eIDAS signatures
- Entra ID / SAML SSO for authority users (pattern from port-esg)
- Mobile app (FR-MOB), AI features (ETA prediction, OCR, port copilot on on-prem Ollama), compliance tracker
- Kafka producer on the outbox; VNet-integrated PostgreSQL with a private endpoint; blob storage for large documents
- Requirement-ID traceability against PRD v2.1 / Romania matrix v3.3 (module codes are already in the source headers)
