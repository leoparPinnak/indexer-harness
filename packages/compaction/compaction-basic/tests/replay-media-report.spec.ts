/**
 * Compaction replay media accounting: the policy walk counts every image it
 * inventories and every payload it withholds, and reports preview identities
 * the clients feed to their image loaders. Pure walk — no session harness.
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { sanitizeReplayMedia } from '../src/replay-media.ts'

interface FakeImageAttachment {
  attachmentId: string
  name?: string
  mediaType: string
  bytes: number
}

function image(id: string, bytes: number, name?: string): { type: 'image'; attachment: FakeImageAttachment } {
  return {
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes, ...(name === undefined ? {} : { name }) },
  }
}

function userMessage(content: unknown[]): Message {
  return { role: 'user', content } as unknown as Message
}

describe('sanitizeReplayMedia accounting', () => {
  it('keeps only the newest image and inventories the rest as placeholders', () => {
    const { media, messages } = sanitizeReplayMedia(undefined, [
      userMessage([image('a1', 100, 'one.png'), image('a2', 200)]),
      userMessage([image('a3', 300, 'three.png'), { type: 'text', text: 'tail' }]),
    ])

    expect(media.images).toBe(3)
    expect(media.imagesKept).toBe(1)
    expect(media.imagesPruned).toBe(2)
    // The chronologically LAST image survives; earlier ones become markers.
    expect(media.previews.map(preview => preview.disposition)).toEqual(['pruned', 'pruned', 'kept'])
    expect(media.previews[0]).toEqual({
      attachmentId: 'a1',
      name: 'one.png',
      mediaType: 'image/png',
      bytes: 100,
      disposition: 'pruned',
    })
    expect(media.previews[1]?.name).toBeNull()
    expect(messages[0]?.content.some(block => block.type === 'text')).toBe(true)
  })

  it('counts scrubbed inline base64 runs and estimates the recovered tokens', () => {
    const base64 = 'A'.repeat(400)
    const { media } = sanitizeReplayMedia(undefined, [
      userMessage([{ type: 'text', text: `prefix data:image/png;base64,${base64} suffix` }]),
    ])

    expect(media.inlineRunsPruned).toBe(1)
    expect(media.charactersPruned).toBe(base64.length)
    expect(media.tokensPrunedEstimate).toBe(Math.round(base64.length / 4))
  })

  it('combines pruned image bytes and scrubbed characters into one recovery figure', () => {
    const base64 = 'A'.repeat(300)
    const { media } = sanitizeReplayMedia(undefined, [
      userMessage([image('a1', 500), image('a2', 700)]),
      userMessage([{ type: 'text', text: `data:image/png;base64,${base64}` }]),
    ])

    expect(media.imagesPruned).toBe(1)
    expect(media.charactersPruned).toBe(500 + base64.length)
    expect(media.tokensPrunedEstimate).toBe(Math.round((500 + base64.length) / 4))
    // The partition invariant the durable validator enforces:
    expect(media.imagesKept + media.imagesPruned).toBe(media.images)
  })

  it('reports an empty inventory for image-free spans', () => {
    const { media } = sanitizeReplayMedia(undefined, [userMessage([{ type: 'text', text: 'plain' }])])
    expect(media).toEqual({
      images: 0,
      imagesKept: 0,
      imagesPruned: 0,
      inlineRunsPruned: 0,
      charactersPruned: 0,
      tokensPrunedEstimate: 0,
      previews: [],
    })
  })
})
