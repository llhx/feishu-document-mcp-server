import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface UserTokenBundle {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken?: string
  refreshTokenExpiresAt?: number
  scope: string
}

export interface PendingAuthorization {
  state: string
  authorizationUrl: string
}

export class AuthStorage {
  private readonly keychainService: string
  private readonly fallbackStorePath: string
  private readonly pendingAuthPath: string

  constructor(private readonly appId: string) {
    this.keychainService = `qoder-feishu-document-mcp:${appId || 'unconfigured'}`
    this.fallbackStorePath = join(homedir(), '.config', 'feishu-document-mcp', 'tokens.json')
    this.pendingAuthPath = join(homedir(), '.config', 'feishu-document-mcp', 'pending-auth.json')
  }

  loadTokens(): UserTokenBundle | undefined {
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

  storeTokens(tokens: UserTokenBundle): void {
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

  clearTokens(): void {
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

  storePendingAuthorization(pendingAuthorization: PendingAuthorization): void {
    try {
      mkdirSync(dirname(this.pendingAuthPath), { recursive: true, mode: 0o700 })
      writeFileSync(this.pendingAuthPath, JSON.stringify(pendingAuthorization), { mode: 0o600 })
    } catch {
      // Non-critical: authorization can still work if the callback server stays alive
    }
  }

  loadPendingAuthorization(): PendingAuthorization | undefined {
    try {
      if (!existsSync(this.pendingAuthPath)) return undefined
      return JSON.parse(readFileSync(this.pendingAuthPath, 'utf8')) as PendingAuthorization
    } catch {
      return undefined
    }
  }

  clearPendingAuthorization(): void {
    try {
      if (existsSync(this.pendingAuthPath)) unlinkSync(this.pendingAuthPath)
    } catch {
      // Non-critical
    }
  }
}
