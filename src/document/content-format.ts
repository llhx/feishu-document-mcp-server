import type { DocumentBlock, DocumentImage } from './feishu-types.js'

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

const BITABLE_DATE_FIELD_TYPES = new Set([5, 1001, 1002])
const BITABLE_PERSON_FIELD_TYPES = new Set([11, 1003, 1004])

export interface MindNode {
  id?: string
  children?: string[]
  topic?: unknown
  note?: unknown
  text?: unknown
  title?: unknown
}

export function extractImages(blocks: DocumentBlock[]): DocumentImage[] {
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

export function renderBlocks(blocks: DocumentBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    const type = BLOCK_TYPE_NAMES[block.block_type] ?? `block-${block.block_type}`
    const text = extractBlockText(block)
    if (text) {
      lines.push(`[${type}] ${text}`)
    } else if (['image', 'file', 'sheet', 'bitable', 'mindnote', 'board', 'iframe'].includes(type)) {
      lines.push(`[${type}] ${summarizeEmbeddedBlock(block, type)}`)
    }
  }
  return lines.join('\n')
}

export function extractBlockText(block: DocumentBlock | undefined): string {
  if (!block) return ''
  const values: string[] = []
  for (const value of Object.values(block)) {
    if (isRecord(value) && Array.isArray(value.elements)) {
      values.push(...value.elements.map(renderTextElement).filter(Boolean))
    }
  }
  return values.join('').trim()
}

export function stringifySheetCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function renderMarkdownTable(rows: string[][]): string {
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

export function normalizeBitableValue(value: unknown, fieldType?: number): string {
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

export function renderMindnoteOutline(nodes: Array<MindNode & { id: string }>): string {
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
  return lines.join('\n')
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

function sanitizeMarkdownCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
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
