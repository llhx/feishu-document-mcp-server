import type { AuthManager } from '../auth/auth.js'
import {
  extractBlockText,
  extractImages,
  normalizeBitableValue,
  renderBlocks,
  renderMarkdownTable,
  renderMindnoteOutline,
  stringifySheetCell,
  type MindNode,
} from './content-format.js'
import { parseDocumentReference } from './document-reference.js'
import type {
  DocumentBlock,
  DocumentContents,
  DownloadedMedia,
  ReadOptions,
  ResolvedDocument,
  SourceType,
} from './feishu-types.js'
import { API_REQUEST_TIMEOUT_MS } from '../shared/limits.js'
import { detectMimeType, readMediaBody } from './media.js'

export type {
  DocumentBlock,
  DocumentContents,
  DocumentImage,
  DownloadedMedia,
  FileMeta,
  ReadOptions,
  ResolvedDocument,
  ResolvedSourceType,
  SourceType,
} from './feishu-types.js'

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
    const images = extractImages(blocks)
    const text = renderBlocks(blocks)

    if (!document.title) {
      document.title = extractBlockText(blocks[0]) || undefined
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
    return { document, blocks: [], text: renderMindnoteOutline(nodes) || '(The mindnote is empty)', images: [] }
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
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      const message = await response.text()
      throw new Error(this.formatApiError('download document media', response.status, message))
    }

    const data = await readMediaBody(response)
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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

}

const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000
const DEFAULT_SHEET_MAX_ROWS = 500
const MAX_SHEET_ROWS = 5000
const MAX_SHEET_COLUMNS = 26
const MAX_SHEETS_PER_SPREADSHEET = 10
const DEFAULT_BITABLE_MAX_RECORDS = 200
const MAX_BITABLE_RECORDS = 1000
const MAX_BITABLE_TABLES = 10

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
