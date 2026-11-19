-- FR-VES / FR-SWN / FR-MKT: vessel calls, FAL forms, marine services
CREATE TABLE vessel_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  call_no text NOT NULL,
  vessel_id uuid NOT NULL REFERENCES vessels(id),
  agent_org_id uuid NOT NULL REFERENCES organisations(id),
  line_org_id uuid REFERENCES organisations(id),
  voyage_in text, voyage_out text,
  purpose text NOT NULL DEFAULT 'CARGO_OPERATIONS',
  last_port char(5), next_port char(5),
  eta timestamptz NOT NULL, etd timestamptz NOT NULL,
  ata timestamptz, berthed_at timestamptz, atd timestamptz,
  requested_berth_id uuid REFERENCES berths(id),
  berth_id uuid REFERENCES berths(id),
  terminal_id uuid REFERENCES terminals(id),
  arrival_draft numeric(4,2),
  crew_count int, passenger_count int,
  dangerous_goods boolean NOT NULL DEFAULT false,
  cargo_summary text,
  status text NOT NULL DEFAULT 'DRAFT',
  entry_permit_no text, entry_permit_at timestamptz,
  departure_clearance_no text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, call_no)
);
CREATE INDEX ON vessel_calls (tenant_id, status);

CREATE TABLE fal_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  call_id uuid NOT NULL REFERENCES vessel_calls(id) ON DELETE CASCADE,
  form_no int NOT NULL CHECK (form_no BETWEEN 1 AND 7),
  data jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  submitted_by uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, form_no)
);

CREATE TABLE service_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  org_id uuid NOT NULL REFERENCES organisations(id),
  service_type text NOT NULL,
  description text,
  unit text NOT NULL DEFAULT 'JOB',
  unit_price numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_no text NOT NULL,
  call_id uuid REFERENCES vessel_calls(id),
  offering_id uuid REFERENCES service_offerings(id),
  service_type text NOT NULL,
  requester_org_id uuid NOT NULL REFERENCES organisations(id),
  provider_org_id uuid NOT NULL REFERENCES organisations(id),
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  requested_for timestamptz NOT NULL,
  scheduled_at timestamptz,
  completed_at timestamptz,
  notes text,
  status text NOT NULL DEFAULT 'REQUESTED',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FR-CGO / FR-CUS / FR-CON: manifests, bills of lading, containers, customs status
CREATE TABLE manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  call_id uuid NOT NULL REFERENCES vessel_calls(id),
  direction text NOT NULL,          -- IMPORT / EXPORT
  submitted_by_org uuid NOT NULL REFERENCES organisations(id),
  source text NOT NULL DEFAULT 'UI', -- UI / API / EDI
  status text NOT NULL DEFAULT 'SUBMITTED',  -- SUBMITTED / ACCEPTED / AMENDED / REJECTED
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, direction)
);

CREATE TABLE bills_of_lading (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  manifest_id uuid NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  bl_no text NOT NULL,
  shipper text, consignee text, notify_party text,
  consignee_org_id uuid REFERENCES organisations(id),
  forwarder_org_id uuid REFERENCES organisations(id),
  pol char(5), pod char(5),
  description text, hs_code text,
  packages int, gross_kg numeric(12,2),
  customs_status text NOT NULL DEFAULT 'NOT_DECLARED',
  declaration_no text,
  declared_at timestamptz, released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manifest_id, bl_no)
);
CREATE INDEX ON bills_of_lading (tenant_id, bl_no);

CREATE TABLE containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bl_id uuid REFERENCES bills_of_lading(id) ON DELETE CASCADE,
  call_id uuid REFERENCES vessel_calls(id),
  container_no char(11) NOT NULL,
  iso_type text, seal_no text,
  gross_kg numeric(12,2),
  full_empty char(1) NOT NULL DEFAULT 'F',
  terminal_id uuid REFERENCES terminals(id),
  status text NOT NULL DEFAULT 'ON_VESSEL',
  holds text[] NOT NULL DEFAULT '{}',
  discharged_at timestamptz, gated_out_at timestamptz, gated_in_at timestamptz, loaded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON containers (tenant_id, container_no);

CREATE TABLE container_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  container_id uuid NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  event text NOT NULL,
  location text,
  source text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  do_no text NOT NULL,
  bl_id uuid NOT NULL REFERENCES bills_of_lading(id),
  issuer_org_id uuid NOT NULL REFERENCES organisations(id),     -- line / agent
  requester_org_id uuid NOT NULL REFERENCES organisations(id),  -- forwarder / consignee
  haulier_org_id uuid REFERENCES organisations(id),
  valid_until date,
  pin text,
  status text NOT NULL DEFAULT 'REQUESTED',
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz
);

