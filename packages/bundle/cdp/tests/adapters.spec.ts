/**
 * Unit tests for polymorphic site adapters: URL matching, fallback resolution,
 * custom adapter precedence and registration lifecycle, and structured extraction.
 */

import { describe, expect, it } from 'vitest'
import {
  AdapterRegistry,
  DEFAULT_HTML_ADAPTER,
  GITHUB_ADAPTER,
  HACKER_NEWS_ADAPTER,
  WIKIPEDIA_ADAPTER,
  type SiteAdapter,
} from '../src/adapters.ts'
import type { CdpSnapshot } from '../src/snapshot.ts'

describe('AdapterRegistry', () => {
  it('resolves built-in adapters for matching URLs', () => {
    const registry = new AdapterRegistry()

    expect(registry.resolve('https://github.com/deepseek-ai/deepseek-harness').id).toBe('github')
    expect(registry.resolve('https://en.wikipedia.org/wiki/Chrome_DevTools_Protocol').id).toBe('wikipedia')
    expect(registry.resolve('https://news.ycombinator.com/item?id=12345').id).toBe(HACKER_NEWS_ADAPTER.id)
  })

  it('falls back to DEFAULT_HTML_ADAPTER for unknown URLs', () => {
    const registry = new AdapterRegistry()
    const resolved = registry.resolve('https://unknown-domain-xyz.com/dashboard')
    expect(resolved.id).toBe(DEFAULT_HTML_ADAPTER.id)
    expect(resolved.selectors.searchInput).toBeDefined()
    expect(resolved.selectors.contentArea).toBeDefined()
  })

  it('allows registering custom adapters with higher precedence and cleanly unregistering', () => {
    const registry = new AdapterRegistry()

    const customGitHub: SiteAdapter = {
      id: 'custom-github',
      name: 'Custom GitHub Override',
      match: url => url.includes('github.com'),
      selectors: { searchInput: '#custom-search' },
    }

    const unregister = registry.register(customGitHub)
    expect(registry.resolve('https://github.com/my-repo').id).toBe('custom-github')
    expect(registry.resolve('https://github.com/my-repo').selectors.searchInput).toBe('#custom-search')

    // Dispose custom adapter
    unregister()
    expect(registry.resolve('https://github.com/my-repo').id).toBe('github')
  })

  it('executes data extractor correctly on woven snapshots', () => {
    const dummySnapshot: CdpSnapshot = {
      title: 'Wikipedia Page',
      url: 'https://en.wikipedia.org/wiki/Test',
      viewport: { width: 1280, height: 800 },
      counts: { totalNodes: 2, returnedNodes: 2, interactiveNodes: 0, visibleNodes: 2 },
      truncated: false,
      nodeLimitTruncated: false,
      textLimitTruncated: false,
      sizeLimitTruncated: false,
      nodes: [
        { ref: 'h1|Test|0', role: 'heading', name: 'Test Article Heading', interactive: false, visible: true },
        { ref: 'p|text|0', role: 'paragraph', name: 'Some text', interactive: false, visible: true },
      ],
    }

    const res = WIKIPEDIA_ADAPTER.extract!(dummySnapshot)
    expect(res).toEqual({ title: 'Test Article Heading' })

    const ghRes = GITHUB_ADAPTER.extract!(dummySnapshot)
    expect(ghRes).toEqual({ titles: ['Test Article Heading'] })
  })
})
