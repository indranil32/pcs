using './main.bicep'

// Company subscription — real data. No demo seed, no AIS simulator.
param prefix = 'pcs'
param image = readEnvironmentVariable('PCS_IMAGE', 'ghcr.io/indranil32/pcs:latest')
param location = 'westeurope'
param dbLocation = 'westeurope'
param existingEnvironmentId = readEnvironmentVariable('PCS_EXISTING_ENV_ID', '')
param seedDemoData = false
param aisSimulator = false
param dbSku = 'Standard_D2ds_v5'
param dbTier = 'GeneralPurpose'
param maxReplicas = 4
param dbAdminPassword = readEnvironmentVariable('PCS_DB_ADMIN_PASSWORD', '')
param appDbPassword = readEnvironmentVariable('PCS_APP_DB_PASSWORD', '')
param jwtSecret = readEnvironmentVariable('PCS_JWT_SECRET', '')
