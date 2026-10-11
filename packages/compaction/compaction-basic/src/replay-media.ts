/**
 * Compaction replay media policy and accounting. Inline base64 never reaches
 * the summarizer, and only the NEWEST image block is replayed as a real image;
 * every earlier image becomes an explicit placeholder. The same walk COUNTS
 * what it withholds — image inventory (with preview identities), scrubbed
 * base64 runs, and the payload characters kept out of the request — so the
 * committed summary can carry a durable media report.
 *
 * @module
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type {
  CompactionMediaPreview,
  CompactionMediaReport,
} from '@deepseek-ai/dsh-compaction/types'

export type { CompactionMediaPreview, CompactionMediaReport }

/** Characters per token used for the rough media-saving estimate. */
const CHARACTERS_PER_TOKEN_ESTIMATE = 4

/** Free text shorter than this cannot hide a marker-worthy base64 payload. */
const BASE64_MARK_THRESHOLD = 256

/** A `data:*;base64,` payload of marker-worthy length inside free text. */
const DATA_URI_BASE64_PATTERN = /data:[\w.+#/-]*;base64,[A-Za-z0-9+/=]{256,}/g

/** A JSON string value of marker-worthy length that looks like raw base64. */
const JSON_BASE64_VALUE_PATTERN = /"[^"\n]{1,64}"\s*:\s*"[A-Za-z0-9+/=]{256,}"/g

/** Stand-in text for one scrubbed inline base64 payload. */
function base64Marker(characters: number): string {
  return `[inline base64 omitted at compaction: ${characters} chars]`
}

/** Stand-in text block for one dropped image block. */
function imageMarker(block: Extract<ContentBlock, { type: 'image' }>): ContentBlock {
  return {
    type: 'text',
    text: `[image omitted at compaction: ${block.attachment.mediaType}, ${block.attachment.bytes} bytes]`,
  }
}

/** Mutable traversal state: image inventory and withheld-payload counters. */
interface ReplayWalkState {
  imagesSeen: number
  inlineRuns: number
  inlineCharacters: number
  prunedImageBytes: number
  previews: CompactionMediaPreview[]
}

/**
 * Replace marker-worthy inline base64 runs inside one string, counting each
 * scrubbed run into the shared walk state. Data-URI payloads keep their
 * `data:...;base64,` prefix; JSON-string values keep the key and quoting, so
 * the surrounding structure survives the scrub.
 * @param text - free text (visible text, reasoning, or raw tool arguments).
 * @param state - shared walk counters.
 * @returns the same string when nothing was scrubbed, otherwise the marked copy.
 */
function scrubBase64Runs(text: string, state: ReplayWalkState): string {
  if (text.length < BASE64_MARK_THRESHOLD) return text
  const scrubbed = text
    .replace(DATA_URI_BASE64_PATTERN, (match: string) => {
      const cut = match.lastIndexOf(',') + 1
      state.inlineRuns += 1
      state.inlineCharacters += match.length - cut
      return `${match.slice(0, cut)}${base64Marker(match.length - cut)}`
    })
    .replace(JSON_BASE64_VALUE_PATTERN, (match: string) => {
      const cut = match.lastIndexOf('":"') + 3
      state.inlineRuns += 1
      state.inlineCharacters += match.length - cut - 1
      return `${match.slice(0, cut)}${base64Marker(match.length - cut - 1)}"`
    })
  return scrubbed === text ? text : scrubbed
}

/** Count every replayed image block, including tool-result nests. */
function countImageBlocks(blocks: readonly ContentBlock[]): number {
  let count = 0
  for (const block of blocks) {
    if (block.type === 'image') count += 1
    else if (block.type === 'tool-result') count += countImageBlocks(block.content)
  }
  return count
}

