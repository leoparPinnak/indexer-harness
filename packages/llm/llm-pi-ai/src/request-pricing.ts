/**
 * Provider-side request-image pricing for pi-ai routes: reproduces the
 * adapter's deterministic request projection (the count window keeps the
 * newest images, the byte budget trims further oldest-first) and prices every
 * occurrence exactly as the wire represents it — retained images at the
 * standardized high-detail tile estimate, offloaded ones at their placeholder
 * text with zero visual tokens. Consumed synchronously by the token meter
 * through `LlmAdapter.imageRequestPricing`, so the context gauge reflects the
 * pruned request, not the durable history; provider usage remains the
 * authoritative anchor for completed requests.
 *
 * @module dsh-llm-pi-ai/request-pricing
 */

import { offloadedImageText, offloadedImagePrefixCount, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentAccessResolver, LlmImageRequestPrice, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Base charge of one inline image under the standard high-detail tile accounting. */
const TILE_BASE_TOKENS = 85
/** Charge of each 512px tile under the standard high-detail tile accounting. */
const TILE_TOKENS = 170
/** Tile edge in pixels. */
const TILE_SIZE = 512

const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

/**
 * Standardized high-detail tile estimate for one request image: 85 base
 * tokens plus 170 per 512px tile. The pi-ai gateway fronts models whose
 * providers publish no vision formula, so this is the widely used tile
 * accounting rather than an exact provider price; actual usage stays
 * authoritative once a request completes.
 * @param width - request-image width after the route's pixel budget.
 * @param height - request-image height after the route's pixel budget.
 * @returns the estimated vision-token price of one inline image.
 */
export function piGatewayImageTokens(width: number, height: number): number {
  const tiles = ceilDiv(width, TILE_SIZE) * ceilDiv(height, TILE_SIZE)
  return TILE_BASE_TOKENS + TILE_TOKENS * Math.max(tiles, 1)
}

/** Route facts the pricing reproduces; mirrors the adapter's request projection. */
export interface PiAiImagePricingFacts {
  /** Route count window: only the newest N images stay inline. */
  readonly maxImagesPerRequest: number
  /** Route base64 payload budget shared with request serialization. */
  readonly maxRequestImageBytes: number
  /** Route pixel budget shared with request-image preparation. */
  readonly requestImagePixelBudget: number
  /** Route encoded-byte target shared with request-image preparation. */
  readonly requestImageMaxBytes: number
  /** Whether the route accepts image input at all. */
  readonly supportsImages: boolean
  /** Current execution-world access resolution shared with request serialization. */
  readonly resolveAccess?: ImageAttachmentAccessResolver
}

/**
 * Build the request-image pricing for one pi-ai route. The offload decision is
 * computed through the same `offloadedImagePrefixCount` function the request
 * projection uses, over the same represented lengths (base64 expansion of
 * bytes capped by the route's per-image byte target), so the gauge and the
 * wire can never disagree about which occurrences were pruned. As in request
 * serialization, the second, exact post-resolution trim is not reproduced, so
 * a trimmed request can only cost less than this estimate.
 * @param facts - route budgets, modality, and access resolution.
 * @returns synchronous per-occurrence pricing for the route.
 */
export function piAiImageRequestPricing(
  facts: PiAiImagePricingFacts,
): LlmImageRequestPricing {
  if (!facts.supportsImages) {
    return { priceImages: images => images.map(textOnlyPrice) }
  }
  const dimensionsOf = (ref: ImageAttachmentRef): { width: number; height: number } =>
    requestImageDimensions(ref.width, ref.height, facts.requestImagePixelBudget)
  return {
    priceImages: (images) => {
      const offloaded = offloadedImagePrefixCount(
        // Representation matches `toPiContextWithImages`'s first stage:
        // base64 expansion of each occurrence's bytes capped by the route's
        // per-image encoded-byte target.
        images.map(ref => (Math.ceil(Math.min(ref.bytes, facts.requestImageMaxBytes) / 3) * 4)),
        {
          maxBytes: facts.maxRequestImageBytes,
          maxImages: facts.maxImagesPerRequest,
          countQuantum: 1,
          byteQuantum: 1,
        },
      )
      return images.map((ref, index): LlmImageRequestPrice => {
        if (index < offloaded) {
          return { visualTokens: 0, text: offloadedImageText(ref, facts.resolveAccess?.(ref)) }
        }
        const dimensions = dimensionsOf(ref)
        return {
          visualTokens: piGatewayImageTokens(dimensions.width, dimensions.height),
          text: requestImageHandleText(ref, dimensions, facts.resolveAccess?.(ref)),
        }
      })
    },
  }
}

/** Price one occurrence a text-only route substitutes with deterministic text. */
function textOnlyPrice(ref: ImageAttachmentRef): LlmImageRequestPrice {
  return { visualTokens: 0, text: textOnlyImageText(ref) }
}
