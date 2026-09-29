import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'wiki:node:read',
  'docs:document.media:download',
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
  codeVerifier: string
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
    this.userTokens = this.loadStoredTokens()
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl
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

  async startAuthorization(): Promise<{ authorizationUrl: string; redirectUri: string; scopes: string[] }> {
    this.assertConfigured()

    if (this.pendingAuthorization && this.oauthServer?.listening) {
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

    const state = randomBytes(24).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const authorizationUrl = new URL('/open-apis/authen/v1/authorize', this.accountsBaseUrl)
    authorizationUrl.searchParams.set('client_id', this.appId)
    authorizationUrl.searchParams.set('redirect_uri', this.redirectUri)
    authorizationUrl.searchParams.set('scope', this.scopes.join(' '))
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    this.pendingAuthorization = {
      state,
      codeVerifier,
      authorizationUrl: authorizationUrl.toString(),
    }
    await this.startCallbackServer(redirect)

    return {
      authorizationUrl: authorizationUrl.toString(),
      redirectUri: this.redirectUri,
      scopes: this.scopes,
    }
  }

  private assertConfigured(): void {
    if (!this.appId || !this.appSecret) {
      throw new Error('Missing APP_ID/APP_SECRET (or FEISHU_APP_ID/FEISHU_APP_SECRET) in the MCP environment')
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

  private async startCallbackServer(redirect: URL): Promise<void> {
    if (this.oauthServer?.listening) return

    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    const callbackPath = redirect.pathname

    this.oauthServer = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', this.redirectUri)
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

        const tokens = await this.exchangeAuthorizationCode(code, this.pendingAuthorization.codeVerifier)
        this.userTokens = tokens
        this.storeTokens(tokens)
        this.pendingAuthorization = undefined
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

  private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<UserTokenBundle> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.appId,
      client_secret: this.appSecret,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
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
}
