import { readFile } from 'fs/promises'

export interface ResolvedKeyMaterial {
  source: 'file' | 'inline' | 'azure_key_vault' | 'ephemeral'
  privatePem?: string
  retainedPublicPems: string[]
}

interface AzureSecretRef {
  name: string
  version?: string
}

interface AzureKeyVaultConfig {
  vaultUrl: string
  privateKeySecret: AzureSecretRef
  retainedKeySecrets: AzureSecretRef[]
}

type AzureSecretResolver = (request: {
  vaultUrl: string
  name: string
  version?: string
}) => Promise<string>

let _azureSecretResolver: AzureSecretResolver | null = null

function parseList(value?: string): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function parseAzureSecretRef(value: string): AzureSecretRef {
  const [name, version] = value.split('@', 2).map((item) => item.trim())
  if (!name) {
    throw new Error('Azure Key Vault secret reference must include a secret name')
  }
  return version ? { name, version } : { name }
}

function getAzureKeyVaultConfig(): AzureKeyVaultConfig | null {
  const vaultUrl = process.env['KAIF_AZURE_KEY_VAULT_URL'] || undefined
  const privateKeySecretName = process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_NAME'] || undefined
  const privateKeySecretVersion = process.env['KAIF_AZURE_PRIVATE_KEY_SECRET_VERSION'] || undefined
  const retainedKeySecrets = parseList(process.env['KAIF_AZURE_RETAINED_KEY_SECRETS'])
    .map(parseAzureSecretRef)

  if (!vaultUrl && !privateKeySecretName && !privateKeySecretVersion && retainedKeySecrets.length === 0) {
    return null
  }

  if (!vaultUrl) {
    throw new Error('KAIF_AZURE_KEY_VAULT_URL is required when using Azure Key Vault key sources')
  }

  if (!privateKeySecretName) {
    throw new Error('KAIF_AZURE_PRIVATE_KEY_SECRET_NAME is required when using Azure Key Vault key sources')
  }

  return {
    vaultUrl,
    privateKeySecret: privateKeySecretVersion
      ? { name: privateKeySecretName, version: privateKeySecretVersion }
      : { name: privateKeySecretName },
    retainedKeySecrets,
  }
}

async function loadPathPems(envName: string): Promise<string[]> {
  const configuredPaths = parseList(process.env[envName])
  return Promise.all(configuredPaths.map((keyPath) => readFile(keyPath, 'utf8')))
}

function loadInlinePems(envName: string): string[] {
  const raw = process.env[envName]
  if (!raw) return []
  return raw.split('\n---\n').map((item) => item.trim()).filter(Boolean)
}

async function loadAzureSecret(request: {
  vaultUrl: string
  name: string
  version?: string
}): Promise<string> {
  if (_azureSecretResolver) {
    return _azureSecretResolver(request)
  }

  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ])

  const client = new SecretClient(request.vaultUrl, new DefaultAzureCredential())
  const secret = await client.getSecret(
    request.name,
    request.version ? { version: request.version } : {}
  )
  if (!secret.value) {
    throw new Error(`Azure Key Vault secret ${request.name} did not contain a value`)
  }
  return secret.value
}

async function loadAzurePems(config: AzureKeyVaultConfig): Promise<ResolvedKeyMaterial> {
  const [privatePem, ...retainedPublicPems] = await Promise.all([
    loadAzureSecret({
      vaultUrl: config.vaultUrl,
      name: config.privateKeySecret.name,
      ...(config.privateKeySecret.version ? { version: config.privateKeySecret.version } : {}),
    }),
    ...config.retainedKeySecrets.map((secret) => loadAzureSecret({
      vaultUrl: config.vaultUrl,
      name: secret.name,
      ...(secret.version ? { version: secret.version } : {}),
    })),
  ])

  return {
    source: 'azure_key_vault',
    privatePem,
    retainedPublicPems,
  }
}

export async function loadConfiguredKeyMaterial(): Promise<ResolvedKeyMaterial> {
  const keyPath = process.env['KAIF_PRIVATE_KEY_PATH'] || undefined
  if (keyPath) {
    return {
      source: 'file',
      privatePem: await readFile(keyPath, 'utf8'),
      retainedPublicPems: [
        ...await loadPathPems('KAIF_RETAINED_KEY_PATHS'),
        ...loadInlinePems('KAIF_RETAINED_KEY_PEMS'),
      ],
    }
  }

  const keyPem = process.env['KAIF_PRIVATE_KEY_PEM'] || undefined
  if (keyPem) {
    return {
      source: 'inline',
      privatePem: keyPem,
      retainedPublicPems: [
        ...await loadPathPems('KAIF_RETAINED_KEY_PATHS'),
        ...loadInlinePems('KAIF_RETAINED_KEY_PEMS'),
      ],
    }
  }

  const azureConfig = getAzureKeyVaultConfig()
  if (azureConfig) {
    const azureMaterial = await loadAzurePems(azureConfig)
    return {
      ...azureMaterial,
      retainedPublicPems: [
        ...await loadPathPems('KAIF_RETAINED_KEY_PATHS'),
        ...loadInlinePems('KAIF_RETAINED_KEY_PEMS'),
        ...azureMaterial.retainedPublicPems,
      ],
    }
  }

  return {
    source: 'ephemeral',
    retainedPublicPems: [],
  }
}

export function _setAzureSecretResolver(resolver: AzureSecretResolver | null): void {
  _azureSecretResolver = resolver
}
