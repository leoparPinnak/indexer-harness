/**
 * D5 routing chain, exercised through the real tool registry: a hashline-shaped
 * old_string / old_str reaches the hashline core, and anything that is not a patch
 * falls through to the unchanged literal string-replace path. The same run pins the
 * edit safety layers on the hashline arm — read-before-edit still refuses before any
 * write, and a stale header reports the re-read remedy without touching the file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as StrReplace from '@deepseek-ai/dsh-tool-str-replace-editor'
import { hashlineFileHash, hashlineFormatHeader } from '../../src/index.ts'

const ORIGINAL = 'one\ntwo\nthree'
const signal = new AbortController().signal

let dir: string
let ctx: Context
let file: string
let counter = 0
// Stable actor: the observation policy keys read-before-edit per actor identity.
let agent: never

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'd5-smoke-'))
  file = join(dir, 'a.txt')
  await writeFile(file, ORIGINAL, 'utf8')
  agent = { session: { header: { cwd: dir } } } as never
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(StrReplace, {})
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function call(name: string, args: unknown) {
  return ctx.tools.execute({ signal, callId: ToolCallId(`smoke-${++counter}`), name, arguments: args, agent })
}

function bodyOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(entry => entry.type === 'text').map(entry => entry.text ?? '').join('')
}

function patchFor(content: string, ...hunks: string[]): string {
  return `${hashlineFormatHeader(file, hashlineFileHash(content))}\n${hunks.join('\n')}`
}

describe('hashline routing chain', () => {
  it('edit applies a hashline patch, then still handles a literal replacement', async () => {
    await call('read', { file_path: file })
    const hashed = await call('edit', {
      file_path: file,
      old_string: patchFor(ORIGINAL, '@@ 1', ' 1| one', '-2| two', '+TWO', ' 3| three'),
      new_string: '',
    })
    expect(hashed.isError).toBeFalsy()
    expect(await readFile(file, 'utf8')).toBe('one\nTWO\nthree')

    const literal = await call('edit', { file_path: file, old_string: 'TWO', new_string: '2' })
    expect(literal.isError).toBeFalsy()
    expect(await readFile(file, 'utf8')).toBe('one\n2\nthree')
  })

  it('edit refuses a hashline patch before the file has been read', async () => {
    const result = await call('edit', {
      file_path: file,
      old_string: patchFor(ORIGINAL, '@@ 1', ' 1| one', '-2| two', '+TWO', ' 3| three'),
      new_string: '',
    })
    expect(result.isError).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
  })

  it('edit reports a stale hashline header instead of writing', async () => {
    await call('read', { file_path: file })
    const result = await call('edit', {
      file_path: file,
      old_string: `${hashlineFormatHeader(file, hashlineFileHash('stale content'))}\n@@ 1\n 1| one\n-2| two\n+TWO\n 3| three`,
      new_string: '',
    })
    expect(result.isError).toBe(true)
    expect(bodyOf(result)).toContain('Re-read the file and try again')
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
  })

  it('str_replace_editor routes a hashline patch on the same policy', async () => {
    await call('read', { file_path: file })
    const result = await call('str_replace_editor', {
      command: 'str_replace',
      path: file,
      old_str: patchFor(ORIGINAL, '@@ 1', ' 1| one', '-2| two', '+TWO', ' 3| three'),
      new_str: '',
    })
    expect(bodyOf(result)).toContain('has been edited successfully')
    expect(await readFile(file, 'utf8')).toBe('one\nTWO\nthree')

    const literal = await call('str_replace_editor', {
      command: 'str_replace',
      path: file,
      old_str: 'TWO',
      new_str: 'two',
    })
    expect(bodyOf(literal)).toContain('has been edited successfully')
    expect(await readFile(file, 'utf8')).toBe('one\ntwo\nthree')
  })

  it('str_replace_editor keeps refusing an unread target on the hashline path', async () => {
    const result = await call('str_replace_editor', {
      command: 'str_replace',
      path: file,
      old_str: patchFor(ORIGINAL, '@@ 1', ' 1| one', '-2| two', '+TWO', ' 3| three'),
      new_str: '',
    })
    expect(result.isError).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
  })
})
