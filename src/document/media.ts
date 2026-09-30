import { MAX_MEDIA_BYTES } from '../shared/limits.js'

export async function readMediaBody(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'))
  if (contentLength > MAX_MEDIA_BYTES) {
    throw new Error(`Document media exceeds the ${MAX_MEDIA_BYTES} byte response limit`)
  }

  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalLength += value.byteLength
      if (totalLength > MAX_MEDIA_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Document media exceeds the ${MAX_MEDIA_BYTES} byte response limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalLength)
}

export function detectMimeType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (data.subarray(0, 6).toString('ascii') === 'GIF89a' || data.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}
