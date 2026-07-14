#!/bin/bash
# KAIF Azure Credential Rotation Script
# Systematically rotates all secrets in the correct order with verification
# Usage: ./scripts/rotate-secrets.sh [step]
#   step: 1 (SP secret) | 2 (CogSvc keys) | 3 (APIM keys) | all (default)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV_FILE=".env"
BACKUP_FILE=".env.backup.$(date +%s)"
VENV_PATH=".venv"
ROTATION_STEP="${1:-all}"

# Azure resource details
TENANT_ID="e7267256-e58d-4679-bed0-3f3ef087a222"
CLIENT_ID="e2148609-e5d2-48d8-9a73-d814702552fd"
RESOURCE_GROUP="rg-example"
RESOURCE_NAME="example-resource"
SUBSCRIPTION_ID="<subscription-id>"

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[✓]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[✗]${NC} $*"; }

# Backup .env
backup_env() {
  log_info "Backing up .env to $BACKUP_FILE"
  cp "$ENV_FILE" "$BACKUP_FILE"
  log_success "Backup created: $BACKUP_FILE"
}

# Update .env variable
update_env_var() {
  local key=$1
  local value=$2
  
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Escape special chars for sed
    local escaped_value=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
    sed -i.bak "s|^${key}=.*|${key}=${escaped_value}|" "$ENV_FILE"
    log_success "Updated $key in .env"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    log_success "Added $key to .env"
  fi
}

# Prerequisites check
check_prerequisites() {
  log_info "Checking prerequisites..."
  
  local missing=0
  
  if ! command -v az &> /dev/null; then
    log_error "az CLI not found"
    missing=1
  fi
  
  if ! command -v jq &> /dev/null; then
    log_error "jq not found"
    missing=1
  fi
  
  if ! command -v curl &> /dev/null; then
    log_error "curl not found"
    missing=1
  fi
  
  if [ ! -f "$ENV_FILE" ]; then
    log_error ".env file not found at $ENV_FILE"
    missing=1
  fi
  
  if [ $missing -eq 1 ]; then
    log_error "Missing prerequisites. Install az CLI, jq, and curl."
    return 1
  fi
  
  log_success "All prerequisites found"
  return 0
}

# Verify Azure login
check_azure_login() {
  log_info "Checking Azure login status..."
  
  if ! az account show &> /dev/null; then
    log_error "Not logged in to Azure. Run: az login"
    return 1
  fi
  
  local current_sub=$(az account show --query id -o tsv)
  if [ "$current_sub" != "$SUBSCRIPTION_ID" ]; then
    log_warn "Current subscription: $current_sub (expected: $SUBSCRIPTION_ID)"
    log_info "Setting subscription..."
    az account set --subscription "$SUBSCRIPTION_ID"
  fi
  
  log_success "Azure authentication verified"
  return 0
}

