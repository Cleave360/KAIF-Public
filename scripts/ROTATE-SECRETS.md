# Azure Credential Rotation Script

Systematic rotation of all KAIF Azure secrets with verification.

## What it rotates

1. **Service Principal secret** (`AZURE_CLIENT_SECRET`) — ⏱️ ~2 min
2. **Cognitive Services API keys** (key1 + key2) — ⏱️ ~3 min  
3. **APIM subscription keys** (manual) — ⏱️ ~2 min
4. **Tests all credentials** after each rotation — ⏱️ included

**Total time: ~10 minutes**

## Prerequisites

```bash
# Check you have these installed
az --version          # Azure CLI
jq --version          # JSON processor
curl --version        # HTTP client

# And Python/venv
python3 --version
which python3
```

If any are missing, install:
```bash
# macOS
brew install azure-cli jq

# Linux (Ubuntu/Debian)
sudo apt-get install azure-cli jq
```

## Quick Start

### Rotate everything (recommended)

```bash
cd /Users/geofflundholm/Documents/KAIF
./scripts/rotate-secrets.sh all
```

This will:
1. ✅ Regenerate SP secret → test immediately
2. ✅ Regenerate Cognitive Services key1 + key2 → test
3. ⚠️ Walk you through APIM key rotation (manual step)
4. ✅ Test Foundry agent access with new credentials
5. ✅ Save backup of old `.env` as `.env.backup.<timestamp>`

### Rotate one step at a time

If you want to rotate in stages:

```bash
# Step 1: SP secret only
./scripts/rotate-secrets.sh 1

# Step 2: Cognitive Services keys only
./scripts/rotate-secrets.sh 2

# Step 3: APIM keys (manual step)
./scripts/rotate-secrets.sh 3
```

## What happens

### Each step does:

1. **Regenerate the credential** via Azure CLI/Portal
2. **Update `.env`** with the new secret
3. **Test the new credential** (immediate verification)
4. **Backup the old `.env`** before making changes

### Output example

```
[INFO] ==========================================
[INFO] STEP 1: Rotating Service Principal Secret
[INFO] ==========================================
[INFO] Regenerating SP credential via Azure AD...
[✓] New SP secret generated
[✓] Updated AZURE_CLIENT_SECRET in .env
[INFO] Testing new SP secret...
[✓] SP secret validated
[✓] SP secret rotation completed and verified

[INFO] ==========================================
[INFO] STEP 2: Rotating Cognitive Services Keys
[INFO] ==========================================
[INFO] Regenerating Cognitive Services key1...
[✓] New key1 generated
[INFO] Testing new API key...
[✓] API key test passed
[INFO] Regenerating Cognitive Services key2 (full rotation)...
[✓] Both Cognitive Services keys rotated

[✓] Rotation Complete!
[INFO] Updated .env: .env
[INFO] Backup saved: .env.backup.1720542600
```

## APIM Keys (Manual Step)

When the script reaches Step 3, it will pause and guide you:

```
[WARN] APIM key rotation must be done via Azure Portal:
[WARN]   1. Portal → API Management → kaif-test
[WARN]   2. Subscriptions → find your active subscription
[WARN]   3. ... → Regenerate primary/secondary keys
[WARN]   4. Update KAIF_APIM_SUBSCRIPTION_KEY in .env
[INFO] Manual step required. Press Enter when complete...
```

### To rotate APIM keys:

1. Open Azure Portal
2. Go to **API Management** → **kaif-test**
3. **Subscriptions** tab
4. Find your active subscription (probably "default" or matches your user)
5. Click **...** menu → **Regenerate primary key**
6. Copy the new key
7. In `.env`, update: `KAIF_APIM_SUBSCRIPTION_KEY=<new_key>`
8. Also regenerate secondary key and save to `KAIF_APIM_SUBSCRIPTION_KEY_2`
9. Return to the script and press Enter

## Backups

The script automatically backs up your `.env` before making changes:

```bash
# List all backups
ls -lh .env.backup.*

# Restore if needed
cp .env.backup.1720542600 .env
```

## If something goes wrong

### "SP secret test failed"

The new secret is invalid. Check:
1. SP exists: `az ad sp list --display-name kaif-foundry-sp`
2. Recent regeneration in Azure AD history
3. Run `az login` again to refresh token

### "API key test failed"

The new key isn't working. Check:
1. Resource exists: `az cognitiveservices account show --resource-group rg-example --name example-resource`
2. Key was actually regenerated (check portal)
3. Wait 30 seconds and retry (keys can take time to propagate)

### "Not logged in to Azure"

Run:
```bash
az login
az account set --subscription <subscription-id>
```

## After rotation

✅ **Do this:**
1. Review the new `.env` file
2. Test your KAIF server: `docker-compose up -d`
3. Run smoke tests: `npx tsx scripts/smoke.ts`
4. Delete old credentials from Azure (they're already invalidated)
5. Store `.env` securely (don't commit to Git)

❌ **Don't:**
1. Keep old credentials lying around
2. Commit `.env` with secrets to Git
3. Share the backup files
4. Forget to update `.env` in production deployments

## Troubleshooting commands

```bash
# Check current SP
az ad sp show --id e2148609-e5d2-48d8-9a73-d814702552fd

# List current SP credentials
az ad app credential list --id e2148609-e5d2-48d8-9a73-d814702552fd

# Check Cognitive Services account
az cognitiveservices account show --resource-group rg-example --name example-resource

# Check current keys (without regenerating)
az cognitiveservices account keys list --resource-group rg-example --name example-resource

# Verify Azure subscription
az account show
az account list --output table
```

---

**Questions?** Check `azure_steps.md` for detailed API testing procedures or re-run with `--help` (when implemented).
