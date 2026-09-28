/**
 * @deepseek-ai/dsh-cdp/adapters — Polymorphic Site Adapters.
 * Provides data-driven site profiles that declare URL matching rules,
 * semantic CSS selectors, DOM extraction helpers, and stealth overrides.
 * The registry resolves matching adapters dynamically with a universal fallback.
 *
 * @module @deepseek-ai/dsh-cdp/adapters
 */

import type { StealthOptions } from './stealth.ts'
import type { CdpSnapshot, CdpWovenNode } from './snapshot.ts'

/**
 * Standard semantic selector roles mapped to site-specific CSS selectors.
 */
export interface AdapterSelectors {
  /** Search or query input field. */
  readonly searchInput?: string | undefined
  /** Primary submission or action button. */
  readonly submitButton?: string | undefined
  /** Main article, body, or results container. */
  readonly contentArea?: string | undefined
  /** Next page pagination button or link. */
  readonly paginationNext?: string | undefined
  /** Authentication or sign-in link/button. */
  readonly loginButton?: string | undefined
  /** Additional site-specific named selectors. */
  readonly [custom: string]: string | undefined
}

/**
 * Definition of a polymorphic site adapter.
 */
export interface SiteAdapter {
  /** Unique identifier for the adapter (e.g. 'github', 'wikipedia'). */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** URL pattern or predicate function to determine if this adapter applies. */
  readonly match: (url: string) => boolean
  /** Declared semantic selectors for standard page interactions. */
  readonly selectors: AdapterSelectors
  /** Optional custom stealth overrides tuned for this domain. */
  readonly stealthOverrides?: Partial<StealthOptions> | undefined
  /** Recommended minimum delay between human actions in milliseconds. */
  readonly actionDelayMs?: number | undefined
  /**
   * Optional extractor to pull structured data from a woven DOM snapshot.
   * @param snapshot - the woven snapshot of the page.
   * @returns extracted structured record.
   */
  readonly extract?: ((snapshot: CdpSnapshot) => Record<string, unknown>) | undefined
}

/**
 * Default generic HTML5 adapter used when no specialized adapter matches.
 */
export const DEFAULT_HTML_ADAPTER: SiteAdapter = {
  id: 'generic-html',
  name: 'Generic HTML5',
  match: () => true,
  selectors: {
    searchInput: 'input[type="search"], input[name="q"], input[name="search"], input[type="text"]',
    submitButton: 'button[type="submit"], input[type="submit"]',
    contentArea: 'main, article, [role="main"], #content, .content',
    paginationNext: 'a[rel="next"], [aria-label*="next" i], .pagination-next',
    loginButton: 'a[href*="login" i], a[href*="signin" i], button:has-text("Sign in")',
  },
  actionDelayMs: 250,
}

/**
 * Built-in adapter for GitHub.
 */
export const GITHUB_ADAPTER: SiteAdapter = {
  id: 'github',
  name: 'GitHub',
  match: (url: string) => {
    try {
      const parsed = new URL(url)
      return parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com')
    } catch {
      return false
    }
  },
  selectors: {
    searchInput: 'input[data-target*="QueryBuilder"], input[name="query-builder-test"]',
    submitButton: 'button[type="submit"]',
    contentArea: 'main, #js-repo-pjax-container, .repository-content',
    paginationNext: '.pagination a:last-child',
    loginButton: 'a[href*="/login"]',
  },
  extract: (snapshot: CdpSnapshot) => {
    const titles = snapshot.nodes
      .filter((n: CdpWovenNode) => n.role === 'heading')
      .map((n: CdpWovenNode) => n.name)
    return { titles }
  },
  actionDelayMs: 300,
}

/**
 * Built-in adapter for Wikipedia.
 */
export const WIKIPEDIA_ADAPTER: SiteAdapter = {
  id: 'wikipedia',
  name: 'Wikipedia',
  match: (url: string) => {
    try {
      const parsed = new URL(url)
      return parsed.hostname === 'wikipedia.org' || parsed.hostname.endsWith('.wikipedia.org')
    } catch {
      return false
    }
  },
  selectors: {
    searchInput: 'input#searchInput, input[name="search"]',
    submitButton: 'input#searchButton, button.cdx-search-input__end-button',
    contentArea: '#mw-content-text, #bodyContent',
    paginationNext: 'a.mw-nextlink',
    loginButton: '#pt-login a',
  },
  extract: (snapshot: CdpSnapshot) => {
    const mainHeading = snapshot.nodes.find((n: CdpWovenNode) => n.role === 'heading' && n.name.length > 0)
    return { title: mainHeading?.name ?? snapshot.title }
  },
  actionDelayMs: 200,
}

/**
 * Built-in adapter for Hacker News.
 */
export const HACKER_NEWS_ADAPTER: SiteAdapter = {
  id: 'hackernews',
  name: 'Hacker News',
  match: (url: string) => {
    try {
      const parsed = new URL(url)
      return parsed.hostname === 'news.ycombinator.com'
    } catch {
      return false
    }
  },
  selectors: {
    searchInput: 'input[name="q"]',
    contentArea: 'table.itemlist',
    paginationNext: 'a.morelink',
    loginButton: 'a[href*="login"]',
  },
  actionDelayMs: 150,
}

/**
 * Registry of polymorphic site adapters.
 */
export class AdapterRegistry {
  private readonly adapters: SiteAdapter[] = []

  constructor(initialAdapters: readonly SiteAdapter[] = [GITHUB_ADAPTER, WIKIPEDIA_ADAPTER, HACKER_NEWS_ADAPTER]) {
    this.adapters.push(...initialAdapters)
  }

  /**
   * Register a custom site adapter. Returns a disposer function.
   * @param adapter - the adapter to register.
   * @returns disposal function to unregister.
   */
  register(adapter: SiteAdapter): () => void {
    this.adapters.unshift(adapter) // Custom adapters take precedence over defaults
    return () => {
      const index = this.adapters.indexOf(adapter)
      if (index !== -1) {
        this.adapters.splice(index, 1)
      }
    }
  }

  /**
   * Resolve the best matching site adapter for a given URL.
   * Falls back to {@link DEFAULT_HTML_ADAPTER} if no specific adapter matches.
   * @param url - URL of the target page.
   * @returns matching or fallback adapter.
   */
  resolve(url: string): SiteAdapter {
    for (const adapter of this.adapters) {
      if (adapter.match(url)) {
        return adapter
      }
    }
    return DEFAULT_HTML_ADAPTER
  }

  /**
   * List all currently registered adapters.
   * @returns registered adapters in precedence order.
   */
  list(): readonly SiteAdapter[] {
    return [...this.adapters]
  }
}
