import type { AuthManager } from './auth.js'

interface FeishuEnvelope<T> {
  code: number
  msg: string
  data?: T
}

interface WikiNode {
  obj_token: string
  obj_type: string
  title?: string
}

interface WikiNodeData {
  node?: WikiNode
}

interface BlockListData {
  items?: DocumentBlock[]
  has_more?: boolean
  page_token?: string
}

export interface DocumentBlock {
  block_id: string
  block_type: number
  parent_id?: string
  children?: string[]
  [key: string]: unknown
}

export interface DocumentImage {
  blockId: string
  token: string
  width?: number
  height?: number
}

export interface ResolvedDocument {
  documentId: string
  documentType: string
  title?: string
  sourceToken: string
  sourceType: 'wiki' | 'docx'
}

export interface DocumentContents {
  document: ResolvedDocument
  blocks: DocumentBlock[]
  text: string
  images: DocumentImage[]
}

export interface DownloadedMedia {
  data: Buffer
  mimeType: string
}

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'page',
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  18: 'bitable',
  19: 'callout',
  20: 'chat-card',
  21: 'diagram',
  22: 'divider',
  23: 'file',
  24: 'grid',
  25: 'grid-column',
  26: 'iframe',
  27: 'image',
  28: 'isv',
  29: 'mindnote',
  30: 'sheet',
  31: 'table',
  32: 'table-cell',
  33: 'view',
  34: 'quote-container',
  35: 'task',
  36: 'okr',
  37: 'add-ons',
  38: 'jira',
  39: 'wiki-catalog',
  40: 'board',
}

export class FeishuClient {
  constructor(private readonly auth: AuthManager) {}

  async readDocument(source: string, sourceType: 'auto' | 'wiki' | 'docx' = 'auto'): Promise<DocumentContents> {
    const document = await this.resolveDocument(source, sourceType)
    if (document.documentType !== 'docx') {
      throw new Error(`The resolved Wiki node is ${document.documentType}; this MCP currently reads Docx documents only`)
    }

    const blocks = await this.listAllBlocks(document.documentId)
    const images = this.extractImages(blocks)
    const text = this.renderBlocks(blocks)

    if (!document.title) {
      document.title = this.extractBlockText(blocks[0]) || undefined
    }

    return { document, blocks, text, images }
  }

