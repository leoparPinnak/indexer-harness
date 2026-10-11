// Live DOM proof of the operator RESUME control in the shipped Web UI.
//
// Two seeded journal shapes drive the two honest states of the composer slot:
//   A) READY — a recorded cut (its final `turn/end` is `aborted/user`) with one
//      COMPLETED `assistant/message` ahead of it: the "Devam" pill MUST appear
//      with its checkpoint identity, and pressing it MUST open a continuation
//      turn (`turn/start.continuation`) that re-drives from the checkpoint in
//      the same flow (`request/header {reason:'series'}`).
//   B) NO-CHECKPOINT — the same cut shape with every settlement stripped: the
//      control MUST NOT vanish silently; a DIMMED pill carrying the reason is
//      the contractual behavior ("never hide without a word").
//
// Both scenes boot the REAL assembled Web artifact through the standard
// scaffold and speak through the REAL journal readers — these are eye-grade
// DOM assertions on a live GUI instance, not unit echoes. The journal verdict
// (the same shared fold the Host and the button use) is the comparison axis:
// if DOM and journal disagree, the failing message names both sides.

import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { evaluateResumeState } from '@deepseek-ai/dsh-session/types'
import { newEnglishPage, saveFailureShot } from './support.ts'

const RECORDED = fileURLToPath(new URL('../../../snapshots/acp/cancel-tool-calls/session.v3.jsonl', import.meta.url))
const SNAP_READY = fileURLToPath(new URL('../../../snapshots/web/resume-after-cut', import.meta.url))
const SNAP_BLOCKED = fileURLToPath(new URL('../../../snapshots/web/resume-no-checkpoint', import.meta.url))
const MODE = webSnapshotMode()
const READY_ID = 'resume-after-cut-web-e2e'
const BLOCKED_ID = 'resume-no-checkpoint-web-e2e'

type PersistedId = Parameters<typeof readPersistedEvents>[1]

/**
 * Recompute the RESUME verdict over the PERSISTED journal with the same shared
 * fold the Host and the button use — the comparison axis for DOM assertions.
 * @param scaffold - the booted scaffold holding the session.
 * @param id - the seeded session id.
 * @returns the folded verdict (shape-tolerant read).
 */
async function journalVerdict(scaffold: WebScaffold, id: string): Promise<{ kind: string }> {
  const events = await readPersistedEvents(scaffold, id as unknown as PersistedId)
  return evaluateResumeState(events as Parameters<typeof evaluateResumeState>[0]) as { kind: string }
}

/**
 * Strip every settlement-bearing line from a recorded journal: what remains is
 * a cut with NO completed model request — the `no-checkpoint` verdict shape.
 * @param lines - raw JSONL lines of the recording.
 * @returns the filtered fixture text.
 */
