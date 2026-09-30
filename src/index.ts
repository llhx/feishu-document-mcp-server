#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AuthManager } from './auth/auth.js'
import { registerAuthTools } from './auth/auth-tools.js'
import { registerDocumentTools } from './document/document-tools.js'
import { FeishuClient } from './document/feishu.js'

const auth = new AuthManager()
const feishu = new FeishuClient(auth)
const server = new McpServer({
  name: 'feishu-document-reader',
  version: '1.0.0',
})

registerAuthTools(server, auth)

registerDocumentTools(server, auth, feishu)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Feishu document reader MCP is running on stdio')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
