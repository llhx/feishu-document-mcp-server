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

export type SourceType = 'auto' | 'wiki' | 'docx' | 'doc' | 'sheet' | 'bitable' | 'mindnote' | 'file'

export type ResolvedSourceType = Exclude<SourceType, 'auto' | 'wiki'>

export interface ResolvedDocument {
  documentId: string
  documentType: string
  title?: string
  sourceToken: string
  sourceType: ResolvedSourceType | 'wiki'
}

export interface DocumentContents {
  document: ResolvedDocument
  blocks: DocumentBlock[]
  text: string
  images: DocumentImage[]
  file?: FileMeta
}

export interface FileMeta {
  token: string
  name?: string
}

export interface ReadOptions {
  maxRows?: number
  maxRecords?: number
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

interface LegacyDocContentData {
  content?: string
}

interface SheetMetainfoData {
  sheets?: Array<{
    sheetId?: string
    sheet_id?: string
    title?: string
    rowCount?: number
    row_count?: number
    columnCount?: number
    column_count?: number
    hidden?: boolean
  }>
}

interface SheetValuesData {
  valueRange?: {
    values?: unknown[][]
  }
}

interface BitableTablesData {
  items?: Array<{ table_id?: string; name?: string }>
}

interface BitableFieldsData {
  items?: Array<{ field_name?: string; type?: number }>
}

interface BitableRecordsData {
  items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>
  total?: number
  has_more?: boolean
  page_token?: string
}

interface MindNode {
  id?: string
  children?: string[]
  topic?: unknown
  note?: unknown
  text?: unknown
  title?: unknown
}

interface MindNodesData {
  nodes?: MindNode[]
}

export class FeishuClient {
  constructor(private readonly auth: AuthManager) {}

  async readDocument(source: string, sourceType: SourceType = 'auto', options: ReadOptions = {}): Promise<DocumentContents> {
    const resolved = await this.resolveDocument(source, sourceType)
    switch (resolved.documentType) {
      case 'docx':
        return this.readDocxDocument(resolved)
      case 'doc':
        return this.readLegacyDocDocument(resolved)
      case 'sheet':
        return this.readSheetDocument(resolved, options)
      case 'bitable':
        return this.readBitableDocument(resolved, options)
      case 'mindnote':
        return this.readMindnoteDocument(resolved)
      case 'file':
        return this.readFileDocument(resolved)
      default:
        throw new Error(`Feishu "${resolved.documentType}" content is not supported by this MCP; supported types: docx, doc, sheet, bitable, mindnote, file`)
    }
  }

  private async readDocxDocument(document: ResolvedDocument): Promise<DocumentContents> {
    const blocks = await this.listAllBlocks(document.documentId)
    const images = this.extractImages(blocks)
    const text = this.renderBlocks(blocks)

    if (!document.title) {
      document.title = this.extractBlockText(blocks[0]) || undefined
    }

    return { document, blocks, text, images }
  }

  private async readLegacyDocDocument(document: ResolvedDocument): Promise<DocumentContents> {
    const data = await this.requestJson<LegacyDocContentData>(
      `/open-apis/doc/v2/${encodeURIComponent(document.documentId)}/raw_content`,
    )
    return { document, blocks: [], text: data.content?.trim() || '(The legacy document has no text content)', images: [] }
  }

