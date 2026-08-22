/** Validate that every Cordis patch-layer row has a composer address. */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

interface JsExpr {
  __jsExpr: string
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

type RecordValue = Record<string, unknown>

/**
 * Check every repository Cordis patch layer for rows the composer would skip.
 *
 * A patch-layer element either names the row it overrides (`id`) or inserts new
 * rows (`insert`). Rows with neither field are silently ignored by the composer.
 * @param root - repository root containing the patch-layer files.
 * @returns one diagnostic per patch-layer row the composer would skip.
 */
export function validatePatchLayerRows(root: string): string[] {
  const problems: string[] = []
  for (const file of globSync('**/cordis.patch.yml', { cwd: root, exclude: ['node_modules/**', 'vendor/**'] }).sort()) {
    const entries = loadEntries(root, file)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (!isRecord(entry)) {
        problems.push(`${file}[${index}]: patch-layer row must be an object`)
        continue
      }
      if (typeof entry.id === 'string' || isUnknownArray(entry.insert)) continue
      problems.push(
        `${file}[${index}]: patch-layer row declares neither "id" nor "insert" `
        + `(keys: ${Object.keys(entry).join(', ') || 'none'}), so the composer skips it`,
      )
    }
  }
  return problems
}

function loadEntries(root: string, file: string): unknown[] {
  const document: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema })
  return isUnknownArray(document) ? document : []
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