# ============================================================================
# STEP 1: Rotate SP Secret
# ============================================================================
rotate_sp_secret() {
  log_info "=========================================="
  log_info "STEP 1: Rotating Service Principal Secret"
  log_info "=========================================="
  
  # Regenerate SP credential
  log_info "Regenerating SP credential via Azure AD..."
  local sp_response=$(az ad app credential reset --id "$CLIENT_ID" 2>&1)
  
  if [ $? -ne 0 ]; then
    log_error "Failed to regenerate SP secret"
    echo "$sp_response"
    return 1
  fi
  
  # Filter out WARNING line and extract password
  local new_secret=$(echo "$sp_response" | grep -v '^WARNING:' | jq -r '.password')
  
  if [ -z "$new_secret" ] || [ "$new_secret" = "null" ]; then
    log_error "Failed to extract new SP secret"
    return 1
  fi
  
  log_success "New SP secret generated"
  
  # Update .env
  update_env_var "AZURE_CLIENT_SECRET" "$new_secret"
  
  # Azure AD propagation delay required
  log_info "Waiting for Azure AD to propagate the new secret... (60 seconds)"
  for i in {60..1}; do
    printf "."
    sleep 1
  done
  echo ""
  
  # Test the new secret
  log_info "Testing new SP secret..."
  
  if [ ! -d "$VENV_PATH" ]; then
    log_error "Virtual environment not found at $VENV_PATH"
    log_info "Creating venv..."
    python3 -m venv "$VENV_PATH"
  fi
  
  source "$VENV_PATH/bin/activate"
  
  # Check if azure-identity is installed
  if ! python3 -c "import azure.identity" 2>/dev/null; then
    log_warn "azure-identity not installed, installing..."
    pip install -q azure-identity azure-ai-projects
  fi
  
  python3 << PYEOF
import sys
from azure.identity import ClientSecretCredential

try:
    cred = ClientSecretCredential(
        tenant_id="$TENANT_ID",
        client_id="$CLIENT_ID",
        client_secret="$new_secret",
    )
    # Force token acquisition to validate secret
    token = cred.get_token("https://management.azure.com/.default")
    print("✅ SP secret validated")
    sys.exit(0)
except Exception as e:
    print(f"❌ SP secret validation failed: {e}")
    sys.exit(1)
PYEOF
  
  if [ $? -ne 0 ]; then
    log_error "SP secret test failed"
    return 1
  fi
  
  log_success "SP secret rotation completed and verified"
  return 0
}

# ============================================================================
# STEP 2: Rotate Cognitive Services Keys
# ============================================================================
rotate_cogsvc_keys() {
  log_info "=========================================="
  log_info "STEP 2: Rotating Cognitive Services Keys"
  log_info "=========================================="
  
  # Regenerate key1
  log_info "Regenerating Cognitive Services key1..."
  local keys_response=$(az cognitiveservices account keys regenerate \
    --resource-group "$RESOURCE_GROUP" \
    --name "$RESOURCE_NAME" \
    --key-name key1 2>&1)
  
  if [ $? -ne 0 ]; then
    log_error "Failed to regenerate key1"
    echo "$keys_response"
    return 1
  fi
  
  local new_key1=$(echo "$keys_response" | jq -r '.key1')
  local new_key2=$(echo "$keys_response" | jq -r '.key2')
  
  if [ -z "$new_key1" ] || [ "$new_key1" = "null" ]; then
    log_error "Failed to extract new key1"
    return 1
  fi
  
  log_success "New key1 generated"
  
  # Azure propagation delay required for newly rotated keys
  log_info "Waiting for Azure to propagate the new key... (45 seconds)"
  for i in {45..1}; do
    printf "."
    sleep 1
  done
  echo ""
  
  # Test the new key
  log_info "Testing new API key..."
  
  local test_response=$(curl -s -X POST \
    "https://${RESOURCE_NAME}.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-02-15-preview" \
    -H "api-key: $new_key1" \
    -H "Content-Type: application/json" \
    -d '{
      "messages": [{"role": "user", "content": "Test"}],
      "max_completion_tokens": 50
    }' 2>&1)
  
  if echo "$test_response" | jq -e '.choices[0].message.content' &> /dev/null; then
    log_success "API key test passed"
  else
    log_error "API key test failed"
    echo "$test_response" | jq '.' 2>/dev/null || echo "$test_response"
    return 1
  fi
  
  # Update .env with new key1
  update_env_var "KAIF_FOUNDRY_API_KEY" "$new_key1"
  
  # Now regenerate key2 to fully rotate
  log_info "Regenerating Cognitive Services key2 (full rotation)..."
  local keys_response2=$(az cognitiveservices account keys regenerate \
    --resource-group "$RESOURCE_GROUP" \
    --name "$RESOURCE_NAME" \
    --key-name key2 2>&1)
  
  if [ $? -ne 0 ]; then
    log_error "Failed to regenerate key2"
    echo "$keys_response2"
    return 1
  fi
  
  # Extract new key2 from the response
  local new_key2_updated=$(echo "$keys_response2" | jq -r '.key2')
  
  if [ -z "$new_key2_updated" ] || [ "$new_key2_updated" = "null" ]; then
    log_error "Failed to extract new key2"
    return 1
  fi
  
  # Update .env with new key2 backup
  update_env_var "KAIF_FOUNDRY_API_KEY_2" "$new_key2_updated"
  
  log_success "Both Cognitive Services keys rotated"
  return 0
}