  private async readSheetDocument(document: ResolvedDocument, options: ReadOptions): Promise<DocumentContents> {
    const maxRows = clamp(options.maxRows ?? DEFAULT_SHEET_MAX_ROWS, 1, MAX_SHEET_ROWS)
    const meta = await this.requestJson<SheetMetainfoData>(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(document.documentId)}/metainfo`,
    )
    const sheets = (meta.sheets ?? []).filter((sheet) => !sheet.hidden)
    const sections: string[] = []

    for (const [index, sheet] of sheets.entries()) {
      if (index >= MAX_SHEETS_PER_SPREADSHEET) {
        sections.push(`(… ${sheets.length - MAX_SHEETS_PER_SPREADSHEET} more sheet(s) not rendered)`)
        break
      }
      const sheetId = sheet.sheetId ?? sheet.sheet_id
      if (!sheetId) continue
      const title = sheet.title ?? sheetId
      const rowCount = sheet.rowCount ?? sheet.row_count ?? 0
      const columnCount = sheet.columnCount ?? sheet.column_count ?? 0
      const sectionLines = [`## Sheet: ${title}`]
      if (rowCount <= 0 || columnCount <= 0) {
        sectionLines.push('(empty sheet)')
        sections.push(sectionLines.join('\n'))
        continue
      }

      const rows = Math.min(rowCount, maxRows)
      const columns = Math.min(columnCount, MAX_SHEET_COLUMNS)
      const range = `${sheetId}!A1:${columnLetter(columns)}${rows}`
      const query = new URLSearchParams({ valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' })
      let cellRows: string[][]
      try {
        const data = await this.requestJson<SheetValuesData>(
          `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(document.documentId)}/values/${encodeURIComponent(range)}?${query}`,
        )
        cellRows = (data.valueRange?.values ?? []).map((row) =>
          Array.isArray(row) ? row.map(stringifySheetCell) : [stringifySheetCell(row)],
        )
      } catch (error) {
        cellRows = [[`Failed to read this sheet: ${error instanceof Error ? error.message : String(error)}`]]
      }
      sectionLines.push(renderMarkdownTable(cellRows))
      if (rowCount > rows) sectionLines.push(`(showing first ${rows} of ${rowCount} rows; increase maxRows to read more)`)
      if (columnCount > columns) sectionLines.push(`(showing first ${columns} of ${columnCount} columns)`)
      sections.push(sectionLines.join('\n'))
    }

    return { document, blocks: [], text: sections.join('\n\n') || '(The spreadsheet has no visible sheets)', images: [] }
  }

  private async readBitableDocument(document: ResolvedDocument, options: ReadOptions): Promise<DocumentContents> {
    const maxRecords = clamp(options.maxRecords ?? DEFAULT_BITABLE_MAX_RECORDS, 1, MAX_BITABLE_RECORDS)
    const appToken = encodeURIComponent(document.documentId)
    const tablesData = await this.requestJson<BitableTablesData>(`/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`)
    const tables = tablesData.items ?? []
    const sections: string[] = []

    for (const [index, table] of tables.entries()) {
      if (index >= MAX_BITABLE_TABLES) {
        sections.push(`(… ${tables.length - MAX_BITABLE_TABLES} more table(s) not rendered)`)
        break
      }
      if (!table.table_id) continue
      const tableToken = encodeURIComponent(table.table_id)
      const fieldsData = await this.requestJson<BitableFieldsData>(
        `/open-apis/bitable/v1/apps/${appToken}/tables/${tableToken}/fields?page_size=100`,
      )
      const fieldItems = fieldsData.items ?? []
      const fieldNames = fieldItems.map((field) => field.field_name ?? '').filter(Boolean)
      const fieldTypes = new Map(fieldItems.map((field) => [field.field_name ?? '', field.type]))

      const records: Array<{ fields?: Record<string, unknown> }> = []
      let total: number | undefined
      let pageToken: string | undefined
      do {
        const query = new URLSearchParams({ page_size: '500' })
        if (pageToken) query.set('page_token', pageToken)
        const data = await this.requestJson<BitableRecordsData>(
          `/open-apis/bitable/v1/apps/${appToken}/tables/${tableToken}/records?${query}`,
        )
        records.push(...(data.items ?? []))
        total = data.total ?? total
        pageToken = data.has_more ? data.page_token : undefined
      } while (pageToken && records.length < maxRecords)

      const shown = records.slice(0, maxRecords)
      const columns = fieldNames.length ? fieldNames : Object.keys(shown[0]?.fields ?? {})
      const rows = [
        columns,
        ...shown.map((record) => columns.map((column) => normalizeBitableValue(record.fields?.[column], fieldTypes.get(column)))),
      ]
      const sectionLines = [`## Table: ${table.name ?? table.table_id} (${total ?? shown.length} records)`]
      sectionLines.push(renderMarkdownTable(rows))
      if ((total ?? shown.length) > shown.length) {
        sectionLines.push(`(showing first ${shown.length} of ${total} records; increase maxRecords to read more)`)
      }
      sections.push(sectionLines.join('\n'))
    }

    return { document, blocks: [], text: sections.join('\n\n') || '(The bitable has no tables)', images: [] }
  }

  private async readMindnoteDocument(document: ResolvedDocument): Promise<DocumentContents> {
    const data = await this.requestJson<MindNodesData>(
      `/open-apis/mind/v1/minds/${encodeURIComponent(document.documentId)}/nodes`,
    )
    const nodes = (data.nodes ?? []).filter((node): node is MindNode & { id: string } => typeof node.id === 'string')
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const childIds = new Set(nodes.flatMap((node) => node.children ?? []))
    const lines: string[] = []
    const visited = new Set<string>()

    const renderNode = (node: MindNode & { id: string }, depth: number): void => {
      if (visited.has(node.id) || depth > 50) return
      visited.add(node.id)
      lines.push(`${'  '.repeat(depth)}- ${mindNodeText(node) || '(untitled)'}`)
      for (const childId of node.children ?? []) {
        const child = nodeById.get(childId)
        if (child) renderNode(child, depth + 1)
      }
    }

    for (const node of nodes) {
      if (!childIds.has(node.id)) renderNode(node, 0)
    }
    if (!lines.length) {
      for (const node of nodes) lines.push(`- ${mindNodeText(node) || '(untitled)'}`)
    }

    return { document, blocks: [], text: lines.join('\n') || '(The mindnote is empty)', images: [] }
  }

  private async readFileDocument(document: ResolvedDocument): Promise<DocumentContents> {
    return {
      document,
      blocks: [],
      images: [],
      text: '',
      file: {
        token: document.documentId,
        name: document.title,
      },
    }
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
    sourceType: SourceType,
  ): Promise<ResolvedDocument> {
    const reference = parseDocumentReference(source, sourceType)
    if (reference.type !== 'wiki') {
      return {
        documentId: reference.token,
        documentType: reference.type,
        sourceToken: reference.token,
        sourceType: reference.type,
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

const URL_PATH_TYPES: Record<string, ResolvedSourceType> = {
  docx: 'docx',
  doc: 'doc',
  sheets: 'sheet',
  base: 'bitable',
  file: 'file',
  mindnotes: 'mindnote',
}

function parseDocumentReference(
  source: string,
  sourceType: SourceType,
): { type: ResolvedSourceType | 'wiki'; token: string } {
  const trimmed = source.trim()
  try {
    const url = new URL(trimmed)
    const segments = url.pathname.split('/').filter(Boolean)
    const wikiIndex = segments.indexOf('wiki')
    if (wikiIndex >= 0 && segments[wikiIndex + 1]) return { type: 'wiki', token: segments[wikiIndex + 1] }
    for (const [segment, resolvedType] of Object.entries(URL_PATH_TYPES)) {
      const index = segments.indexOf(segment)
      if (index >= 0 && segments[index + 1]) return { type: resolvedType, token: segments[index + 1] }
    }
    throw new Error('URL must contain /wiki/<token>, /docx/<token>, /doc/<token>, /sheets/<token>, /base/<token>, /file/<token>, or /mindnotes/<token>')
  } catch (error) {
    if (trimmed.includes('://')) throw error
  }

  if (!trimmed) throw new Error('Document URL or token is required')
  if (sourceType === 'auto') {
    if (/^wik/i.test(trimmed)) return { type: 'wiki', token: trimmed }
    return { type: 'docx', token: trimmed }
  }
  if (sourceType === 'wiki') return { type: 'wiki', token: trimmed }
  return { type: sourceType, token: trimmed }
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

const DEFAULT_SHEET_MAX_ROWS = 500
const MAX_SHEET_ROWS = 5000
const MAX_SHEET_COLUMNS = 26
const MAX_SHEETS_PER_SPREADSHEET = 10
const DEFAULT_BITABLE_MAX_RECORDS = 200
const MAX_BITABLE_RECORDS = 1000
const MAX_BITABLE_TABLES = 10
const BITABLE_DATE_FIELD_TYPES = new Set([5, 1001, 1002])
const BITABLE_PERSON_FIELD_TYPES = new Set([11, 1003, 1004])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function columnLetter(index: number): string {
  let label = ''
  while (index > 0) {
    const remainder = (index - 1) % 26
    label = `${String.fromCharCode(65 + remainder)}${label}`
    index = Math.floor((index - 1) / 26)
  }
  return label
}

function stringifySheetCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function sanitizeMarkdownCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function renderMarkdownTable(rows: string[][]): string {
  if (!rows.length) return '(empty)'
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => {
    const cells = [...row]
    while (cells.length < width) cells.push('')
    return cells
  })
  const header = normalized[0]
  const lines = [
    `| ${header.map(sanitizeMarkdownCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.map(sanitizeMarkdownCell).join(' | ')} |`),
  ]
  return lines.join('\n')
}

function normalizeBitableValue(value: unknown, fieldType?: number): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (fieldType !== undefined && BITABLE_DATE_FIELD_TYPES.has(fieldType)) return new Date(value).toISOString()
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBitableValue(item, fieldType)).filter(Boolean).join(', ')
  }
  if (isRecord(value)) {
    if (fieldType !== undefined && BITABLE_PERSON_FIELD_TYPES.has(fieldType) && typeof value.id === 'string') return value.id
    if (typeof value.text === 'string' && value.text) return value.text
    if (typeof value.name === 'string' && value.name) return value.name
    if (typeof value.link === 'string' && value.link) return value.link
    if (typeof value.id === 'string' && value.id) return value.id
    return JSON.stringify(value)
  }
  return String(value)
}

function mindNodeText(node: MindNode): string {
  if (typeof node.topic === 'string') return node.topic
  if (isRecord(node.topic)) {
    if (typeof node.topic.text === 'string') return node.topic.text
    if (Array.isArray(node.topic.elements)) return node.topic.elements.map(renderTextElement).filter(Boolean).join('')
  }
  if (typeof node.note === 'string') return node.note
  if (typeof node.text === 'string') return node.text
  if (typeof node.title === 'string') return node.title
  return ''
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