/** Preview identity for one walked image block. */
function previewOf(
  block: Extract<ContentBlock, { type: 'image' }>,
  disposition: 'kept' | 'pruned',
): CompactionMediaPreview {
  const attachment = block.attachment as {
    attachmentId: unknown
    name?: unknown
    mediaType: string
    bytes: number
  }
  return {
    attachmentId: String(attachment.attachmentId),
    name: typeof attachment.name === 'string' ? attachment.name : null,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    disposition,
  }
}

/**
 * Sanitize one block list in replay order: scrub every inline base64 run,
 * keep only the image block whose ordinal equals `keepIndex`, and mark the
 * rest. Tool results recurse; tool-call arguments are scrubbed as free text.
 */
function sanitizeBlocks(
  blocks: readonly ContentBlock[],
  state: ReplayWalkState,
  keepIndex: number,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    let replacement: ContentBlock | undefined
    if (block.type === 'image') {
      const keep = state.imagesSeen === keepIndex
      state.imagesSeen += 1
      state.previews.push(previewOf(block, keep ? 'kept' : 'pruned'))
      if (!keep) state.prunedImageBytes += block.attachment.bytes
      replacement = keep ? block : imageMarker(block)
    } else if (block.type === 'tool-result') {
      const content = sanitizeBlocks(block.content, state, keepIndex)
      if (content !== block.content) replacement = { ...block, content }
    } else if (block.type === 'text' || block.type === 'reasoning') {
      const text = scrubBase64Runs(block.text, state)
      if (text !== block.text) replacement = { ...block, text }
    } else if (block.type === 'tool-call') {
      const args = scrubBase64Runs(block.arguments, state)
      if (args !== block.arguments) replacement = { ...block, arguments: args }
    }
    if (replacement !== undefined) {
      next ??= blocks.slice(0, index)
      next.push(replacement)
    } else {
      next?.push(block)
    }
  }
  return next ?? blocks as ContentBlock[]
}

/** Apply {@link sanitizeBlocks} to one message under the shared walk state. */
function sanitizeMessage(
  message: Message,
  state: ReplayWalkState,
  keepIndex: number,
): Message {
  const content = sanitizeBlocks(message.content, state, keepIndex)
  return content === message.content ? message : { ...message, content }
}

/**
 * Compaction replay media policy with accounting: inline base64 never reaches
 * the summarizer, only the NEWEST image block is replayed as a real image, and
 * the returned report inventories every image (with preview identities) and
 * everything withheld. Walk order is the replay order (head first, then
 * messages in surface order, tool results depth-first), so `keepIndex` selects
 * the chronologically last image.
 * @param head - optional system head of the replayed prefix.
 * @param messages - the replayed region messages in surface order.
 * @returns the sanitized head and messages — identity is preserved wherever
 *   nothing was scrubbed or dropped — plus the durable media report.
 */
export function sanitizeReplayMedia(
  head: Message | undefined,
  messages: readonly Message[],
): { head: Message | undefined; messages: Message[]; media: CompactionMediaReport } {
  const totalImages = (head === undefined ? 0 : countImageBlocks(head.content))
    + messages.reduce((count, message) => count + countImageBlocks(message.content), 0)
  const keepIndex = totalImages - 1
  const state: ReplayWalkState = {
    imagesSeen: 0,
    inlineRuns: 0,
    inlineCharacters: 0,
    prunedImageBytes: 0,
    previews: [],
  }
  const sanitizedHead = head === undefined ? undefined : sanitizeMessage(head, state, keepIndex)
  const sanitizedMessages = messages.map(message => sanitizeMessage(message, state, keepIndex))
  const charactersPruned = state.inlineCharacters + state.prunedImageBytes
  return {
    head: sanitizedHead,
    messages: sanitizedMessages,
    media: {
      images: totalImages,
      imagesKept: totalImages === 0 ? 0 : 1,
      imagesPruned: totalImages === 0 ? 0 : totalImages - 1,
      inlineRunsPruned: state.inlineRuns,
      charactersPruned,
      tokensPrunedEstimate: Math.round(charactersPruned / CHARACTERS_PER_TOKEN_ESTIMATE),
      previews: state.previews,
    },
  }
}
