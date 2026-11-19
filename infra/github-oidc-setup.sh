#!/usr/bin/env bash
# One-time bootstrap, run in Azure Cloud Shell. Creates the PCS resource group and a GitHub OIDC identity
# (no stored Azure secret). Optionally PCS can share an existing resource group's Container Apps environment and
# PostgreSQL server; then the identity also gets Contributor there (to place the app in that environment, read the
# server's admin connection from the app that owns it to create the separate pcs database/roles, and open a
# temporary firewall rule during deploys).
# Usage: bash github-oidc-setup.sh <shared-rg> [pcs-rg=rg-pcs-dev] [location=centralindia] [repo=indranil32/pcs] [environment=azure-dev]
set -euo pipefail
SHARED_RG=${1:?usage: github-oidc-setup.sh <shared-resource-group> [pcs-rg] [location] [repo] [environment]}
RG=${2:-rg-pcs-dev}; LOC=${3:-centralindia}; REPO=${4:-indranil32/pcs}; ENVN=${5:-azure-dev}
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
az group show -n "$SHARED_RG" -o none
az group create -n "$RG" -l "$LOC" -o none
for p in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.OperationalInsights; do az provider register -n $p -o none; done
APPID=$(az ad app list --display-name pcs-github-deploy --query "[0].appId" -o tsv)
[ -n "$APPID" ] || APPID=$(az ad app create --display-name pcs-github-deploy --query appId -o tsv)
az ad sp show --id "$APPID" >/dev/null 2>&1 || az ad sp create --id "$APPID" -o none
# GitHub may present a name-based or an ID-based subject; register the name-based one here. If login fails with
# AADSTS700213, add a second credential with the exact subject quoted in the error.
az ad app federated-credential create --id "$APPID" --parameters "{\"name\":\"github-$ENVN\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:$ENVN\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || echo "(federated credential already exists)"
for scope in "$RG" "$SHARED_RG"; do
  az role assignment create --assignee "$APPID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/$scope" -o none 2>/dev/null || echo "(role on $scope already exists)"
done
cat <<OUT

=== GitHub → $REPO → Settings → Environments → $ENVN → Variables ===
AZURE_CLIENT_ID=$APPID
AZURE_TENANT_ID=$TENANT
AZURE_SUBSCRIPTION_ID=$SUB
AZURE_RESOURCE_GROUP=$RG
SHARED_RESOURCE_GROUP=$SHARED_RG
(No secrets needed: PCS passwords are generated on the first deploy and kept in the container app's secrets.)
OUT
