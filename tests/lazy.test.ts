import { describe, expect, it } from 'vitest'
import { NativeToolLazyLoader, buildDiscoveryGuide, scopeKeyOf, TOOL_ACTIVATE, TOOL_DISCOVER, type LazyOptions } from '../src/lazy.ts'
import type { AssemblyToolSchema, PromptAssemblyLike } from '../src/types.ts'

function tool(name: string, description = `${name} description`): AssemblyToolSchema {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

function assembly(...tools: AssemblyToolSchema[]): PromptAssemblyLike {
  return { tools, sections: [], contexts: [], variables: {} }
}

function loader(overrides: Partial<LazyOptions> = {}): NativeToolLazyLoader {
  const opts: LazyOptions = {
    isEnabled: () => true,
    keepAlways: () => ['bash', 'read'],
    descriptionLimit: () => 160,
    eagerIndex: () => true,
    ...overrides,
  }
  return new NativeToolLazyLoader(opts)
}

const agentCtx = (id: string) => ({ agent: { id } })

describe('scopeKeyOf', () => {
  it('uses a string id from an object carrier', () => {
    expect(scopeKeyOf({ id: 'sess-1' })).toBe('sess-1')
  })
  it('stringifies a numeric id', () => {
    expect(scopeKeyOf({ id: 7 })).toBe('7')
  })
  it('accepts a bare string', () => {
    expect(scopeKeyOf('direct')).toBe('direct')
  })
  it('falls back to the shared global bucket when there is no id', () => {
    expect(scopeKeyOf(undefined)).not.toBe('direct')
    expect(scopeKeyOf({})).toBe(scopeKeyOf(undefined))
  })
})

describe('NativeToolLazyLoader.project — fail-open folding', () => {
  it('returns the exact assembly when disabled', () => {
    const l = loader({ isEnabled: () => false })
    const a = assembly(tool('bash'), tool('web_search'))
    expect(l.project(a, agentCtx('s1'))).toBe(a)
  })

  it('folds a native candidate but keeps core, own meta-tools, and mcp tools', () => {
    const l = loader()
    const a = assembly(
      tool('bash'),           // keep-always
      tool('read'),           // keep-always
      tool(TOOL_DISCOVER),    // own
      tool(TOOL_ACTIVATE),    // own
      tool('mcp__github__search'), // MCP namespace — bridge owns it
      tool('web_search'),     // foldable
      tool('todo_write'),     // foldable
    )
    const out = l.project(a, agentCtx('s1'))
    expect(out.tools.map((t) => t.name)).toEqual(['bash', 'read', TOOL_DISCOVER, TOOL_ACTIVATE, 'mcp__github__search'])
  })

  it('returns the same object when nothing is foldable', () => {
    const l = loader()
    const a = assembly(tool('bash'), tool('mcp__srv__x'))
    expect(l.project(a, agentCtx('s1'))).toBe(a)
  })

  it('tolerates a non-array tools payload', () => {
    const l = loader()
    const bad = { tools: undefined } as unknown as PromptAssemblyLike
    expect(l.project(bad, agentCtx('s1'))).toBe(bad)
  })
})

describe('activation is scoped per agent', () => {
  it('reveals a tool to the activating agent only', () => {
    const l = loader()
    const a = assembly(tool('bash'), tool('web_search'))
    // Both agents start cold.
    expect(l.project(a, agentCtx('s1')).tools.map((t) => t.name)).toEqual(['bash'])
    expect(l.project(a, agentCtx('s2')).tools.map((t) => t.name)).toEqual(['bash'])

    const r = l.activate('s1', 'web_search')
    expect(r.status).toBe('activated')
    expect(r.schema?.name).toBe('web_search')

    // s1 now sees web_search; s2 stays cold.
    expect(l.project(a, agentCtx('s1')).tools.map((t) => t.name)).toEqual(['bash', 'web_search'])
    expect(l.project(a, agentCtx('s2')).tools.map((t) => t.name)).toEqual(['bash'])
  })

  it('reports already on a repeat activation', () => {
    const l = loader()
    l.project(assembly(tool('web_search')), agentCtx('s1'))
    expect(l.activate('s1', 'web_search').status).toBe('activated')
    expect(l.activate('s1', 'web_search').status).toBe('already')
  })

  it('refuses to activate a core, mcp, own, or unknown tool', () => {
    const l = loader()
    l.project(assembly(tool('bash'), tool('mcp__srv__x'), tool('web_search')), agentCtx('s1'))
    expect(l.activate('s1', 'bash').status).toBe('unknown')        // keep-always
    expect(l.activate('s1', 'mcp__srv__x').status).toBe('unknown') // mcp namespace
    expect(l.activate('s1', TOOL_DISCOVER).status).toBe('unknown') // own
    expect(l.activate('s1', 'never_seen').status).toBe('unknown')  // not in catalog
  })

  it('isActive reflects kept and activated names', () => {
    const l = loader()
    l.project(assembly(tool('web_search')), agentCtx('s1'))
    expect(l.isActive('s1', 'bash')).toBe(true)          // kept
    expect(l.isActive('s1', 'web_search')).toBe(false)   // cold
    l.activate('s1', 'web_search')
    expect(l.isActive('s1', 'web_search')).toBe(true)
  })
})

describe('discover catalog', () => {
  it('lists only hidden candidates with truncated descriptions and active flags', () => {
    const l = loader({ descriptionLimit: () => 12 })
    const long = 'a'.repeat(80)
    l.project(assembly(tool('bash'), tool('mcp__srv__x'), { ...tool('web_search', long) }, tool('todo_write')), agentCtx('s1'))
    l.activate('s1', 'todo_write')
    const rows = l.discover('s1')
    // core (bash) and mcp excluded; web_search + todo_write present.
    expect(rows.map((r) => r.name)).toEqual(['todo_write', 'web_search'])
    expect(rows.find((r) => r.name === 'todo_write')?.active).toBe(true)
    expect(rows.find((r) => r.name === 'web_search')?.active).toBe(false)
    // 12-char limit → 11 chars + ellipsis.
    const web = rows.find((r) => r.name === 'web_search')?.description ?? ''
    expect(web.length).toBe(12)
    expect(web.endsWith('\u2026')).toBe(true)
  })

  it('caches the full schema even before any activation query', () => {
    const l = loader()
    l.project(assembly(tool('web_search'), tool('todo_write')), agentCtx('s1'))
    expect(l.catalogSize()).toBe(2)
  })

  it('forget drops a scope activation set', () => {
    const l = loader()
    const a = assembly(tool('web_search'))
    l.project(a, agentCtx('s1'))
    l.activate('s1', 'web_search')
    expect(l.project(a, agentCtx('s1')).tools.length).toBe(1)
    l.forget('s1')
    expect(l.project(a, agentCtx('s1')).tools.length).toBe(0)
  })
})

describe('buildDiscoveryGuide', () => {
  it('is empty when the registry is disabled', () => {
    expect(buildDiscoveryGuide({ registryEnabled: false, lazyEnabled: false, connectors: [], nativeIndex: [] })).toBe('')
    expect(buildDiscoveryGuide({ registryEnabled: false, lazyEnabled: true, connectors: [{ id: 'fs' }], nativeIndex: [] })).toBe('')
  })

  it('names the available connector ids without a status round-trip', () => {
    const guide = buildDiscoveryGuide({ registryEnabled: true, lazyEnabled: false, connectors: [{ id: 'fs', name: 'Filesystem' }, { id: 'gh' }], nativeIndex: [] })
    expect(guide).toContain('`fs` (Filesystem)')
    expect(guide).toContain('`gh`')
    expect(guide).toContain('mcp_bridge_list_tools')
    expect(guide).toContain('mcp_bridge_call')
    expect(guide).not.toContain('tool_discover')
  })

  it('does not leak any credential-looking field', () => {
    const guide = buildDiscoveryGuide({ registryEnabled: true, lazyEnabled: false, connectors: [{ id: 'fs', name: 'Filesystem' }], nativeIndex: [] })
    expect(guide).not.toContain('http')
    expect(guide).not.toContain('***')
  })

  it('says none are registered when the enabled list is empty', () => {
    const guide = buildDiscoveryGuide({ registryEnabled: true, lazyEnabled: false, connectors: [], nativeIndex: [] })
    expect(guide).toContain('No MCP connectors')
    expect(guide).toContain('mcp_registry_status')
  })

  it('Mode B: lists hidden native tools and points straight at tool_activate', () => {
    const guide = buildDiscoveryGuide({ registryEnabled: true, lazyEnabled: true, connectors: [{ id: 'fs' }], nativeIndex: [{ name: 'web_search', summary: 'Search the web' }] })
    expect(guide).toContain('`fs`')
    expect(guide).toContain('`web_search` (Search the web)')
    expect(guide).toContain('Hidden native tools you can activate')
    expect(guide).toContain('tool_activate')
  })

  it('Mode A: empty index falls back to tool_discover-first phrasing', () => {
    const guide = buildDiscoveryGuide({ registryEnabled: true, lazyEnabled: true, connectors: [], nativeIndex: [] })
    expect(guide).toContain('Call `tool_discover`')
    expect(guide).not.toContain('Hidden native tools you can activate')
  })
})

describe('NativeToolLazyLoader.nativeIndex', () => {
  it('lists only live hidden candidates, sorted, with truncated summaries', () => {
    const l = loader({ descriptionLimit: () => 10 })
    const visible: AssemblyToolSchema[] = [
      tool('bash', 'Run shell'),                 // keep-always
      tool('read', 'Read a file'),               // keep-always
      tool(TOOL_DISCOVER, 'meta'),               // own
      tool(TOOL_ACTIVATE, 'meta'),               // own
      tool('mcp__srv__x', 'remote'),             // mcp namespace
      tool('todo_write', 'Track todos here'),    // candidate
      tool('web_search', 'Search the world widely'), // candidate
    ]
    const rows = l.nativeIndex('s1', visible)
    expect(rows.map((r) => r.name)).toEqual(['todo_write', 'web_search'])
    // 10-char limit → <=10 chars, ellipsis when truncated.
    const web = rows.find((r) => r.name === 'web_search')!.summary
    expect(web.length).toBeLessThanOrEqual(10)
    expect(web.endsWith('\u2026')).toBe(true)
  })

  it('drops a tool once it is activated for the scope', () => {
    const l = loader()
    const visible = [tool('web_search')]
    expect(l.nativeIndex('s1', visible).map((r) => r.name)).toEqual(['web_search'])
    // populate the fold catalog, then activate
    l.project(assembly(tool('web_search')), agentCtx('s1'))
    l.activate('s1', 'web_search')
    expect(l.nativeIndex('s1', visible)).toEqual([])
  })

  it('is correct on the first assembly with no prior fold (no warm-up gap)', () => {
    const l = loader()
    const rows = l.nativeIndex('fresh', [tool('grep_like_tool', 'desc')])
    expect(rows).toEqual([{ name: 'grep_like_tool', summary: 'desc' }])
    expect(l.catalogSize()).toBe(0) // nativeIndex never touches the fold catalog
  })
})
