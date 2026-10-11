import { describe, expect, it } from 'vitest'
import {
  COMPACT_TEXT_LIMIT,
  compactNode,
  diffSnapshots,
  filterInteractive,
} from '../src/snapshot-view.ts'
import type { CdpWovenNode } from '../src/snapshot.ts'

function node(ref: string, over: Partial<CdpWovenNode> = {}): CdpWovenNode {
  return { ref, role: 'StaticText', name: ref, interactive: false, visible: true, ...over }
}

describe('snapshot-view: lenses', () => {
  it('filterInteractive keeps only operable entries', () => {
    const nodes = [
      node('a', { interactive: true, role: 'button' }),
      node('b'),
      node('c', { interactive: true, role: 'link' }),
    ]
    expect(filterInteractive(nodes).map(n => n.ref)).toEqual(['a', 'c'])
  })

  it('compactNode clips name and value to the limit with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const slim = compactNode(node('a', { name: long, value: long, role: 'textbox', interactive: true }))
    expect(slim.name).toHaveLength(COMPACT_TEXT_LIMIT)
    expect(slim.name.endsWith('…')).toBe(true)
    expect(slim.value).toHaveLength(COMPACT_TEXT_LIMIT)
    // short text survives untouched — clipping only ever cuts.
    const short = compactNode(node('b', { name: 'ok' }))
    expect(short.name).toBe('ok')
  })
})

describe('snapshot-view: diffSnapshots', () => {
  it('partitions added, removed, changed, unchanged by ref', () => {
    const previous = [
      node('keep'),
      node('gone'),
      node('moved', { role: 'textbox', interactive: true, name: 'moved', value: 'old' }),
    ]
    const current = [
      node('keep'),
      node('fresh'),
      node('moved', { role: 'textbox', interactive: true, name: 'moved', value: 'new' }),
    ]
    const delta = diffSnapshots(previous, current)
    expect(delta.added.map(n => n.ref)).toEqual(['fresh'])
    expect(delta.removed.map(n => n.ref)).toEqual(['gone'])
    expect(delta.changed).toEqual([{ ref: 'moved', role: 'textbox', name: 'moved', was: 'old' }])
    expect(delta.unchangedCount).toBe(1)
  })

  it('a name change yields a NEW ref — honest removed+added, not changed', () => {
    // The woven ref carries role|name|ordinal, so a rename is a different ref.
    const previous = [node('button|Eski|0', { role: 'button', name: 'Eski', interactive: true })]
    const current = [node('button|Yeni|0', { role: 'button', name: 'Yeni', interactive: true })]
    const delta = diffSnapshots(previous, current)
    expect(delta.added.map(n => n.ref)).toEqual(['button|Yeni|0'])
    expect(delta.removed.map(n => n.ref)).toEqual(['button|Eski|0'])
    expect(delta.changed).toEqual([])
    expect(delta.unchangedCount).toBe(0)
  })

  it('identical models diff to an empty delta', () => {
    const nodes = [node('a'), node('b', { value: 'v' })]
    const delta = diffSnapshots(nodes, nodes)
    expect(delta.added).toEqual([])
    expect(delta.removed).toEqual([])
    expect(delta.changed).toEqual([])
    expect(delta.unchangedCount).toBe(2)
  })
})
