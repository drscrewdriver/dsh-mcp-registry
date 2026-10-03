/**
 * Minimal JSON-RPC 2.0 framing for MCP over stdio (newline-delimited) and
 * streamable-http (single JSON body, or one data frame of an SSE response).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

let seq = 0

export function nextRequestId(): number {
  seq += 1
  return seq
}

export function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id: nextRequestId(), method }
  if (params !== undefined) req.params = params
  return req
}

export function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  const note: JsonRpcNotification = { jsonrpc: '2.0', method }
  if (params !== undefined) note.params = params
  return note
}

export interface RpcResponse {
  id: number | string | null
  result?: unknown
  error?: JsonRpcErrorBody
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const msg = value as Record<string, unknown>
  return msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg) && (typeof msg.id === 'number' || typeof msg.id === 'string' || msg.id === null)
}

export function rpcErrorMessage(error: JsonRpcErrorBody | undefined): string {
  if (!error) return 'unknown rpc error'
  return `rpc error ${error.code}: ${error.message}`
}
