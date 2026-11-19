// Maqta PCS — Azure deployment (Container Apps + PostgreSQL Flexible Server + Log Analytics).
// Same template for a personal trial subscription and the company subscription: only the parameters differ.
//   az group create -n rg-pcs-dev -l centralindia
//   az deployment group create -g rg-pcs-dev -f infra/main.bicep -p infra/dev.bicepparam
// The GitHub Actions workflow runs this on every push to main, so manual runs are only needed for the first bootstrap
// or for debugging.
targetScope = 'resourceGroup'

@description('Short name used to build resource names (letters/numbers).')
@minLength(3)
@maxLength(12)
param prefix string = 'pcs'

param location string = resourceGroup().location

@description('Region for PostgreSQL. Trial subscriptions often cannot create it in every region.')
param dbLocation string = location

@description('Container image, e.g. ghcr.io/indranil32/pcs:<sha>.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Reuse an existing Container Apps environment (resource ID). Trial subscriptions allow only one environment per region — pass the ESG environment here to share it. Blank creates a new one.')
param existingEnvironmentId string = ''

@description('Use an existing PostgreSQL flexible server (FQDN), e.g. the ESG server. Blank creates a dedicated server. The pcs database and roles must exist (the CI/CD workflow creates them).')
param existingPostgresHost string = ''

@description('Role that owns the pcs database and runs migrations.')
param dbAdminUser string = 'pcsadmin'

@secure()
@description('Password of dbAdminUser.')
param dbAdminPassword string

@secure()
@description('Password for the pcs_app database role the API connects as (row-level security applies to it).')
param appDbPassword string

@secure()
@description('Long random string used to sign JWTs.')
param jwtSecret string

@description('true loads the synthetic Constanța + Lagos demo data on first start. Must be false for real data.')
param seedDemoData bool = false

@secure()
@description('Password for the seeded demo users.')
param demoPassword string = ''

@description('Run the AIS position simulator (demo only — replace with the AIS/VTMS adapter in production).')
param aisSimulator bool = true

param dbSku string = 'Standard_B1ms'
param dbTier string = 'Burstable'
param maxReplicas int = 2
@description('Allowed browser origin for the API. The portal is served from the same origin, so this only matters for external front ends.')
param corsOrigin string = ''

var uniq = uniqueString(resourceGroup().id)
var createEnv = empty(existingEnvironmentId)
var createPg = empty(existingPostgresHost)

// ---------------------------------------------------------------- monitoring
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (createEnv) {
  name: 'log-${prefix}-${uniq}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

// ---------------------------------------------------------------- database
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (createPg) {
  name: 'psql-${prefix}-${uniq}-${dbLocation}'
  location: dbLocation
  sku: { name: dbSku, tier: dbTier }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}
resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (createPg) {
  parent: pg
  name: 'pcs'
}
// Lets Azure-hosted services (the container app) connect. Use VNet integration + private endpoint for production.
resource pgAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (createPg) {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------------------------------------------------------------- app
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = if (createEnv) {
  name: 'cae-${prefix}-${uniq}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs!.properties.customerId
        sharedKey: logs!.listKeys().primarySharedKey
      }
    }
  }
}

var host = createPg ? pg!.properties.fullyQualifiedDomainName : existingPostgresHost
var adminUrl = 'postgresql://${dbAdminUser}:${uriComponent(dbAdminPassword)}@${host}:5432/pcs?sslmode=require'
var appUrl = 'postgresql://pcs_app:${uriComponent(appDbPassword)}@${host}:5432/pcs?sslmode=require'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${prefix}-${uniq}'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: createEnv ? env.id : existingEnvironmentId
    configuration: {
      ingress: { external: true, targetPort: 4000, transport: 'auto' }
      secrets: concat([
        { name: 'admin-database-url', value: adminUrl }
        { name: 'database-url', value: appUrl }
        { name: 'app-db-password', value: appDbPassword }
        { name: 'db-admin-password', value: dbAdminPassword }
        { name: 'jwt-secret', value: jwtSecret }
      ], demoPassword != '' ? [
        { name: 'demo-password', value: demoPassword }
      ] : [])
    }
    template: {
      containers: [
        {
          name: 'pcs'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat([
            { name: 'ADMIN_DATABASE_URL', secretRef: 'admin-database-url' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'APP_DB_PASSWORD', secretRef: 'app-db-password' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'SEED_DEMO_DATA', value: string(seedDemoData) }
            { name: 'AIS_SIMULATOR', value: string(aisSimulator) }
            { name: 'CORS_ORIGIN', value: corsOrigin == '' ? 'false' : corsOrigin }
          ], demoPassword != '' ? [
            { name: 'DEMO_PASSWORD', secretRef: 'demo-password' }
          ] : [])
          probes: [
            { type: 'Readiness', httpGet: { path: '/ready', port: 4000 }, initialDelaySeconds: 10, periodSeconds: 30, failureThreshold: 48 }
            { type: 'Liveness', httpGet: { path: '/health', port: 4000 }, initialDelaySeconds: 60, periodSeconds: 30 }
          ]
        }
      ]
      // A single replica keeps the in-process workers (outbox, AIS) single-writer; outbox uses SKIP LOCKED so >1 is safe too.
      scale: { minReplicas: 1, maxReplicas: maxReplicas }
    }
  }
  dependsOn: [ pgDb, pgAzure ]
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
output postgresServer string = host