# ============================================================================
# STEP 3: Rotate APIM Subscription Keys
# ============================================================================
rotate_apim_keys() {
  log_info "=========================================="
  log_info "STEP 3: Rotating APIM Subscription Keys"
  log_info "=========================================="
  
  log_warn "APIM key rotation must be done via Azure Portal:"
  log_warn "  1. Portal → API Management → kaif-test"
  log_warn "  2. Subscriptions → find your active subscription"
  log_warn "  3. ... → Regenerate primary/secondary keys"
  log_warn "  4. Update KAIF_APIM_SUBSCRIPTION_KEY in .env"
  log_warn ""
  log_info "Manual step required. Press Enter when complete..."
  read -r
  
  return 0
}

# ============================================================================
# Test Foundry Agent Access
# ============================================================================
test_foundry_access() {
  log_info "Testing Foundry project access with new credentials..."
  
  if [ ! -d "$VENV_PATH" ]; then
    log_warn "Venv not found, skipping Foundry test"
    return 0
  fi
  
  source "$VENV_PATH/bin/activate"
  
  python3 << PYEOF
import os
from azure.identity import ClientSecretCredential
from azure.ai.projects import AIProjectClient

try:
    cred = ClientSecretCredential(
        tenant_id=os.environ.get("AZURE_TENANT_ID", "$TENANT_ID"),
        client_id=os.environ.get("AZURE_CLIENT_ID", "$CLIENT_ID"),
        client_secret=os.environ.get("AZURE_CLIENT_SECRET", ""),
    )
    client = AIProjectClient(
        endpoint="https://example-resource.services.ai.azure.com/api/projects/kindred-1882",
        credential=cred,
    )
    response = client.get_openai_client().responses.create(
        model="gpt-5-mini",
        input=[{"role": "user", "content": "Test"}],
        extra_body={"agent_reference": {"name": "BoundaryAgent", "version": "2", "type": "agent_reference"}},
    )
    print("✅ Foundry agent access verified")
except Exception as e:
    print(f"⚠️  Foundry test skipped or failed: {e}")
PYEOF
  
  return 0
}

# ============================================================================
# Main
# ============================================================================
main() {
  local step="${1:-all}"
  
  echo ""
  log_info "KAIF Azure Credential Rotation Script"
  log_info "======================================="
  echo ""
  
  # Prerequisites
  check_prerequisites || exit 1
  check_azure_login || exit 1
  
  # Backup
  backup_env
  
  # Execute steps
  case "$step" in
    1|sp)
      rotate_sp_secret || exit 1
      ;;
    2|cogsvc)
      rotate_cogsvc_keys || exit 1
      ;;
    3|apim)
      rotate_apim_keys || exit 1
      ;;
    all)
      rotate_sp_secret || exit 1
      echo ""
      rotate_cogsvc_keys || exit 1
      echo ""
      rotate_apim_keys || exit 1
      ;;
    *)
      log_error "Unknown step: $step"
      echo "Usage: $0 [1|2|3|all]"
      exit 1
      ;;
  esac
  
  # Final test
  echo ""
  test_foundry_access
  
  # Summary
  echo ""
  log_success "=========================================="
  log_success "Rotation Complete!"
  log_success "=========================================="
  echo ""
  log_info "Updated .env: $ENV_FILE"
  log_info "Backup saved: $BACKUP_FILE"
  echo ""
  log_warn "Next steps:"
  log_warn "  1. Review .env for any manual changes needed"
  log_warn "  2. Test your applications with new credentials"
  log_warn "  3. Delete the old secrets from Azure (if not already rotated)"
  log_warn "  4. Commit the updated .env to secure storage"
  echo ""
}

main "$@"
