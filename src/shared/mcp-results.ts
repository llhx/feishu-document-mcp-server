export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: errorMessage(error) }],
    isError: true,
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
