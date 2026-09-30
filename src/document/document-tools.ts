import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AuthManager } from '../auth/auth.js'
import { requireUserAuth } from '../auth/auth-tools.js'
import type { FeishuClient } from './feishu.js'
import { MAX_MEDIA_BYTES } from '../shared/limits.js'
import { errorMessage, errorResult, readOnlyAnnotations, textResult } from '../shared/mcp-results.js'

const MAX_TEXT_BYTES = 1024 * 1024

export function registerDocumentTools(server: McpServer, auth: AuthManager, feishu: FeishuClient): void {
  server.registerTool(
    'feishu_read_document',
    {
      title: 'Read a Feishu document, spreadsheet, bitable, or file metadata',
      description: 'Read Feishu content as text: Docx documents (text blocks + optional embedded images), legacy Doc (plain text), spreadsheets (markdown tables), bitable apps (record tables), mindnotes (outline), and Wiki file nodes (metadata only; use feishu_get_file for content). Automatically triggers OAuth authorization if no user token is available. This tool is strictly read-only.',
      inputSchema: {
        source: z.string().min(1).describe('Feishu URL (/wiki/, /docx/, /doc/, /sheets/, /base/, /file/, /mindnotes/) or a document token'),
        sourceType: z.enum(['auto', 'wiki', 'docx', 'doc', 'sheet', 'bitable', 'mindnote', 'file']).default('auto').describe('Token type when source is not a URL; bare tokens default to docx'),
        includeImages: z.boolean().default(true).describe('Return embedded document images as MCP image content (Docx only)'),
        maxImages: z.number().int().min(0).max(50).default(20).describe('Maximum embedded images returned in one call (Docx only)'),
        maxRows: z.number().int().min(1).max(5000).default(500).describe('Maximum rows rendered per sheet (spreadsheet sources)'),
        maxRecords: z.number().int().min(1).max(1000).default(200).describe('Maximum records rendered per table (bitable sources)'),
        includeRawBlocks: z.boolean().default(false).describe('Append raw Docx block JSON for complete structural analysis (Docx only)'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ source, sourceType, includeImages, maxImages, maxRows, maxRecords, includeRawBlocks }) => {
      try {
        const authRequired = await requireUserAuth(auth)
        if (authRequired) return authRequired

        const result = await feishu.readDocument(source, sourceType, { maxRows, maxRecords })
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

        const headerLines = [
          `Title: ${result.document.title ?? '(untitled)'}`,
          `Document type: ${result.document.documentType}`,
          `Document token: ${result.document.documentId}`,
        ]
        if (result.document.documentType === 'docx') {
          headerLines.push(`Block count: ${result.blocks.length}`, `Image count: ${result.images.length}`)
        }
        if (result.file) {
          headerLines.push(`File name: ${result.file.name ?? '(unknown)'}`, `File token: ${result.file.token}`)
        }

        const bodyLines = [
          ...headerLines,
          '',
          'Document content:',
          result.text || '(No text content)',
        ]
        if (result.document.documentType === 'docx') {
          bodyLines.push('', 'Image manifest:', JSON.stringify(imageManifest, null, 2))
        }
        if (result.file) {
          bodyLines.push('', 'Note: binary drive file. Call feishu_get_file with the file token to read its content (text-like files return text, images return image content, other binaries return base64).')
        }

        let text = bodyLines.join('\n')

        if (includeRawBlocks && result.blocks.length) {
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
            if (media.data.byteLength > MAX_MEDIA_BYTES) {
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
      description: 'Fetch one image from a document by the media token returned by feishu_read_document. Automatically triggers OAuth authorization if no user token is available.',
      inputSchema: {
        token: z.string().min(1).describe('Image token from the document image manifest'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ token }) => {
      try {
        const authRequired = await requireUserAuth(auth)
        if (authRequired) return authRequired
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

  server.registerTool(
    'feishu_get_file',
    {
      title: 'Read one Feishu drive file',
      description: 'Fetch one drive file by token: text-like files return text content, images return image content, other binaries return base64 text (capped at 10 MB). Use the file token reported by feishu_read_document for Wiki file nodes. Automatically triggers OAuth authorization if no user token is available.',
      inputSchema: {
        token: z.string().min(1).describe('Feishu drive file token'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ token }) => {
      try {
        const authRequired = await requireUserAuth(auth)
        if (authRequired) return authRequired
        const media = await feishu.downloadMedia(token)
        const header = `File token: ${token}\nMIME type: ${media.mimeType}\nSize: ${media.data.byteLength} bytes`

        if (media.mimeType.startsWith('image/')) {
          if (media.data.byteLength > MAX_MEDIA_BYTES) {
            return errorResult(new Error(`${header}\nThe image exceeds the ${MAX_MEDIA_BYTES} byte MCP response limit`))
          }
          return {
            content: [{ type: 'image' as const, data: media.data.toString('base64'), mimeType: media.mimeType }],
          }
        }

        if (isTextLikeMedia(media.mimeType, media.data)) {
          const truncated = media.data.byteLength > MAX_TEXT_BYTES
          const text = media.data.subarray(0, MAX_TEXT_BYTES).toString('utf8')
          return textResult(truncated
            ? `${header}\n\nFile content (truncated to ${MAX_TEXT_BYTES} bytes):\n${text}`
            : `${header}\n\nFile content:\n${text}`)
        }

        if (media.data.byteLength > MAX_MEDIA_BYTES) {
          return errorResult(new Error(`${header}\nThe file exceeds the ${MAX_MEDIA_BYTES} byte MCP response limit and cannot be returned as base64`))
        }
        return textResult(`${header}\n\nBase64 content:\n${media.data.toString('base64')}`)
      } catch (error) {
        return errorResult(error)
      }
    },
  )
}

function isTextLikeMedia(mimeType: string, data: Buffer): boolean {
  const mimeTextLike = mimeType.startsWith('text/')
    || /json|xml|javascript|csv|yaml|markdown|sql|html/.test(mimeType)
  return mimeTextLike && looksLikeUtf8Text(data)
}

function looksLikeUtf8Text(data: Buffer): boolean {
  const sample = data.subarray(0, 4096)
  if (!sample.length) return true
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0 || byte < 0x09 || (byte >= 0x0e && byte < 0x20)) suspicious += 1
  }
  return suspicious / sample.length < 0.02
}
