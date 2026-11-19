using './main.bicep'

// Trial / personal subscription. Synthetic data only.
param prefix = 'pcsdev'
param image = readEnvironmentVariable('PCS_IMAGE', 'ghcr.io/indranil32/pcs:latest')
param location = 'centralindia'      // Container Apps (same region as the ESG app)
param dbLocation = 'uksouth'          // PostgreSQL is restricted in some trial regions
// Trial subscriptions allow one Container Apps environment: set PCS_EXISTING_ENV_ID to the ESG environment's resource ID to share it.
param existingEnvironmentId = readEnvironmentVariable('PCS_EXISTING_ENV_ID', '')
// Shared with the ESG app: its PostgreSQL server (separate pcs database + roles) and Container Apps environment.
param existingPostgresHost = readEnvironmentVariable('PCS_EXISTING_PG_HOST', '')
param dbAdminUser = readEnvironmentVariable('PCS_DB_ADMIN_USER', 'pcsadmin')
param seedDemoData = true
param aisSimulator = true
param maxReplicas = 1
// Secrets come from GitHub Actions secrets (or your shell), never from this file.
param dbAdminPassword = readEnvironmentVariable('PCS_DB_ADMIN_PASSWORD', '')
param appDbPassword = readEnvironmentVariable('PCS_APP_DB_PASSWORD', '')
param jwtSecret = readEnvironmentVariable('PCS_JWT_SECRET', '')
param demoPassword = readEnvironmentVariable('PCS_DEMO_PASSWORD', '')
