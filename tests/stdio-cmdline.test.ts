import { describe, expect, it } from 'vitest'
import {
  buildWin32CmdLine,
  quoteWin32CmdArg,
  resolveStdioSpawnSpec,
  resolveWin32Command,
} from '../src/client/stdio-client.ts'

describe('quoteWin32CmdArg / buildWin32CmdLine — cmd.exe quoting', () => {
  it('plain tokens pass through unquoted', () => {
    expect(quoteWin32CmdArg('-y')).toBe('-y')
  })

  it('the empty argument becomes explicit ""', () => {
    expect(quoteWin32CmdArg('')).toBe('""')
  })

  it('args with spaces/specials are quoted, % doubled, quotes escaped', () => {
    expect(quoteWin32CmdArg('hello world')).toBe('"hello world"')
    expect(quoteWin32CmdArg('a&b')).toBe('"a&b"')
    expect(quoteWin32CmdArg('100%')).toBe('"100%%"')
    expect(quoteWin32CmdArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('command + args are ALWAYS joined with single spaces (the glue-bug guard)', () => {
    expect(buildWin32CmdLine('npx', ['-y', 'mcp-server'])).toBe('npx -y mcp-server')
    expect(buildWin32CmdLine('node', ['', 'a b'])).toBe('node "" "a b"')
  })
})

describe('resolveWin32Command — PATH/PATHEXT resolution', () => {
  // PATHEXT spelled lowercase here so the constructed candidates match the
  // expectations verbatim; real systems accept either case.
  const env = { PATH: 'C:\\Tools;C:\\Windows', PATHEXT: '.com;.exe;.bat;.cmd', ComSpec: 'C:\\Windows\\cmd.exe' }
  // Real Windows filesystems are case-insensitive; the mock mirrors that.
  const exists = (p: string) => {
    const lower = p.toLowerCase()
    return lower === 'c:\\tools\\npx.cmd' || lower === 'c:\\tools\\node.exe'
  }

  it('a resolved .cmd shim needs the cmd.exe wrap', () => {
    expect(resolveWin32Command('npx', env, exists)).toEqual({ command: 'C:\\Tools\\npx.cmd', needsCmd: true })
  })

  it('a resolved .exe does not', () => {
    expect(resolveWin32Command('node', env, exists)).toEqual({ command: 'C:\\Tools\\node.exe', needsCmd: false })
  })

  it('PATH lookup is case-insensitive on the env key', () => {
    const lowerEnv = { path: 'C:\\Tools', comspec: 'C:\\Windows\\cmd.exe', PATHEXT: '.com;.exe;.bat;.cmd' }
    expect(resolveWin32Command('npx', lowerEnv, exists).command).toBe('C:\\Tools\\npx.cmd')
  })

  it('unresolvable bare commands still wrap (let cmd.exe report the miss)', () => {
    expect(resolveWin32Command('nope', env, exists)).toEqual({ command: 'nope', needsCmd: true })
  })
})

describe('resolveStdioSpawnSpec — platform dispatch', () => {
  it('posix: pass command and ARRAY args through untouched', () => {
    const spec = resolveStdioSpawnSpec(
      { command: 'npx', args: ['-y', 'srv'], env: { FOO: '1' } },
      { platform: 'linux', baseEnv: { HOME: '/root' } },
    )
    expect(spec.command).toBe('npx')
    expect(spec.args).toEqual(['-y', 'srv'])
    expect(spec.env).toEqual({ HOME: '/root', FOO: '1' })
  })

  it('win32 cmd shims spawn cmd.exe /d /s /c with the quoted line', () => {
    const spec = resolveStdioSpawnSpec(
      { command: 'npx', args: ['-y', 'mcp-server'] },
      {
        platform: 'win32',
        baseEnv: { PATH: 'C:\\Tools', PATHEXT: '.com;.exe;.bat;.cmd', ComSpec: 'C:\\Windows\\cmd.exe' },
        existsSync: (p) => p.toLowerCase() === 'c:\\tools\\npx.cmd',
      },
    )
    expect(spec.command).toBe('C:\\Windows\\cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/c', 'C:\\Tools\\npx.cmd -y mcp-server'])
  })

  it('win32 .exe spawns directly with the array args', () => {
    const spec = resolveStdioSpawnSpec(
      { command: 'node', args: ['server.js'] },
      {
        platform: 'win32',
        baseEnv: { PATH: 'C:\\Tools', PATHEXT: '.com;.exe;.bat;.cmd' },
        existsSync: (p) => p.toLowerCase() === 'c:\\tools\\node.exe',
      },
    )
    expect(spec.command).toBe('C:\\Tools\\node.exe')
    expect(spec.args).toEqual(['server.js'])
  })
})
