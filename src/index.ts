#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AuthManager } from './auth.js'
import { FeishuClient } from './feishu.js'

const auth = new AuthManager()
const feishu = new FeishuClient(auth)
const server = new McpServer({
  name: 'feishu-document-reader',
  version: '1.0.0',
})

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

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
      return textResult([
        'Open this Feishu authorization URL in a browser:',
        authorization.authorizationUrl,
        '',
        `Redirect URI configured by this MCP: ${authorization.redirectUri}`,
        `Requested read-only scopes: ${authorization.scopes.join(' ')}`,
        '',
        'After the browser reports success, call feishu_auth_status or feishu_read_document.',
      ].join('\n'))
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.registerTool(
  'feishu_read_document',
  {
    title: 'Read a Feishu document with images',
    description: 'Read all text blocks from a Feishu Docx or Wiki URL and optionally return embedded images as MCP image content. This tool is strictly read-only.',
    inputSchema: {
      source: z.string().min(1).describe('Feishu /wiki/... or /docx/... URL, or a document token'),
      sourceType: z.enum(['auto', 'wiki', 'docx']).default('auto').describe('Token type when source is not a URL'),
      includeImages: z.boolean().default(true).describe('Return embedded document images as MCP image content'),
      maxImages: z.number().int().min(0).max(50).default(20).describe('Maximum embedded images returned in one call'),
      includeRawBlocks: z.boolean().default(false).describe('Append raw Docx block JSON for complete structural analysis'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ source, sourceType, includeImages, maxImages, includeRawBlocks }) => {
    try {
      const result = await feishu.readDocument(source, sourceType)
      const imageLimit = includeImages ? Math.min(maxImages, result.images.length) : 0
      const notes: string[] = []
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = []

      const imageManifest = result.images.map((image, index) => ({
        index: index + 1,
        blockId: image.blockId,
        token: image.token,
        width: image.width,
        height: image.height,
      }))

      let text = [
        `Title: ${result.document.title ?? '(untitled)'}`,
        `Document type: ${result.document.documentType}`,
        `Document token: ${result.document.documentId}`,
        `Block count: ${result.blocks.length}`,
        `Image count: ${result.images.length}`,
        '',
        'Document content:',
        result.text || '(No text blocks found)',
        '',
        'Image manifest:',
        JSON.stringify(imageManifest, null, 2),
      ].join('\n')

      if (includeRawBlocks) {
        text += `\n\nRaw Docx blocks:\n${JSON.stringify(result.blocks, null, 2)}`
      }

      content.push({ type: 'text', text })

      for (let index = 0; index < imageLimit; index += 1) {
        const image = result.images[index]
        try {
          const media = await feishu.downloadMedia(image.token)
          if (!media.mimeType.startsWith('image/')) {
            notes.push(`Image ${index + 1} (${image.blockId}) returned non-image MIME type ${media.mimeType}.`)
            continue
          }
          if (media.data.byteLength > 10 * 1024 * 1024) {
            notes.push(`Image ${index + 1} (${image.blockId}) exceeds the 10 MB MCP response limit; use feishu_get_document_image if needed.`)
            continue
          }
          content.push({
            type: 'image',
            data: media.data.toString('base64'),
            mimeType: media.mimeType,
          })
        } catch (error) {
          notes.push(`Image ${index + 1} (${image.blockId}) could not be read: ${errorMessage(error)}`)
        }
      }

      if (result.images.length > imageLimit && includeImages) {
        notes.push(`${result.images.length - imageLimit} image(s) were not embedded because maxImages=${maxImages}.`)
      }
      if (notes.length) content.push({ type: 'text', text: `Image notes:\n- ${notes.join('\n- ')}` })

      return { content }
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.registerTool(
  'feishu_get_document_image',
  {
    title: 'Read one Feishu document image',
    description: 'Fetch one image from a document by the media token returned by feishu_read_document.',
    inputSchema: {
      token: z.string().min(1).describe('Image token from the document image manifest'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ token }) => {
    try {
      const media = await feishu.downloadMedia(token)
      if (!media.mimeType.startsWith('image/')) {
        return errorResult(new Error(`The media token returned ${media.mimeType}, not an image`))
      }
      return {
        content: [{ type: 'image' as const, data: media.data.toString('base64'), mimeType: media.mimeType }],
      }
    } catch (error) {
      return errorResult(error)
    }
  },
)

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: errorMessage(error) }],
    isError: true,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Feishu document reader MCP is running on stdio')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
