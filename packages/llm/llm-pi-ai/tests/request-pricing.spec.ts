import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  createUserMessage,
  offloadedImagePrefixCount,
  offloadedImageText,
  offloadRequestImagesWithPolicy,
} from '@deepseek-ai/dsh-llm'
import { piAiImageRequestPricing, piGatewayImageTokens } from '../src/request-pricing.ts'
import type { PiAiImagePricingFacts } from '../src/request-pricing.ts'

function image(index: number, bytes = 3_000): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${String(index).repeat(64)}`),
    mediaType: 'image/png',
    bytes,
    width: 1024,
    height: 1024,
  }
}

function facts(overrides: Partial<PiAiImagePricingFacts> = {}): PiAiImagePricingFacts {
  return {
    maxImagesPerRequest: 1,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    supportsImages: true,
    ...overrides,
  }
}

describe('pi-ai request-image pricing', () => {
  it('keeps only the newest image visual under the default window of one', () => {
    const prices = piAiImageRequestPricing(facts()).priceImages([image(1), image(2), image(3)])

    expect(prices).toHaveLength(3)
    expect(prices[0]).toEqual({ visualTokens: 0, text: expect.stringContaining('omitted to fit request image limits') })
    expect(prices[1]).toEqual({ visualTokens: 0, text: expect.stringContaining('omitted to fit request image limits') })
    expect(prices[2]!.visualTokens).toBeGreaterThan(0)
    expect(prices[2]!.text).toContain('request preview')
  })

  it('reproduces the request projection offload prefix exactly', () => {
    const images = [image(1), image(2), image(3), image(4), image(5)]
    for (const maxImagesPerRequest of [1, 2, 4]) {
      const policy = facts({ maxImagesPerRequest })
      const prices = piAiImageRequestPricing(policy).priceImages(images)
      const expected = offloadedImagePrefixCount(
        images.map(ref => Math.ceil(Math.min(ref.bytes, policy.requestImageMaxBytes) / 3) * 4),
        { maxBytes: policy.maxRequestImageBytes, maxImages: maxImagesPerRequest, countQuantum: 1, byteQuantum: 1 },
      )
      expect(prices.filter(price => price.visualTokens === 0
        && price.text.includes('omitted to fit request image limits'))).toHaveLength(expected)
    }
  })

  it('prices every occurrence as the text-only substitution for a non-image route', () => {
    const prices = piAiImageRequestPricing(facts({ supportsImages: false })).priceImages([image(1), image(2)])
    expect(prices).toEqual([
      { visualTokens: 0, text: expect.stringContaining('text only') },
      { visualTokens: 0, text: expect.stringContaining('text only') },
    ])
  })

  it('trims oldest-first under the byte budget with zero-token placeholders', () => {
    const prices = piAiImageRequestPricing(facts({
      maxImagesPerRequest: 8,
      maxRequestImageBytes: Math.ceil(3_000 / 3) * 4 * 2,
    })).priceImages([image(1), image(2), image(3)])
    expect(prices[0]!.visualTokens).toBe(0)
    expect(prices[1]!.visualTokens).toBeGreaterThan(0)
    expect(prices[2]!.visualTokens).toBeGreaterThan(0)
  })

  it('prices retained images by the standardized tile accounting', () => {
    expect(piGatewayImageTokens(512, 512)).toBe(85 + 170)
    expect(piGatewayImageTokens(1024, 1024)).toBe(85 + 170 * 4)
  })

  it('reproduces the real wire projection placeholder-for-placeholder', () => {
    // Keystones the gauge to the wire: the same inputs run through the real
    // request projection `toPiContextWithImages` uses, and the two must agree
    // about every placeholder, or the context gauge silently drifts from the
    // request the provider actually receives.
    const policy = facts({ maxImagesPerRequest: 2 })
    const messages = [1, 2, 3, 4].map(index => createUserMessage({
      content: [{ type: 'image', attachment: image(index) }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    const wire = offloadRequestImagesWithPolicy(messages, {
      representation: 'base64',
      maxBytes: policy.maxRequestImageBytes,
      maxImages: policy.maxImagesPerRequest,
      countQuantum: 1,
      byteQuantum: 1,
      byteLength: ref => Math.min(ref.bytes, policy.requestImageMaxBytes),
      placeholder: ref => offloadedImageText(ref),
    })
    const wirePlaceholders = JSON.stringify(wire).split('omitted to fit request image limits').length - 1
    const prices = piAiImageRequestPricing(policy).priceImages([image(1), image(2), image(3), image(4)])
    const pricedPlaceholders = prices.filter(price => price.visualTokens === 0
      && price.text.includes('omitted to fit request image limits')).length
    expect(wirePlaceholders).toBe(2)
    expect(pricedPlaceholders).toBe(wirePlaceholders)
  })
})
