-- FR-ICD / FR-DEP / FR-CFS: inland facilities linked to the port — dry ports (ICD), empty container depots and
-- container freight stations — with bonded transfers, facility gate (EIR), depot repair and empty release, CFS stuffing/destuffing.

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,                        -- DRY_PORT / EMPTY_DEPOT / CFS
  operator_org_id uuid REFERENCES organisations(id),
  location text,                             -- UN/LOCODE or place name
  lat double precision, lon double precision,
  distance_km numeric(7,1),                  -- road/rail distance from the seaport
  bonded boolean NOT NULL DEFAULT false,     -- customs-bonded: uncleared imports may move here under transit
  capacity_teu int, capacity_m3 int,
  free_days int NOT NULL DEFAULT 3,          -- free storage before daily storage charges
  transit_hours int NOT NULL DEFAULT 24,     -- customs transit time allowed from the port
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Containers at inland facilities (full and empty). Empties held for lines have no B/L.
ALTER TABLE containers ADD COLUMN facility_id uuid REFERENCES facilities(id);
ALTER TABLE containers ADD COLUMN line_org_id uuid REFERENCES organisations(id);
ALTER TABLE containers ADD COLUMN condition text;            -- SOUND / DAMAGED / UNDER_REPAIR
ALTER TABLE containers ADD COLUMN facility_in_at timestamptz;
CREATE INDEX ON containers (facility_id) WHERE facility_id IS NOT NULL;

-- Bonded (customs transit) transfers between the seaport and an inland facility
CREATE TABLE inland_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  transfer_no text NOT NULL,
  direction text NOT NULL,                   -- TO_FACILITY (import) / TO_PORT (export)
  facility_id uuid NOT NULL REFERENCES facilities(id),
  terminal_id uuid NOT NULL REFERENCES terminals(id),
  bl_id uuid REFERENCES bills_of_lading(id),
  requester_org_id uuid NOT NULL REFERENCES organisations(id),
  carrier_org_id uuid REFERENCES organisations(id),    -- haulier / rail / barge operator
  mode text NOT NULL,                        -- TRUCK / RAIL / BARGE
  containers text[] NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED',  -- REQUESTED / CUSTOMS_APPROVED / REJECTED / IN_TRANSIT / ARRIVED / CANCELLED
  transit_doc_no text,
  transit_deadline timestamptz,
  dispatched_at timestamptz, arrived_at timestamptz,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON inland_transfers (tenant_id, status);

-- Facility gate transactions with an equipment interchange receipt (EIR) and condition survey
CREATE TABLE facility_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  eir_no text,
  direction text NOT NULL,                   -- IN / OUT
  purpose text NOT NULL,                     -- TRANSFER / EMPTY_RETURN / EMPTY_RELEASE / IMPORT_DELIVERY / EXPORT_RECEIPT / CFS_DELIVERY
  container_no char(11),
  full_empty char(1),
  truck_plate text NOT NULL,
  haulier_org_id uuid REFERENCES organisations(id),
  line_org_id uuid REFERENCES organisations(id),
  reference text,                            -- DO / release / transfer / lot number
  condition text,
  damages jsonb NOT NULL DEFAULT '[]',
  seal_no text,
  result text NOT NULL,                      -- ACCEPTED / REJECTED
  reason text,
  dwell_days int,
  created_by uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON facility_moves (tenant_id, facility_id, at DESC);

-- Empty depot: maintenance & repair (M&R) estimates approved by the line
CREATE TABLE depot_repairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  estimate_no text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  container_no char(11) NOT NULL,
  line_org_id uuid NOT NULL REFERENCES organisations(id),
  move_id uuid REFERENCES facility_moves(id),
  items jsonb NOT NULL,                      -- [{component, damage, repair, hours, material, amount}]
  total numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'ESTIMATED',  -- ESTIMATED / APPROVED / REJECTED / COMPLETED
  decided_at timestamptz, completed_at timestamptz,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Empty depot: release orders issued by the line (pick-up of empties for export bookings)
CREATE TABLE empty_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  release_no text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  line_org_id uuid NOT NULL REFERENCES organisations(id),
  booking_no text NOT NULL,
  iso_type text NOT NULL,
  quantity int NOT NULL,
  released int NOT NULL DEFAULT 0,
  haulier_org_id uuid REFERENCES organisations(id),
  valid_until date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',       -- OPEN / COMPLETED / CANCELLED / EXPIRED
  created_at timestamptz NOT NULL DEFAULT now()
);

-- CFS: stuffing / destuffing jobs and the cargo lots (house B/Ls) held in the shed
CREATE TABLE cfs_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_no text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  type text NOT NULL,                        -- DESTUFF (import LCL) / STUFF (export LCL)
  container_no char(11) NOT NULL,
  bl_id uuid REFERENCES bills_of_lading(id),
  requester_org_id uuid NOT NULL REFERENCES organisations(id),
  status text NOT NULL DEFAULT 'REQUESTED',  -- REQUESTED / SCHEDULED / IN_PROGRESS / COMPLETED / CANCELLED
  scheduled_at timestamptz, started_at timestamptz, completed_at timestamptz,
  seal_no text,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cfs_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lot_no text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  job_id uuid REFERENCES cfs_jobs(id),       -- destuff job that produced it / stuff job that consumed it
  direction text NOT NULL,                   -- IMPORT / EXPORT
  house_bl text NOT NULL,
  owner_org_id uuid NOT NULL REFERENCES organisations(id),  -- consolidator / forwarder
  consignee text,
  description text, marks text,
  packages int NOT NULL,                     -- declared
  packages_received int,                     -- tallied
  packages_damaged int NOT NULL DEFAULT 0,
  packages_delivered int NOT NULL DEFAULT 0,
  weight_kg numeric(12,2), volume_m3 numeric(10,3),
  location text,                             -- shed / bay
  customs_status text NOT NULL DEFAULT 'NOT_DECLARED',
  declaration_no text,
  status text NOT NULL DEFAULT 'EXPECTED',   -- EXPECTED / IN_STORE / PARTLY_DELIVERED / DELIVERED / STUFFED / SHORT_LANDED
  received_at timestamptz, delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cfs_lots (tenant_id, facility_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facilities','inland_transfers','facility_moves','depot_repairs','empty_releases','cfs_jobs','cfs_lots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (
      current_setting('app.tenant_id', true) = '*' OR tenant_id::text = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;
