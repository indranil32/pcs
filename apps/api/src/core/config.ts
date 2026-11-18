export const config = {
  port: Number(process.env.PORT ?? 4000),
  // Application connects as pcs_app (non-superuser) so row-level security applies.
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://pcs_app:pcs_app@localhost:5432/pcs',
  // Migrations run as the schema owner.
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/pcs',
  appDbPassword: process.env.APP_DB_PASSWORD ?? 'pcs_app',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me-in-production-0123456789',
  jwtTtl: process.env.JWT_TTL ?? '12h',
  corsOrigin: ((v) => (v === undefined || v === 'true' ? true : v === 'false' ? false : v.split(',')))(process.env.CORS_ORIGIN) as boolean | string[],
  workers: process.env.WORKERS !== 'false',
  aisSimulator: process.env.AIS_SIMULATOR !== 'false',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
