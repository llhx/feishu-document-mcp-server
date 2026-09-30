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

export interface FileMeta {
  token: string
  name?: string
}

export interface DocumentContents {
  document: ResolvedDocument
  blocks: DocumentBlock[]
  text: string
  images: DocumentImage[]
  file?: FileMeta
}

export interface ReadOptions {
  maxRows?: number
  maxRecords?: number
}

export interface DownloadedMedia {
  data: Buffer
  mimeType: string
}
