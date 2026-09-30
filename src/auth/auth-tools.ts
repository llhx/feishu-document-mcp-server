import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthManager } from './auth.js'
import { errorResult, readOnlyAnnotations, textResult } from '../shared/mcp-results.js'

export function registerAuthTools(server: McpServer, auth: AuthManager): void {
  server.registerTool(
    'feishu_auth_status',
    {
      title: 'Feishu authorization status',
      description: 'Check whether the local MCP has an authorized Feishu user token. Never returns token values.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const status = await auth.getStatus()
        return textResult(JSON.stringify(status, null, 2))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'feishu_start_readonly_authorization',
    {
      title: 'Authorize read-only Feishu access',
      description: 'Start official Feishu OAuth for read-only document, Wiki node, and document-media access. Returns a browser URL. Tokens are stored in the macOS Keychain and refreshed automatically.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const authorization = await auth.startAuthorization()
        return textResult(formatAuthorizationResult('Open this Feishu authorization URL in a browser:', authorization))
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'feishu_reset_authorization',
    {
      title: 'Reset Feishu authorization and re-authorize',
      description: 'Clear the stored user OAuth token and start a new authorization flow. Use this to switch accounts, refresh scopes, or recover from a broken authorization state. Returns a browser URL for the new authorization.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        auth.clearStoredTokens()
        const authorization = await auth.startAuthorization()
        return textResult(formatAuthorizationResult('Stored user token has been cleared. Open this Feishu authorization URL in a browser:', authorization))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
}

export async function requireUserAuth(auth: AuthManager): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean } | null> {
  if (auth.isUserAuthenticated()) return null
  const authorization = await auth.startAuthorization()
  return {
    content: [{
      type: 'text' as const,
      text: [
        'No user OAuth token found. Please complete authorization first.',
        '',
        'Open this URL in your browser:',
        authorization.authorizationUrl,
        '',
        `Redirect URI: ${authorization.redirectUri}`,
        '',
        'After the browser shows "Authorization complete", retry this operation.',
      ].join('\n'),
    }],
    isError: true,
  }
}

function formatAuthorizationResult(
  intro: string,
  authorization: { authorizationUrl: string; redirectUri: string; scopes: string[]; droppedScopes?: string[] },
): string {
  const lines = [
    intro,
    authorization.authorizationUrl,
    '',
    `Redirect URI configured by this MCP: ${authorization.redirectUri}`,
    `Requested read-only scopes: ${authorization.scopes.join(' ')}`,
  ]
  if (authorization.droppedScopes?.length) {
    lines.push('', `Scopes skipped (not enabled in the app): ${authorization.droppedScopes.join(' ')}`)
    lines.push('Enable them in the Feishu app console and re-authorize to gain access.')
  }
  lines.push('', 'After the browser reports success, call feishu_auth_status or feishu_read_document.')
  return lines.join('\n')
}