function withoutSettlements(lines: readonly string[]): string {
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    const type = (JSON.parse(trimmed) as { type?: string }).type
    return type !== 'assistant/message'
      && type !== 'tool/call'
      && type !== 'tool/result'
  })
  return [...kept, ''].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: RESUME control after a cut', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(RECORDED, 'utf8'), READY_ID)
    await mkdir(SNAP_READY, { recursive: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the active Devam pill with its checkpoint, and pressing it dispatches the continuation from that checkpoint', async () => {
    onTestFailed(async () => { await saveFailureShot(page, 'resume-ready') })

    // Authoritative comparison axis: the SAME shared fold over the persisted
    // journal must agree with what the DOM renders — a divergence names the
    // guilty layer outright (fold vs feed vs UI).
    const verdict = await journalVerdict(scaffold, READY_ID)
    expect(verdict.kind, `journal verdict: ${JSON.stringify(verdict)}`).toBe('ready')
    const checkpoint = (verdict as { checkpoint?: { turn: number; step: number } }).checkpoint
    expect(checkpoint, `journal verdict: ${JSON.stringify(verdict)}`).toBeDefined()
    const expectedStamp = `${String(checkpoint?.turn)}.${String(checkpoint?.step)}`

    // DOM verdict instrumentation: the `data-resume-state` span renders on
    // EVERY path (ready/blocked/neutral), so it names the disagreement layer
    // outright when journal and page diverge (feed starvation vs mount failure).
    const stateSpan = page.locator('[data-resume-state]')
    // The verdict arrives asynchronously from the Host read; wait for the
    // state to settle on its confirmed value rather than the first paint.
    try {
      await expect
        .poll(async () => stateSpan.getAttribute('data-resume-state'), { timeout: 15_000, interval: 250 })
        .toBe('ready')
    } catch (failure) {
      const read = await page.evaluate(() => (globalThis as { __dshResumeRead?: unknown }).__dshResumeRead ?? 'HOOK-YOK')
      throw new Error(`verdict okunamadı (${JSON.stringify(read)}): ${String(failure)}`)
    }
    const domVerdict = await stateSpan.getAttribute('data-resume-state')
    const slotError = await page.locator('[data-slot-error="conversation.input.right"]').count()
    expect(
      domVerdict,
      `DOM verdict (${String(domVerdict)}) vs journal (${verdict.kind}); slot-error=${String(slotError)}`,
    ).toBe('ready')

    const pill = page.locator('[data-resume-button]')
    await pill.waitFor({ timeout: 15_000 })
    const domStamp = await pill.getAttribute('data-resume-checkpoint')
    expect(domStamp, `DOM checkpoint vs journal ${expectedStamp}`).toBe(expectedStamp)
    const state = page.locator('[data-resume-state]')
    expect(await state.getAttribute('data-resume-state')).toBe('ready')

    await pill.click()

    // Click-through contract: an ATTACHED session continues from the checkpoint
    // (`turn/start.continuation` + `request/header {reason:'series'}` — proven
    // live in the running deployment); a seeded, agent-less session cannot be
    // re-driven and must refuse HONESTLY and inline instead of failing silently.
    // Both outcomes are contractual; silence is not.
    await expect.poll(async () => {
      const events = await readPersistedEvents(scaffold, READY_ID as unknown as PersistedId)
      const continuation = events.find(event =>
        event.type === 'turn/start'
        && (event.data as { continuation?: { ofTurn?: number } }).continuation !== undefined)
      const series = events.find(event =>
        event.type === 'request/header' && (event.data as { reason?: string }).reason === 'series')
      if (continuation !== undefined && series !== undefined) return true
      return await page.locator('[data-resume-error]').count() > 0
    }, { timeout: 30_000, interval: 500 }).toBe(true)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAP_READY, 'ui.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAP_READY, ['ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

describe.skipIf(MODE === 'record')('web e2e: RESUME control without a checkpoint', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const recorded = await readFile(RECORDED, 'utf8')
    await seedSession(scaffold, withoutSettlements(recorded.split(/\r?\n/)), BLOCKED_ID)
    await mkdir(SNAP_BLOCKED, { recursive: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the dimmed reason pill instead of vanishing when the cut has no completed request', async () => {
    onTestFailed(async () => { await saveFailureShot(page, 'resume-no-checkpoint') })

    // Fixture truth first: if the journal verdict itself is not `no-checkpoint`,
    // the crafted seed is wrong (and the DOM owes the operator nothing yet).
    const verdict = await journalVerdict(scaffold, BLOCKED_ID)
    expect(verdict.kind, `journal verdict: ${JSON.stringify(verdict)}`).toBe('no-checkpoint')

    const stateSpan = page.locator('[data-resume-state]')
    await expect
      .poll(async () => stateSpan.getAttribute('data-resume-state'), { timeout: 15_000, interval: 250 })
      .toBe('no-checkpoint')
    const domVerdict = await stateSpan.getAttribute('data-resume-state')
    expect(domVerdict, `DOM verdict (${String(domVerdict)}) vs journal (${verdict.kind})`).toBe('no-checkpoint')

    const blocked = page.locator('[data-resume-blocked]')
    await blocked.waitFor({ timeout: 15_000 })
    expect(await blocked.isDisabled()).toBe(true)
    expect(await blocked.textContent()).toBe('Resume (n/a)')
    expect(await blocked.getAttribute('title')).toContain('no checkpoint')
    expect(await page.locator('[data-resume-button]').count()).toBe(0)
    const state = page.locator('[data-resume-state]')
    expect(await state.getAttribute('data-resume-state')).toBe('no-checkpoint')

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAP_BLOCKED, 'ui.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAP_BLOCKED, ['ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
