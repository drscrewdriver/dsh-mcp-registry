import { describe, expect, it } from 'vitest'
import { McpStdioSession } from '../src/client/stdio-client.ts'
import { McpBridge } from '../src/bridge.ts'
import { RegistryStore, type StoreFileIo } from '../src/core/store.ts'

/**
 * Minimal MCP server over stdio: answers `initialize` with a real handshake
 * payload and everything else with an empty tool list. Run through
 * `process.execPath` + `shell: false`, so no shell quoting is involved on
 * Windows.
 */
const SERVER = [
  "process.stdin.setEncoding('utf8');",
  "let b='';",
  "process.stdin.on('data',(c)=>{b+=c;let i;",
  "while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);",
  'if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}',
  'if(m.id===undefined)continue;',
  "const result=m.method==='initialize'",
  "?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'rea',version:'6.5.0'}}",
  ': {tools:[]};',
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}})",
].join('')

function memIo(): StoreFileIo {
  const files = new Map<string, string>()
  return {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, d) => void files.set(p, d),
    rename: (s, d) => {
      const c = files.get(s)
      if (c === undefined) throw new Error('missing')
      files.delete(s)
      files.set(d, c)
    },
    rmIfExists: (p) => void files.delete(p),
    mkdirp: () => {},
    listDir: () => [],
    rm: (p) => void files.delete(p),
    exists: (p) => files.has(p),
  }
}

describe('stdio initialize identity (0.3.10)', () => {
  it('McpStdioSession.initialize returns the handshake identity', async () => {
    const session = new McpStdioSession({ command: process.execPath, args: ['-e', SERVER] })
    try {
      const info = await session.initialize(5000)
      // Before 0.3.10 this returned void, so every field was undefined and
      // `mcp-reg probe` printed "unknown server (protocol ?)".
      expect(info.serverName).toBe('rea')
      expect(info.serverVersion).toBe('6.5.0')
      expect(info.protocolVersion).toBe('2024-11-05')
    } finally {
      session.close()
    }
  })

  it('McpBridge.probe surfaces that identity instead of "unknown server"', async () => {
    const store = new RegistryStore(memIo(), { dir: '/reg', now: () => 1_700_000_000_000 })
    store.load()
    store.add({ id: 'rea', connector: { command: process.execPath, args: ['-e', SERVER] } })
    store.confirm('rea')
    const bridge = new McpBridge(
      store,
      { getProbeTimeoutMs: () => 5000 },
      (record) => new McpStdioSession({ command: record.command, args: record.args }),
    )
    const outcome = await bridge.probe('rea')
    expect(outcome.ok).toBe(true)
    expect(outcome.serverName).toBe('rea')
    expect(outcome.serverVersion).toBe('6.5.0')
    expect(outcome.protocolVersion).toBe('2024-11-05')
  })
})
