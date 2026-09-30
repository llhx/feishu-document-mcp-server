import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'wiki:node:read',
  'sheets:spreadsheet:readonly',
  'bitable:app:readonly',
  'drive:drive:readonly',
  'docs:document.media:download',
]

/** Fallback scopes used when the full list fails due to an unenabled scope in the app */
const FALLBACK_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'wiki:node:read',
  'sheets:spreadsheet:readonly',
  'bitable:app:readonly',
  'drive:drive:readonly',
]

interface UserTokenBundle {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken?: string
  refreshTokenExpiresAt?: number
  scope: string
}

interface OAuthTokenResponse {
  code?: number
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface TenantTokenResponse {
  code: number
  msg: string
  tenant_access_token?: string
  expire?: number
}

interface PendingAuthorization {
  state: string
  authorizationUrl: string
}

export interface AuthStatus {
  appConfigured: boolean
  userAuthenticated: boolean
  userTokenExpiresAt?: string
  refreshTokenExpiresAt?: string
  scope?: string
  tenantTokenAvailable: boolean
  redirectUri: string
  requiredScopes: string[]
}

export class AuthManager {
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBaseUrl: string
  private readonly accountsBaseUrl: string
  private readonly redirectUri: string
  private readonly scopes: string[]
  private readonly keychainService: string
  private readonly fallbackStorePath: string
  private readonly pendingAuthPath: string
  private userTokens?: UserTokenBundle
  private tenantToken?: { value: string; expiresAt: number }
  private oauthServer?: Server
  private pendingAuthorization?: PendingAuthorization

  constructor() {
    this.appId = process.env.FEISHU_APP_ID ?? process.env.APP_ID ?? ''
    this.appSecret = process.env.FEISHU_APP_SECRET ?? process.env.APP_SECRET ?? ''
    this.apiBaseUrl = (process.env.FEISHU_API_BASE_URL ?? process.env.LARK_DOMAIN ?? 'https://open.feishu.cn').replace(/\/$/, '')
    this.accountsBaseUrl = process.env.FEISHU_ACCOUNTS_BASE_URL ?? 'https://accounts.feishu.cn'
    this.redirectUri = process.env.FEISHU_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/callback'
    this.scopes = (process.env.FEISHU_READONLY_SCOPES?.split(/[ ,]+/) ?? DEFAULT_SCOPES).filter(Boolean)
    this.keychainService = `qoder-feishu-document-mcp:${this.appId || 'unconfigured'}`
    this.fallbackStorePath = join(homedir(), '.config', 'feishu-document-mcp', 'tokens.json')
    this.pendingAuthPath = join(homedir(), '.config', 'feishu-document-mcp', 'pending-auth.json')
    this.userTokens = this.loadStoredTokens()
    this.pendingAuthorization = this.loadPendingAuthorization()
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl
  }

  isUserAuthenticated(): boolean {
    const envUserToken = process.env.FEISHU_USER_ACCESS_TOKEN
    if (envUserToken) return true
    const tokens = this.userTokens ?? this.loadStoredTokens()
    if (!tokens?.accessToken) return false
    if (tokens.accessTokenExpiresAt > Date.now() + 60_000) return true
    return Boolean(tokens.refreshToken)
  }

  async getStatus(): Promise<AuthStatus> {
    const userTokens = this.userTokens ?? this.loadStoredTokens()
    return {
      appConfigured: Boolean(this.appId && this.appSecret),
      userAuthenticated: Boolean(process.env.FEISHU_USER_ACCESS_TOKEN || userTokens?.accessToken),
      userTokenExpiresAt: userTokens ? new Date(userTokens.accessTokenExpiresAt).toISOString() : undefined,
      refreshTokenExpiresAt: userTokens?.refreshTokenExpiresAt
        ? new Date(userTokens.refreshTokenExpiresAt).toISOString()
        : undefined,
      scope: userTokens?.scope,
      tenantTokenAvailable: Boolean(this.appId && this.appSecret),
      redirectUri: this.redirectUri,
      requiredScopes: this.scopes,
    }
  }

  async getAccessToken(): Promise<{ token: string; identity: 'user' | 'tenant' }> {
    const envUserToken = process.env.FEISHU_USER_ACCESS_TOKEN
    if (envUserToken) return { token: envUserToken, identity: 'user' }

    this.userTokens ??= this.loadStoredTokens()
    if (this.userTokens) {
      if (this.userTokens.accessTokenExpiresAt > Date.now() + 60_000) {
        return { token: this.userTokens.accessToken, identity: 'user' }
      }
      if (this.userTokens.refreshToken) {
        this.userTokens = await this.refreshUserToken(this.userTokens.refreshToken)
        this.storeTokens(this.userTokens)
        return { token: this.userTokens.accessToken, identity: 'user' }
      }
    }

    return { token: await this.getTenantAccessToken(), identity: 'tenant' }
  }

