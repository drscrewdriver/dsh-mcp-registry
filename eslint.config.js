// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/', 'lib/', 'dist/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Host-boundary seams where `any` is the deliberate, documented choice
    // (HANDOVER 坑位 7/12/14): defineTool options need the TS2321 `as any`
    // assertion, cordis ctx faces and the browser ModuleLoader surface are
    // untyped host modules. Everything else keeps recommended strictness.
    files: ['src/surface/*.ts', 'src/client/*.ts', 'src/types.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
