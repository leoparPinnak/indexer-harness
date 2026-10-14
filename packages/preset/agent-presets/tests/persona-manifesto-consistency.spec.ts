import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Content lines of the literal YAML block under `lines[keyLine]`, ending at the
 * first non-blank line indented less than the key's own indent plus two.
 * @param lines - a composition file already split into lines.
 * @param keyLine - index of the `key: |-` line owning the block.
 * @returns the block's lines with trailing blanks removed.
 */
function literalBlock(lines: string[], keyLine: number): string[] {
  const keyIndent = lines[keyLine]!.length - lines[keyLine]!.trimStart().length
  const blockIndent = ' '.repeat(keyIndent + 2)
  const out: string[] = []
  for (let i = keyLine + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.startsWith(blockIndent)) {
      out.push(line)
      continue
    }
    break
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop()
  return out
}

/**
 * The deployment persona block of one bundle patch.
 * @param bundle - bundle directory under `packages/bundle`.
 * @returns the `personaPrefix` block's content lines.
 */
function bundlePersona(bundle: string): string[] {
  const lines = readFileSync(join(REPO, 'packages/bundle', bundle, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  const key = lines.findIndex(line => line.trim() === 'personaPrefix: |-')
  expect(key, `${bundle} carries no literal personaPrefix`).toBeGreaterThanOrEqual(0)
  return literalBlock(lines, key)
}

/**
 * The persona prefix block of one shipped preset, keyed to its `id: persona` row.
 * @param preset - preset directory under `packages/preset/agent-presets/presets`.
 * @returns the `prefix` block's content lines.
 */
function presetPersona(preset: string): string[] {
  const lines = readFileSync(join(REPO, 'packages/preset/agent-presets/presets', preset, 'agent.cordis.yml'), 'utf8').split(/\r?\n/)
  const row = lines.findIndex(line => /^- id: persona\s*$/.test(line))
  expect(row, `${preset} mounts no persona row`).toBeGreaterThanOrEqual(0)
  let key = -1
  for (let i = row + 1; i < row + 8 && i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('prefix:')) {
      key = i
      break
    }
  }
  expect(key, `${preset} persona row carries no prefix`).toBeGreaterThanOrEqual(0)
  expect(lines[key]!.trim(), `${preset} persona prefix must stay a literal block`).toBe('prefix: |-')
  return literalBlock(lines, key)
}

describe('the user-request manifesto across deployment personas', () => {
  it('the four bundle patches carry one identical literal persona', () => {
    const reference = bundlePersona('web-app')
    expect(reference[0]).toContain('You are a coding agent powered by the {{model}} model.')
    expect(reference.join('\n')).toContain('## Request execution')
    expect(reference.join('\n')).toContain('## Reporting back')
    for (const bundle of ['headless', 'sdk-app', 'acp-app']) {
      expect(bundlePersona(bundle).join('\n'), `${bundle} diverges from web-app`).toBe(reference.join('\n'))
    }
  })

  it('the standard and ptc presets shadow the deployment persona with the same text', () => {
    const reference = bundlePersona('web-app').join('\n')
    for (const preset of ['standard', 'ptc']) {
      const block = presetPersona(preset)
      expect(block[0]).toContain('You are a coding agent powered by the {{model}} model.')
      expect(block.slice(1).join('\n'), `${preset} persona diverges from the deployment persona`).toBe(reference.split('\n').slice(1).join('\n'))
    }
  })

  it('the cordis preset carries the sections its shadowing would otherwise remove', () => {
    const block = presetPersona('cordis').join('\n')
    expect(block).toContain('## Request execution')
    expect(block).toContain('## Reporting back')
    expect(block).toContain('## Operator authority')
  })

  it('the minimal preset keeps its bare persona', () => {
    const lines = readFileSync(join(REPO, 'packages/preset/agent-presets/presets/minimal/agent.cordis.yml'), 'utf8').split(/\r?\n/)
    const prefix = lines.find(line => line.trim().startsWith('prefix:'))
    expect(prefix?.trim()).toBe('prefix: You are a helpful software engineer assistant.')
  })
})
