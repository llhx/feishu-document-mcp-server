import type { ResolvedSourceType, SourceType } from './feishu-types.js'

const URL_PATH_TYPES: Record<string, ResolvedSourceType> = {
  docx: 'docx',
  doc: 'doc',
  sheets: 'sheet',
  base: 'bitable',
  file: 'file',
  mindnotes: 'mindnote',
}

export function parseDocumentReference(
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
