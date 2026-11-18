-- Tenant isolation (defence in depth): the application connects as pcs_app, which is subject to RLS.
-- Every request sets app.tenant_id inside its transaction; platform admins set app.tenant_id = '*'.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organisations','api_keys','counters','notifications','outbox','webhooks','approvals','attachments','comments',
    'terminals','berths','vessel_calls','fal_forms','service_offerings','service_requests','manifests',
    'bills_of_lading','containers','container_events','delivery_orders','truck_appointments','gate_events',
    'barge_calls','rail_visits','tariffs','invoices','payments','edi_messages','ais_positions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (
      current_setting('app.tenant_id', true) = '*' OR tenant_id::text = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;
