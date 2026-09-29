/**
 * The shipped base patch's two posture rows (sandbox-policy `mode`, approval
 * `policy`) must resolve `DSH_PERMISSION_MODE` through the frozen
 * launch-environment snapshot the launcher provides before any config entry
 * mounts. A `process.env` mutation AFTER the snapshot must not move either
 * posture; a composition that mounted no snapshot keeps the documented bare
 * fallback (the inherited environment as the sole layer).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

/** The `!!js` expression behind one shipped row's config key. */
function postureExpression(id: string, key: 'mode' | 'policy'): string {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
  const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
    typeof patch === 'object' && patch !== null
      ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
      : [],
  )
  const row = rows.find(candidate => candidate['id'] === id)
  if (row === undefined) throw new Error(`base patch must mount ${id}`)
  const config = row['config']
  const expression = typeof config === 'object' && config !== null
    ? (config as Record<string, unknown>)[key]
    : undefined
  const jsExpr = typeof expression === 'object' && expression !== null
    ? (expression as { __jsExpr?: unknown })['__jsExpr']
    : undefined
  if (typeof jsExpr !== 'string') throw new Error(`${id} must configure ${key} as a !!js expression`)
  return jsExpr
}

/** Run one shipped expression under an evaluation scope like the loader's `with (ctx)`. */
function evaluatePosture(scope: object, id: string, key: 'mode' | 'policy'): unknown {
  return evaluate(scope, postureExpression(id, key))
}

describe('base patch posture rows honor the frozen launch snapshot', () => {
  it('keeps both rows on the snapshot when process.env changes after it was taken', () => {
    const snapshot = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DSH_PERMISSION_MODE: 'workspace-write' } },
    ])
    // The scope carries the REAL process, so the mutation below is exactly a
    // post-snapshot environment change.
    const scope = { launchEnvironment: snapshot, process }

    expect(evaluatePosture(scope, 'sandbox-policy', 'mode')).toBe('workspace-write')
    expect(evaluatePosture(scope, 'approval', 'policy')).toBe('ask')

    const previous = process.env.DSH_PERMISSION_MODE
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    try {
      expect(evaluatePosture(scope, 'sandbox-policy', 'mode')).toBe('workspace-write')
      expect(evaluatePosture(scope, 'approval', 'policy')).toBe('ask')
    } finally {
      if (previous === undefined) delete process.env.DSH_PERMISSION_MODE
      else process.env.DSH_PERMISSION_MODE = previous
    }
  })

  it('carries a restrictive snapshot value through to both rows', () => {
    const snapshot = createLaunchEnvironmentSnapshot([
      { source: 'project-env', path: '/work/.env', values: { DSH_PERMISSION_MODE: 'danger-full-access' } },
    ])
    const scope = { launchEnvironment: snapshot, process }

    expect(evaluatePosture(scope, 'sandbox-policy', 'mode')).toBe('danger-full-access')
    expect(evaluatePosture(scope, 'approval', 'policy')).toBe('never')
  })

  it('falls back to the inherited environment only when no snapshot was provided', () => {
    const scope = { process }
    const previous = process.env.DSH_PERMISSION_MODE
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    try {
      expect(evaluatePosture(scope, 'sandbox-policy', 'mode')).toBe('danger-full-access')
      expect(evaluatePosture(scope, 'approval', 'policy')).toBe('never')
    } finally {
      if (previous === undefined) delete process.env.DSH_PERMISSION_MODE
      else process.env.DSH_PERMISSION_MODE = previous
    }
  })
})
