/**
 * dsh-mcp-registry build: two artifacts.
 *   1. host  — src/index.ts bundled to lib/index.js (Node ESM). dsh-tools is
 *      host-provided and stays external; the Schemastery Config schema is
 *      bundled in (same choice as dsh-browser-cdp).
 *   2. client — src/client/index.ts bundled to lib/client.js wrapped in the
 *      DSH ModuleLoader factory (browser CJS). React stays external: the web
 *      shell resolves it from the profile's node_modules.
 *
 * [0.1.2 client contract] the browser bundle MUST register the DECLARED
 * package name `dsh-mcp-registry` — boot manifest rows are keyed by the
 * package.json name and the loader row specifier must equal it too; an alias
 * here silently drops the client half (settings panels never appear).
 */
import { defineConfig, type UserConfig } from 'tsdown'

const HOST_EXTERNALS = ['@deepseek-ai/dsh-tools']

const CLIENT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', /^@deepseek-ai\/dsh-client-/]

const host: UserConfig = {
  name: 'dsh-mcp-registry',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  external: HOST_EXTERNALS,
}

const client: UserConfig = {
  name: 'dsh-mcp-registry/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-mcp-registry')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