  async startAuthorization(): Promise<{ authorizationUrl: string; redirectUri: string; scopes: string[]; droppedScopes?: string[] }> {
    this.assertConfigured()

    // Resume persisted authorization from a previous process
    if (this.pendingAuthorization) {
      await this.ensureCallbackServer()
      return {
        authorizationUrl: this.pendingAuthorization.authorizationUrl,
        redirectUri: this.redirectUri,
        scopes: this.scopes,
      }
    }

    const redirect = new URL(this.redirectUri)
    if (!['localhost', '127.0.0.1'].includes(redirect.hostname)) {
      throw new Error('FEISHU_OAUTH_REDIRECT_URI must use localhost or 127.0.0.1 for this local MCP server')
    }

    // Pre-validate scopes against the app's enabled permissions
    const { scopes: activeScopes, droppedScopes } = await this.resolveActiveScopes()

    const state = randomBytes(24).toString('base64url')
    const authorizationUrl = new URL('/open-apis/authen/v1/authorize', this.accountsBaseUrl)
    authorizationUrl.searchParams.set('client_id', this.appId)
    authorizationUrl.searchParams.set('redirect_uri', this.redirectUri)
    authorizationUrl.searchParams.set('scope', activeScopes.join(' '))
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('response_type', 'code')

    this.pendingAuthorization = {
      state,
      authorizationUrl: authorizationUrl.toString(),
    }
    this.persistPendingAuthorization()
    await this.startCallbackServer(redirect)

    const result: { authorizationUrl: string; redirectUri: string; scopes: string[]; droppedScopes?: string[] } = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUri: this.redirectUri,
      scopes: activeScopes,
    }
    if (droppedScopes.length) result.droppedScopes = droppedScopes
    return result
  }

  private assertConfigured(): void {
    if (!this.appId || !this.appSecret) {
      throw new Error('Missing APP_ID/APP_SECRET (or FEISHU_APP_ID/FEISHU_APP_SECRET) in the MCP environment')
    }
  }

