-- FR-PLT: platform core — tenants (ports), organisations, users, audit, notifications, outbox, approvals, attachments

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,                -- e.g. ROCND, NGAPP
  name text NOT NULL,
  country char(2) NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  currency char(3) NOT NULL DEFAULT 'USD',
  lat double precision, lon double precision,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  type text NOT NULL,
  registration_no text,
  tax_id text,
  email text NOT NULL,
  phone text,
  address text,
  status text NOT NULL DEFAULT 'PENDING',
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),    -- null = platform super admin
  org_id uuid REFERENCES organisations(id),
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  roles text[] NOT NULL,
  lang text NOT NULL DEFAULT 'en',
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  org_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL,
  roles text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  user_id uuid,
  org_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  data jsonb,
  ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, entity_type, entity_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  org_id uuid,          -- deliver to an organisation
  role text,            -- or to every user holding a role
  user_id uuid,         -- or to a single user
  title text NOT NULL,
  body text,
  link text,
  severity text NOT NULL DEFAULT 'info',
  read_by uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (tenant_id, created_at DESC);

-- Transactional outbox: every domain event is written in the same transaction as the change,
-- then published to webhooks (and Kafka in production) by the dispatcher.
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX ON outbox (published_at) WHERE published_at IS NULL;

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  org_id uuid NOT NULL REFERENCES organisations(id),
  url text NOT NULL,
  events text[] NOT NULL,
  secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Generic multi-agency approval (Single Window clearance, permits, DOs ...)
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  stage text NOT NULL,            -- ARRIVAL / DEPARTURE / ...
  agency text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  remarks text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, stage, agency)
);
CREATE INDEX ON approvals (tenant_id, agency, status);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  doc_type text,
  filename text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL,
  content bytea NOT NULL,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON attachments (entity_type, entity_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  user_id uuid NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FR-REF: reference data. Vessels and locations are global; berths and terminals are per port.
CREATE TABLE locations (
  unlocode char(5) PRIMARY KEY,
  name text NOT NULL,
  country char(2) NOT NULL
);

CREATE TABLE vessels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imo char(7) UNIQUE NOT NULL,
  name text NOT NULL,
  call_sign text,
  mmsi text,
  flag char(2),
  type text NOT NULL,
  gt int, dwt int,
  loa numeric(6,2), beam numeric(5,2), max_draft numeric(4,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,                       -- CONTAINER / BULK / RORO / LIQUID / GENERAL / PASSENGER
  operator_org_id uuid REFERENCES organisations(id),
  lat double precision, lon double precision,
  UNIQUE (tenant_id, code)
);

CREATE TABLE berths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  terminal_id uuid REFERENCES terminals(id),
  code text NOT NULL,
  name text NOT NULL,
  length_m numeric(6,1) NOT NULL,
  depth_m numeric(4,1) NOT NULL,
  lat double precision, lon double precision,
  barge_berth boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);
