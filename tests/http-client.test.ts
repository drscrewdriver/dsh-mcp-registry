import { describe, expect, it } from 'vitest'
import { McpHttpSession } from '../src/client/http-client.ts'
import { McpTransportError } from '../src/client/transport-error.ts'

/** Fake fetch that replays scripted responses and records requests. */
function fakeFetch(script: Array<(req: { body: unknown; headers: Record<string, string> }) => ResponseInit & { bodyText: string }>) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  let step = 0
  const impl = (async (url: unknown, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const body = JSON.parse(String(init?.body ?? '{}')) as unknown
    calls.push({ url: String(url), body, headers })
    const responder = script[Math.min(step, script.length - 1)]
    step += 1
    if (!responder) throw new Error('fakeFetch script exhausted')
    const out = responder({ body, headers })
    return new Response(out.bodyText, {
      status: out.status ?? 200,
      headers: out.headers as Record<string, string>,
    })
  }) as typeof fetch
  return { impl, calls }
}

const INIT_RESULT = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'fake-mcp', version: '1.2.3' },
    capabilities: {},
  },
}

function okInit(): ResponseInit & { bodyText: string } {
  return { bodyText: JSON.stringify(INIT_RESULT), headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } }
}

describe('McpHttpSession', () => {
  it('initializes once, captures session id, and lists tools', async () => {
    const { impl, calls } = fakeFetch([
      okInit,
      () => ({
        bodyText: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'echo' }] } }),
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const session = new McpHttpSession('http://127.0.0.1:9/mcp', { timeoutMs: 500, fetchImpl: impl, authToken: 'tok' })
    const info = await session.initialize()
    expect(info.serverName).toBe('fake-mcp')
    const result = (await session.request('tools/list')) as { tools: Array<{ name: string }> }
    expect(result.tools[0]?.name).toBe('echo')
    // initialize + initialized notification + tools/list
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls[2]?.headers['mcp-session-id']).toBe('sess-1')
    expect(calls[2]?.headers['authorization']).toBe('Bearer tok')
    // tools/list triggers no second initialize
    const initCalls = calls.filter((c) => (c.body as { method?: string }).method === 'initialize')
    expect(initCalls).toHaveLength(1)
  })

  it('HTTP 500 becomes http-500 with no server body echoed', async () => {
    const { impl } = fakeFetch([() => ({ status: 500, bodyText: 'SECRET leak attempt bad-token-xyz' })])
    const session = new McpHttpSession('http://127.0.0.1:9/mcp', { timeoutMs: 500, fetchImpl: impl })
    const err = await session.initialize().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpTransportError)
    expect((err as McpTransportError).code).toBe('http-500')
    expect((err as McpTransportError).message).not.toContain('SECRET')
  })

  it('connection refused maps to a stable code', async () => {
    const failing = (async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    }) as typeof fetch
    const session = new McpHttpSession('http://127.0.0.1:9/mcp', { timeoutMs: 500, fetchImpl: failing })
    const err = await session.initialize().catch((e: unknown) => e)
    expect((err as McpTransportError).code).toBe('connect-failed')
  })

  it('404 after init re-initializes once and retries', async () => {
    const { impl, calls } = fakeFetch([
      okInit,
      // the initialized notification: 202 empty body
      () => ({ status: 202, bodyText: '' }),
      // first tools/list attempt: session expired
      () => ({ status: 404, bodyText: 'gone' }),
      // re-initialize
      okInit,
      // retry succeeds
      () => ({ bodyText: JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }), headers: { 'content-type': 'application/json' } }),
    ])
    const session = new McpHttpSession('http://127.0.0.1:9/mcp', { timeoutMs: 500, fetchImpl: impl })
    await session.initialize()
    await session.request('tools/list')
    const initCalls = calls.filter((c) => (c.body as { method?: string }).method === 'initialize')
    expect(initCalls.length).toBe(2)
  })

  it('SSE-framed responses are parsed from data frames', async () => {
    const { impl } = fakeFetch([
      () => ({
        bodyText: `: ping\n\n data: ignore-leading-space\n\ndata: ${JSON.stringify(INIT_RESULT)}\n\n`,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ])
    const session = new McpHttpSession('http://127.0.0.1:9/mcp', { timeoutMs: 500, fetchImpl: impl })
    const info = await session.initialize()
    expect(info.serverName).toBe('fake-mcp')
  })
})
