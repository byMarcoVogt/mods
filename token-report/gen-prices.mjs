// Writes hooks/prices.ts from prices.json. A mod loads only code files, so the JSON can't be imported
// directly; prices.json stays the one table (the cost-dashboard skill compares its copy with it).
//   node gen-prices.mjs          regenerate after editing prices.json
//   node gen-prices.mjs --check  exit 1 when hooks/prices.ts is stale
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const table = JSON.parse(readFileSync(join(here, 'prices.json'), 'utf8'))
const out = join(here, 'hooks', 'prices.ts')
const text =
  '// Generated from ../prices.json by gen-prices.mjs. Do not edit: change prices.json, then run\n' +
  '// `node gen-prices.mjs` in the mod folder.\n' +
  `export default ${JSON.stringify(table, null, 2)}\n`

if (process.argv.includes('--check')) {
  let now = ''
  try { now = readFileSync(out, 'utf8') } catch {}
  if (now.replace(/\r\n/g, '\n') !== text) { console.error('hooks/prices.ts is stale: run node gen-prices.mjs'); process.exit(1) }
  console.log('hooks/prices.ts matches prices.json')
} else {
  writeFileSync(out, text)
  console.log('wrote hooks/prices.ts')
}
