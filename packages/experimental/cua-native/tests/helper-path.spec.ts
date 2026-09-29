/** Helper path resolution: explicit > env > package bin > repo bin, fail loud. */

import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolveHelperPath, resolveHelperPathFrom } from '../src/helper-path.ts'

const STUB = fileURLToPath(new URL('./fixtures/helper-stub.mjs', import.meta.url))
const savedEnv = process.env['CUA_HELPER_PATH']

afterEach(() => {
  if (savedEnv === undefined) delete process.env['CUA_HELPER_PATH']
  else process.env['CUA_HELPER_PATH'] = savedEnv
})

describe('resolveHelperPathFrom', () => {
  it('prefers the explicit path over every other candidate', () => {
    const resolved = resolveHelperPathFrom(
      { helperPath: '/explicit/helper.exe', envHelperPath: '/env/helper.exe', packageBin: '/pkg/helper.exe', repoBin: '/repo/helper.exe' },
      () => true,
    )
    expect(resolved).toBe('/explicit/helper.exe')
  })

  it('fails loud naming an explicit path that does not exist', () => {
    expect(() => resolveHelperPathFrom({ helperPath: '/missing/helper.exe' }, () => false)).toThrow(
      /helperPath does not exist: \/missing\/helper\.exe/u,
    )
  })

  it('uses the env override when no explicit path is given', () => {
    const resolved = resolveHelperPathFrom({ envHelperPath: '/env/helper.exe', packageBin: '/pkg/helper.exe' }, () => true)
    expect(resolved).toBe('/env/helper.exe')
  })

  it('fails loud naming a broken CUA_HELPER_PATH override', () => {
    expect(() => resolveHelperPathFrom({ envHelperPath: '/broken/helper.exe' }, () => false)).toThrow(
      /CUA_HELPER_PATH does not exist/u,
    )
  })

  it('walks package bin before repo bin', () => {
    const seen: string[] = []
    const resolved = resolveHelperPathFrom(
      { packageBin: '/pkg/helper.exe', repoBin: '/repo/helper.exe' },
      (candidate) => {
        seen.push(candidate)
        return candidate === '/repo/helper.exe'
      },
    )
    expect(resolved).toBe('/repo/helper.exe')
    expect(seen).toEqual(['/pkg/helper.exe', '/repo/helper.exe'])
  })

  it('points at the offline build when nothing exists', () => {
    expect(() => resolveHelperPathFrom({}, () => false)).toThrow(/native\/cua\/build\.cmd/u)
    expect(() => resolveHelperPathFrom({}, () => false)).toThrow(/CUA_HELPER_PATH/u)
  })
})

describe('resolveHelperPath (real candidates)', () => {
  it('honours the live CUA_HELPER_PATH environment override', () => {
    process.env['CUA_HELPER_PATH'] = STUB
    expect(resolveHelperPath()).toBe(STUB)
  })

  it('resolves to a prebuilt helper on this machine', () => {
    delete process.env['CUA_HELPER_PATH']
    const resolved = resolveHelperPath()
    expect(resolved).toMatch(/cua-helper\.exe$/u)
  })
})
