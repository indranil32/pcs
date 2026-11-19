#!/usr/bin/env bash
# One-time bootstrap, run in Azure Cloud Shell. Creates the PCS resource group and a GitHub OIDC identity
# (no stored Azure secret). PCS shares the ESG app's Container Apps environment and PostgreSQL server, so the
# identity also gets Contributor on the ESG resource group (to place the app in that environment, read ESG's DB
# connection once to create the separate pcs database/roles, and open a temporary firewall rule during deploys).
# Usage: bash github-oidc-setup.sh [pcs-rg=rg-pcs-dev] [location=centralindia] [repo=indranil32/pcs] [environment=azure-dev]
set -euo pipefail
RG=${1:-rg-pcs-dev}; LOC=${2:-centralindia}; REPO=${3:-indranil32/pcs}; ENVN=${4:-azure-dev}
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
ESG_RG=$(az postgres flexible-server list --query "[?starts_with(name,'psql-esg')].resourceGroup | [0]" -o tsv)
[ -n "$ESG_RG" ] || { echo "ESG PostgreSQL server not found in this subscription"; exit 1; }
az group create -n "$RG" -l "$LOC" -o none
for p in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.OperationalInsights; do az provider register -n $p -o none; done
APPID=$(az ad app list --display-name pcs-github-deploy --query "[0].appId" -o tsv)
[ -n "$APPID" ] || APPID=$(az ad app create --display-name pcs-github-deploy --query appId -o tsv)
az ad sp show --id "$APPID" >/dev/null 2>&1 || az ad sp create --id "$APPID" -o none
az ad app federated-credential create --id "$APPID" --parameters "{\"name\":\"github-$ENVN\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:$ENVN\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || echo "(federated credential already exists)"
for scope in "$RG" "$ESG_RG"; do
  az role assignment create --assignee "$APPID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/$scope" -o none 2>/dev/null || echo "(role on $scope already exists)"
done
cat <<OUT

=== GitHub → indranil32/pcs → Settings → Environments → $ENVN → Variables ===
AZURE_CLIENT_ID=$APPID
AZURE_TENANT_ID=$TENANT
AZURE_SUBSCRIPTION_ID=$SUB
AZURE_RESOURCE_GROUP=$RG
ESG_RESOURCE_GROUP=$ESG_RG
(No secrets needed: PCS passwords are generated on the first deploy and kept in the container app's secrets.)
OUT
