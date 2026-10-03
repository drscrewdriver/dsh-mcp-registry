/**
 * Transport-level failure with a stable code. Error messages carry connector
 * id + host:port at most — never a full URL with credentials, never a raw
 * fetch exception (those embed the full URL).
 */
export class McpTransportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function describeFetchFailure(e: unknown): McpTransportError {
  if (e instanceof McpTransportError) return e
  const err = e as { name?: string; code?: string; cause?: { code?: string } }
  const code = err?.code ?? err?.cause?.code ?? ''
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new McpTransportError('timeout', 'request timed out')
  }
  if (code === 'ECONNREFUSED') return new McpTransportError('connect-failed', 'connection refused')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new McpTransportError('host-unresolved', 'host did not resolve')
  return new McpTransportError('connect-failed', `connection failed (${code || err?.name || 'unknown'})`)
}

/**
 * Extract the JSON-RPC response from one HTTP response body. Streamable-http
 * servers MAY answer a single request with `text/event-stream`; when they do,
 * the answer for our id is in a `data:` frame, so scan frames in order.
 */
export function parseResponseBody(text: string, contentType: string): unknown {
  if (/text\/event-stream/i.test(contentType)) {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const dataLines = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      if (dataLines.length === 0) continue
      try {
        return JSON.parse(dataLines.join('\n'))
      } catch {
        // keep scanning remaining frames
      }
    }
    throw new McpTransportError('bad-json', 'no parseable data frame in event-stream response')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new McpTransportError('bad-json', 'response body is not JSON')
  }
}