  /**
   * Check which of the requested scopes are actually enabled in the Feishu app.
   * Returns the active scopes and any that were dropped because they are not enabled.
   * Falls back to the full scope list if the check API is unavailable.
   */
  private async resolveActiveScopes(): Promise<{ scopes: string[]; droppedScopes: string[] }> {
    try {
      const tenantToken = await this.getTenantAccessToken()
      const response = await fetch(
        `${this.apiBaseUrl}/open-apis/application/v6/applications/${encodeURIComponent(this.appId)}/available_scopes`,
        { headers: { Authorization: `Bearer ${tenantToken}` } },
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { code?: number; data?: { available_scopes?: Array<{ scope?: string }> } }
      if (payload.code !== 0 || !payload.data?.available_scopes) {
        return { scopes: this.scopes, droppedScopes: [] }
      }
      const enabledScopes = new Set(payload.data.available_scopes.map((s) => s.scope).filter(Boolean))
      const activeScopes = this.scopes.filter((scope) => enabledScopes.has(scope))
      const droppedScopes = this.scopes.filter((scope) => !enabledScopes.has(scope))
      return { scopes: activeScopes.length ? activeScopes : this.scopes, droppedScopes }
    } catch {
      // API check failed — use the full scope list and let the authorization page handle validation
      return { scopes: this.scopes, droppedScopes: [] }
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    this.assertConfigured()
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) {
      return this.tenantToken.value
    }

    const response = await fetch(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const payload = (await response.json()) as TenantTokenResponse
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Unable to obtain tenant access token: ${payload.msg || response.statusText}`)
    }

    this.tenantToken = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + (payload.expire ?? 7200) * 1000,
    }
    return this.tenantToken.value
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.oauthServer?.listening) return

    const redirect = new URL(this.redirectUri)
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))

    // Check if another process already owns the callback port
    try {
      const probe = await fetch(this.redirectUri.replace('/callback', '/__health__'), { method: 'GET', signal: AbortSignal.timeout(2000) })
      if (probe.ok || probe.status === 404) {
        // Another process is serving this port — it will handle the callback
        return
      }
    } catch {
      // Port is free, start our own callback server
    }

    await this.startCallbackServer(redirect)
  }

  private async startCallbackServer(redirect: URL): Promise<void> {
    if (this.oauthServer?.listening) return

    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    const callbackPath = redirect.pathname

    this.oauthServer = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', this.redirectUri)
        if (requestUrl.pathname === '/__health__') {
          response.writeHead(200).end('ok')
          return
        }
        if (requestUrl.pathname !== callbackPath) {
          response.writeHead(404).end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        const code = requestUrl.searchParams.get('code')
        const state = requestUrl.searchParams.get('state')
        if (error) throw new Error(`Authorization was rejected: ${error}`)
        if (!code || !state || !this.pendingAuthorization) throw new Error('Missing OAuth code or state')

        const expectedState = Buffer.from(this.pendingAuthorization.state)
        const receivedState = Buffer.from(state)
        if (expectedState.length !== receivedState.length || !timingSafeEqual(expectedState, receivedState)) {
          throw new Error('OAuth state mismatch')
        }

        const tokens = await this.exchangeAuthorizationCode(code)
        this.userTokens = tokens
        this.storeTokens(tokens)
        this.clearPendingAuthorization()
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><meta charset="utf-8"><title>Feishu authorized</title><h1>Authorization complete</h1><p>You can close this window and return to Qoder.</p>')
        this.stopCallbackServer()
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(error instanceof Error ? error.message : String(error))
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.oauthServer!.once('error', reject)
      this.oauthServer!.listen(port, redirect.hostname, () => resolve())
    })
  }

  private stopCallbackServer(): void {
    const server = this.oauthServer
    this.oauthServer = undefined
    if (server?.listening) server.close()
  }

  private async exchangeAuthorizationCode(code: string): Promise<UserTokenBundle> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.appId,
      client_secret: this.appSecret,
      code,
      redirect_uri: this.redirectUri,
    })
    return this.requestUserTokens(body)
  }

  private async refreshUserToken(refreshToken: string): Promise<UserTokenBundle> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      refresh_token: refreshToken,
    })
    return this.requestUserTokens(body)
  }

  private async requestUserTokens(body: URLSearchParams): Promise<UserTokenBundle> {
    const response = await fetch(`${this.accountsBaseUrl}/oauth/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const payload = (await response.json()) as OAuthTokenResponse
    if (!response.ok || payload.code !== 0 || !payload.access_token || !payload.expires_in) {
      throw new Error(payload.error_description || payload.error || `OAuth token request failed (${response.status})`)
    }

    return {
      accessToken: payload.access_token,
      accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
      refreshToken: payload.refresh_token,
      refreshTokenExpiresAt: payload.refresh_token_expires_in
        ? Date.now() + payload.refresh_token_expires_in * 1000
        : undefined,
      scope: payload.scope ?? '',
    }
  }

  private loadStoredTokens(): UserTokenBundle | undefined {
    try {
      if (process.platform === 'darwin') {
        const value = execFileSync('security', [
          'find-generic-password',
          '-a',
          this.appId,
          '-s',
          this.keychainService,
          '-w',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return value ? JSON.parse(value) as UserTokenBundle : undefined
      }

      return JSON.parse(readFileSync(this.fallbackStorePath, 'utf8')) as UserTokenBundle
    } catch {
      return undefined
    }
  }

  private storeTokens(tokens: UserTokenBundle): void {
    const value = JSON.stringify(tokens)
    if (process.platform === 'darwin') {
      execFileSync('security', [
        'add-generic-password',
        '-U',
        '-a',
        this.appId,
        '-s',
        this.keychainService,
        '-w',
        value,
      ], { stdio: ['ignore', 'ignore', 'ignore'] })
      return
    }

    mkdirSync(dirname(this.fallbackStorePath), { recursive: true, mode: 0o700 })
    writeFileSync(this.fallbackStorePath, value, { mode: 0o600 })
    chmodSync(this.fallbackStorePath, 0o600)
  }

  clearStoredTokens(): void {
    this.userTokens = undefined
    this.tenantToken = undefined
    if (process.platform === 'darwin') {
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-a',
          this.appId,
          '-s',
          this.keychainService,
        ], { stdio: ['ignore', 'ignore', 'ignore'] })
      } catch {
        // Token may not exist — ignore
      }
      return
    }

    try {
      if (existsSync(this.fallbackStorePath)) unlinkSync(this.fallbackStorePath)
    } catch {
      // Ignore
    }
  }

  private persistPendingAuthorization(): void {
    if (!this.pendingAuthorization) return
    try {
      mkdirSync(dirname(this.pendingAuthPath), { recursive: true, mode: 0o700 })
      writeFileSync(this.pendingAuthPath, JSON.stringify(this.pendingAuthorization), { mode: 0o600 })
    } catch {
      // Non-critical: authorization can still work if the callback server stays alive
    }
  }

  private loadPendingAuthorization(): PendingAuthorization | undefined {
    try {
      if (!existsSync(this.pendingAuthPath)) return undefined
      return JSON.parse(readFileSync(this.pendingAuthPath, 'utf8')) as PendingAuthorization
    } catch {
      return undefined
    }
  }

  private clearPendingAuthorization(): void {
    this.pendingAuthorization = undefined
    try {
      if (existsSync(this.pendingAuthPath)) unlinkSync(this.pendingAuthPath)
    } catch {
      // Non-critical
    }
  }
}