-- FR-GAT: truck appointments and gate transactions
CREATE TABLE truck_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  appt_no text NOT NULL,
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  haulier_org_id uuid NOT NULL REFERENCES organisations(id),
  direction text NOT NULL,  -- IMPORT_PICKUP / EXPORT_DROPOFF / EMPTY_RETURN / EMPTY_PICKUP
  container_no char(11),
  do_id uuid REFERENCES delivery_orders(id),
  truck_plate text NOT NULL,
  driver_name text,
  driver_licence text,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  token text NOT NULL,
  status text NOT NULL DEFAULT 'BOOKED',
  gate_in_at timestamptz, gate_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON truck_appointments (tenant_id, terminal_id, slot_start);

CREATE TABLE gate_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  appointment_id uuid REFERENCES truck_appointments(id),
  truck_plate text NOT NULL,
  container_no text,
  direction text NOT NULL,  -- IN / OUT
  source text NOT NULL,     -- ANPR / MANUAL / API / OCR
  result text NOT NULL,     -- ACCEPTED / REJECTED
  reason text,
  at timestamptz NOT NULL DEFAULT now()
);

-- FR-TRS: inland waterway barges and rail
CREATE TABLE barge_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  call_no text NOT NULL,
  operator_org_id uuid NOT NULL REFERENCES organisations(id),
  barge_name text NOT NULL,
  eni char(8) NOT NULL,
  convoy_ref text,
  origin text, destination text,
  terminal_id uuid REFERENCES terminals(id),
  berth_id uuid REFERENCES berths(id),
  eta timestamptz NOT NULL, ata timestamptz, atd timestamptz,
  cargo_description text,
  tonnage numeric(12,2),
  containers text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PLANNED',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rail_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  visit_no text NOT NULL,
  operator_org_id uuid NOT NULL REFERENCES organisations(id),
  train_no text NOT NULL,
  direction text NOT NULL,      -- INBOUND / OUTBOUND
  terminal_id uuid REFERENCES terminals(id),
  origin text, destination text,
  eta timestamptz NOT NULL, ata timestamptz, atd timestamptz,
  wagons jsonb NOT NULL DEFAULT '[]',   -- [{wagonNo, containers:[...], cargo, tonnes}]
  status text NOT NULL DEFAULT 'PLANNED',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FR-FIN: tariffs, invoices, payments
CREATE TABLE tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  applies_to text NOT NULL,  -- VESSEL_CALL / CONTAINER / BARGE_CALL / TRUCK_APPOINTMENT / DELIVERY_ORDER
  basis text NOT NULL,       -- PER_CALL / PER_GT / PER_LOA_DAY / PER_TEU / PER_TONNE / PER_UNIT
  rate numeric(12,4) NOT NULL,
  currency char(3) NOT NULL,
  min_amount numeric(12,2),
  conditions jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_no text NOT NULL,
  customer_org_id uuid NOT NULL REFERENCES organisations(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  reference text,
  currency char(3) NOT NULL,
  subtotal numeric(14,2) NOT NULL,
  tax numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED',
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  paid_at timestamptz,
  erp_ref text
);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  tariff_code text NOT NULL,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL,
  rate numeric(12,4) NOT NULL,
  amount numeric(14,2) NOT NULL
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount numeric(14,2) NOT NULL,
  currency char(3) NOT NULL,
  method text NOT NULL,          -- CARD / BANK_TRANSFER / WALLET
  provider text NOT NULL DEFAULT 'MOCK_GATEWAY',
  provider_ref text NOT NULL,
  status text NOT NULL,          -- SUCCEEDED / FAILED
  paid_by uuid,
  at timestamptz NOT NULL DEFAULT now()
);

-- FR-INT: EDI message store
CREATE TABLE edi_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  direction text NOT NULL,       -- IN / OUT
  msg_type text NOT NULL,
  sender text, receiver text,
  interchange_ref text,
  org_id uuid REFERENCES organisations(id),
  raw text NOT NULL,
  parsed jsonb,
  status text NOT NULL,          -- RECEIVED / PROCESSED / ERROR / SENT
  errors jsonb NOT NULL DEFAULT '[]',
  summary text,
  related_entity_type text, related_entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FR-GIS: AIS positions (fed by AIS/VTMS adapter; simulator in dev)
CREATE TABLE ais_positions (
  mmsi text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  vessel_id uuid REFERENCES vessels(id),
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  sog numeric(4,1), cog numeric(4,1),
  nav_status text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mmsi)
);
