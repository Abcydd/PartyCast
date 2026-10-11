import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', 'relay/node_modules/**', 'relay/.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['scripts/e2e-ui.mjs'], languageOptions: { globals: { ...globals.browser, ...globals.node } }, rules: { 'no-redeclare': ['error', { builtinGlobals: false }] } },
)
