#!/usr/bin/env bash
# One-time bootstrap (run in Azure Cloud Shell): resource group + Entra app with a federated credential so
# GitHub Actions deploys without a stored Azure secret. Prints the GitHub variables and secrets to set.
# Usage: infra/github-oidc-setup.sh [resource-group=rg-pcs-dev] [location=centralindia] [github-repo=indranil32/pcs] [environment=azure-dev]
set -euo pipefail
RG=${1:-rg-pcs-dev}; LOC=${2:-centralindia}; REPO=${3:-indranil32/pcs}; ENVN=${4:-azure-dev}
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
az group create -n "$RG" -l "$LOC" -o none
for p in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.OperationalInsights; do az provider register -n $p -o none; done
APPID=$(az ad app list --display-name "pcs-github-deploy" --query "[0].appId" -o tsv)
[ -n "$APPID" ] || APPID=$(az ad app create --display-name "pcs-github-deploy" --query appId -o tsv)
az ad sp show --id "$APPID" >/dev/null 2>&1 || az ad sp create --id "$APPID" -o none
az ad app federated-credential create --id "$APPID" --parameters "{\"name\":\"github-$ENVN\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:$ENVN\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || echo "federated credential exists"
az role assignment create --assignee "$APPID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/$RG" -o none 2>/dev/null || echo "role exists"
# Optional: share the ESG app's Container Apps environment (trial subscriptions allow one per region)
ESG_ENV=$(az containerapp env list --query "[?contains(name,'esg')].id | [0]" -o tsv 2>/dev/null || true)
if [ -n "$ESG_ENV" ]; then
  az role assignment create --assignee "$APPID" --role Contributor --scope "$ESG_ENV" -o none 2>/dev/null || true
  echo "Found ESG environment — reuse it by setting the PCS_EXISTING_ENV_ID variable below."
fi
cat <<OUT

=== GitHub → Settings → Environments → $ENVN ===
Variables:
  AZURE_CLIENT_ID=$APPID
  AZURE_TENANT_ID=$TENANT
  AZURE_SUBSCRIPTION_ID=$SUB
  AZURE_RESOURCE_GROUP=$RG
  PCS_EXISTING_ENV_ID=${ESG_ENV:-<leave unset to create a new environment>}
Secrets (generate fresh values):
  PCS_DB_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)Aa1
  PCS_APP_DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)Bb2
  PCS_JWT_SECRET=$(openssl rand -hex 32)
  PCS_DEMO_PASSWORD=<choose a demo password>

Or with the GitHub CLI:
  gh variable set AZURE_CLIENT_ID -e $ENVN -b $APPID -R $REPO
  gh variable set AZURE_TENANT_ID -e $ENVN -b $TENANT -R $REPO
  gh variable set AZURE_SUBSCRIPTION_ID -e $ENVN -b $SUB -R $REPO
  gh variable set AZURE_RESOURCE_GROUP -e $ENVN -b $RG -R $REPO
  gh secret set PCS_DB_ADMIN_PASSWORD -e $ENVN -R $REPO     (and the other three secrets)
OUT