  async downloadMedia(token: string): Promise<DownloadedMedia> {
    const { token: accessToken } = await this.auth.getAccessToken()
    const response = await fetch(
      `${this.auth.getApiBaseUrl()}/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )

    if (!response.ok) {
      const message = await response.text()
      throw new Error(this.formatApiError('download document media', response.status, message))
    }

    const data = Buffer.from(await response.arrayBuffer())
    return {
      data,
      mimeType: response.headers.get('content-type')?.split(';')[0] || detectMimeType(data),
    }
  }

  private async resolveDocument(
    source: string,
    sourceType: 'auto' | 'wiki' | 'docx',
  ): Promise<ResolvedDocument> {
    const reference = parseDocumentReference(source, sourceType)
    if (reference.type === 'docx') {
      return {
        documentId: reference.token,
        documentType: 'docx',
        sourceToken: reference.token,
        sourceType: 'docx',
      }
    }

    const payload = await this.requestJson<WikiNodeData>(
      `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(reference.token)}`,
    )
    const node = payload.node
    if (!node?.obj_token || !node.obj_type) {
      throw new Error('Feishu returned no document target for this Wiki node')
    }

    return {
      documentId: node.obj_token,
      documentType: node.obj_type,
      title: node.title,
      sourceToken: reference.token,
      sourceType: 'wiki',
    }
  }

  private async listAllBlocks(documentId: string): Promise<DocumentBlock[]> {
    const blocks: DocumentBlock[] = []
    let pageToken: string | undefined

    do {
      const query = new URLSearchParams({ page_size: '500', document_revision_id: '-1' })
      if (pageToken) query.set('page_token', pageToken)
      const data = await this.requestJson<BlockListData>(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${query}`,
      )
      blocks.push(...(data.items ?? []))
      pageToken = data.has_more ? data.page_token : undefined
    } while (pageToken)

    return blocks
  }

  private async requestJson<T>(path: string): Promise<T> {
    const { token, identity } = await this.auth.getAccessToken()
    const response = await fetch(`${this.auth.getApiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const raw = await response.text()
    let payload: FeishuEnvelope<T>
    try {
      payload = JSON.parse(raw) as FeishuEnvelope<T>
    } catch {
      throw new Error(this.formatApiError('read Feishu API response', response.status, raw))
    }

    if (!response.ok || payload.code !== 0 || !payload.data) {
      const authHint = identity === 'tenant'
        ? ' No user OAuth token is available; run the feishu_start_readonly_authorization tool, or grant this app access to the document.'
        : ' Verify that the user can open the document and that the app has the required read-only scopes.'
      throw new Error(`${this.formatApiError('read Feishu document', response.status, `${payload.code}: ${payload.msg}`)}${authHint}`)
    }
    return payload.data
  }

  private formatApiError(action: string, status: number, detail: string): string {
    const safeDetail = detail.slice(0, 1000)
    return `Unable to ${action} (HTTP ${status}): ${safeDetail}`
  }

  private extractImages(blocks: DocumentBlock[]): DocumentImage[] {
    const images: DocumentImage[] = []
    for (const block of blocks) {
      const image = block.image
      if (!isRecord(image) || typeof image.token !== 'string') continue
      images.push({
        blockId: block.block_id,
        token: image.token,
        width: typeof image.width === 'number' ? image.width : undefined,
        height: typeof image.height === 'number' ? image.height : undefined,
      })
    }
    return images
  }

  private renderBlocks(blocks: DocumentBlock[]): string {
    const lines: string[] = []
    for (const block of blocks) {
      const type = BLOCK_TYPE_NAMES[block.block_type] ?? `block-${block.block_type}`
      const text = this.extractBlockText(block)
      if (text) {
        lines.push(`[${type}] ${text}`)
      } else if (['image', 'file', 'sheet', 'bitable', 'mindnote', 'board', 'iframe'].includes(type)) {
        lines.push(`[${type}] ${summarizeEmbeddedBlock(block, type)}`)
      }
    }
    return lines.join('\n')
  }

  private extractBlockText(block: DocumentBlock | undefined): string {
    if (!block) return ''
    const values: string[] = []
    for (const value of Object.values(block)) {
      if (isRecord(value) && Array.isArray(value.elements)) {
        values.push(...value.elements.map(renderTextElement).filter(Boolean))
      }
    }
    return values.join('').trim()
  }
}

function parseDocumentReference(
  source: string,
  sourceType: 'auto' | 'wiki' | 'docx',
): { type: 'wiki' | 'docx'; token: string } {
  const trimmed = source.trim()
  try {
    const url = new URL(trimmed)
    const segments = url.pathname.split('/').filter(Boolean)
    const wikiIndex = segments.indexOf('wiki')
    if (wikiIndex >= 0 && segments[wikiIndex + 1]) return { type: 'wiki', token: segments[wikiIndex + 1] }
    const docxIndex = segments.indexOf('docx')
    if (docxIndex >= 0 && segments[docxIndex + 1]) return { type: 'docx', token: segments[docxIndex + 1] }
    throw new Error('URL must contain /wiki/<token> or /docx/<token>')
  } catch (error) {
    if (trimmed.includes('://')) throw error
  }

  if (!trimmed) throw new Error('Document URL or token is required')
  if (sourceType === 'wiki') return { type: 'wiki', token: trimmed }
  if (sourceType === 'docx') return { type: 'docx', token: trimmed }
  if (/^wik/i.test(trimmed)) return { type: 'wiki', token: trimmed }
  return { type: 'docx', token: trimmed }
}

function renderTextElement(value: unknown): string {
  if (!isRecord(value)) return ''
  if (isRecord(value.text_run) && typeof value.text_run.content === 'string') return value.text_run.content
  if (isRecord(value.equation) && typeof value.equation.content === 'string') return value.equation.content
  if (isRecord(value.mention_doc)) {
    const title = typeof value.mention_doc.title === 'string' ? value.mention_doc.title : 'document'
    const url = typeof value.mention_doc.url === 'string' ? decodeURIComponent(value.mention_doc.url) : ''
    return url ? `[${title}](${url})` : title
  }
  if (isRecord(value.mention_user)) {
    return typeof value.mention_user.user_id === 'string' ? `@${value.mention_user.user_id}` : '@user'
  }
  if (isRecord(value.reminder)) {
    return typeof value.reminder.text === 'string' ? value.reminder.text : '[reminder]'
  }
  if (isRecord(value.file)) {
    return typeof value.file.file_token === 'string' ? `[file:${value.file.file_token}]` : '[file]'
  }
  return ''
}

function summarizeEmbeddedBlock(block: DocumentBlock, type: string): string {
  const value = block[type.replace('-', '_')]
  if (!isRecord(value)) return `block_id=${block.block_id}`
  const safeEntries = Object.entries(value)
    .filter(([key, entry]) => ['token', 'file_token', 'name', 'url', 'width', 'height'].includes(key) && ['string', 'number'].includes(typeof entry))
  const summary = Object.fromEntries(safeEntries)
  return `${JSON.stringify(summary)} block_id=${block.block_id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectMimeType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (data.subarray(0, 6).toString('ascii') === 'GIF89a' || data.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}
