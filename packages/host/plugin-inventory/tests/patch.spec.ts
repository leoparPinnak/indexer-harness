import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { addServerRow, readDeclaredIds, readManagedRows, toggleEntryDisabled } from '@deepseek-ai/dsh-host-plugin-inventory/src/patch.ts'

const USER_CONTENT = [
  '# user commentary stays byte-identical',
  '- insert:',
  '    - id: mcp-rea',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: rea',
  '        command: node',
  '        disabled: !!js process.env.OFF',
  '',
].join('\n')

describe('toggleEntryDisabled', () => {
  let directory: string
  let patchPath: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'dsh-mcp-toggle-'))
    patchPath = path.join(directory, 'cordis.patch.yml')
    writeFileSync(patchPath, USER_CONTENT)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('appends a managed disable row without touching user bytes', () => {
    const rows = toggleEntryDisabled(patchPath, 'mcp-rea', false)

    expect(rows).toEqual([{ id: 'mcp-rea', disabled: true }])
    const rewritten = readFileSync(patchPath, 'utf8')
    expect(rewritten.startsWith(USER_CONTENT.trimEnd())).toBe(true)
    expect(rewritten).toContain('disabled: !!js process.env.OFF')
    // The block body is flow-JSON, valid YAML for the loader's parser.
    expect(rewritten).toContain('- {"id":"mcp-rea","disabled":true}')
    expect(readManagedRows(patchPath)).toEqual([{ id: 'mcp-rea', disabled: true }])
  })

  it('is idempotent for an entry already disabled', () => {
    toggleEntryDisabled(patchPath, 'mcp-rea', false)
    const first = readFileSync(patchPath, 'utf8')
    toggleEntryDisabled(patchPath, 'mcp-rea', false)

    expect(readFileSync(patchPath, 'utf8')).toBe(first)
  })

  it('removes only the matching managed row on re-enable', () => {
    toggleEntryDisabled(patchPath, 'mcp-rea', false)
    toggleEntryDisabled(patchPath, 'mcp-web', false)

    expect(toggleEntryDisabled(patchPath, 'mcp-rea', true)).toEqual(
      [{ id: 'mcp-web', disabled: true }],
    )
    const rewritten = readFileSync(patchPath, 'utf8')
    expect(rewritten).not.toContain('"mcp-rea"')
    expect(readManagedRows(patchPath)).toEqual([{ id: 'mcp-web', disabled: true }])
  })

  it('sweeps a stale tree-qualified disable alongside the exact row', () => {
    writeFileSync(
      patchPath,
      USER_CONTENT
        + '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\n'
        + '- {"id":"include:mcp-rea","disabled":true}\n'
        + '# --- end dsh-mcp-toggle ---\n',
    )

    // The stale `include:` row was an older writer's mistake; a re-enable had
    // no key to remove it, so the server stayed off forever. Every write for
    // the entry now clears it — the disable case normalizes to the exact
    // address, the enable case removes both spellings.
    const normalized = toggleEntryDisabled(patchPath, 'mcp-rea', false)
    expect(readManagedRows(patchPath)).toEqual([{ id: 'mcp-rea', disabled: true }])
    expect(readManagedRows(patchPath)).not.toContain('include:mcp-rea')

    const enabled = toggleEntryDisabled(patchPath, 'mcp-rea', true)
    expect(enabled).toEqual([])
    expect(readManagedRows(patchPath)).toEqual([])

    void normalized
  })

  it('normalizes a stale spelling away on a disable too', () => {
    writeFileSync(
      patchPath,
      USER_CONTENT
        + '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\n'
        + '- {"id":"include:mcp-rea","disabled":true}\n'
        + '- {"id":"mcp-rea","disabled":true}\n'
        + '# --- end dsh-mcp-toggle ---\n',
    )

    expect(toggleEntryDisabled(patchPath, 'mcp-rea', false)).toEqual([{ id: 'mcp-rea', disabled: true }])
    expect(readManagedRows(patchPath)).toEqual([{ id: 'mcp-rea', disabled: true }])
  })

  it('re-enabling an entry that was never disabled is a no-op on the block', () => {
    const rows = toggleEntryDisabled(patchPath, 'mcp-rea', true)

    expect(rows).toEqual([])
    expect(readFileSync(patchPath, 'utf8')).toBe(USER_CONTENT)
  })

  it('creates the patch file when it does not exist yet', () => {
    const fresh = path.join(directory, 'fresh', 'cordis.patch.yml')

    expect(toggleEntryDisabled(fresh, 'mcp-rea', false)).toEqual([{ id: 'mcp-rea', disabled: true }])
    expect(readManagedRows(fresh)).toEqual([{ id: 'mcp-rea', disabled: true }])
  })

  it('fails loud on a managed block line it does not own', () => {
    writeFileSync(
      patchPath,
      USER_CONTENT + '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\nsurprise: true\n# --- end dsh-mcp-toggle ---\n',
    )

    expect(() => toggleEntryDisabled(patchPath, 'mcp-rea', false)).toThrow(/unrecognized managed line/)
  })

  it('treats a block missing its end marker as absent', () => {
    writeFileSync(patchPath, USER_CONTENT + '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\n- {"id":"stale","disabled":true}\n')

    toggleEntryDisabled(patchPath, 'mcp-rea', false)
    const rewritten = readFileSync(patchPath, 'utf8')
    expect(readManagedRows(patchPath)).toEqual([{ id: 'mcp-rea', disabled: true }])
    expect(rewritten).toContain('"stale"')
    expect(rewritten.match(/"stale"/g)).toHaveLength(1)
  })

  it('reads an unreachable path as absent but fails loud when writing it', () => {
    const blocker = path.join(directory, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const blocked = path.join(blocker, 'cordis.patch.yml')

    // The read side treats any ENOENT (including one under a file parent) as
    // "no patch file yet"; the write side must refuse loudly instead of
    // creating anything through a non-directory parent.
    expect(readManagedRows(blocked)).toEqual([])
    expect(() => toggleEntryDisabled(blocked, 'mcp-rea', false)).toThrow()
  })

  it('fails loud when the patch path cannot be read for a reason other than absence', () => {
    // A directory is present but unreadable as a file: absence is the only
    // condition that may pass silently.
    const asDirectory = path.join(directory, 'a-directory')
    mkdirSync(asDirectory)

    expect(() => readManagedRows(asDirectory)).toThrow(/EISDIR|directory/i)
    expect(() => toggleEntryDisabled(asDirectory, 'mcp-rea', false)).toThrow(/EISDIR|directory/i)
  })

  it('preserves user bytes that follow the managed block', () => {
    toggleEntryDisabled(patchPath, 'mcp-rea', false)
    appendFileSync(patchPath, '\n# trailing commentary\n- id: unrelated\n')

    toggleEntryDisabled(patchPath, 'mcp-web', false)

    const rewritten = readFileSync(patchPath, 'utf8')
    expect(rewritten).toContain('# trailing commentary')
    expect(rewritten.trimEnd().endsWith('- id: unrelated')).toBe(true)
    expect(readManagedRows(patchPath)).toEqual([
      { id: 'mcp-rea', disabled: true },
      { id: 'mcp-web', disabled: true },
    ])
  })

  it('leaves an empty managed block when the last disabled entry is re-enabled', () => {
    toggleEntryDisabled(patchPath, 'mcp-rea', false)

    expect(toggleEntryDisabled(patchPath, 'mcp-rea', true)).toEqual([])

    const rewritten = readFileSync(patchPath, 'utf8')
    expect(rewritten).toContain('# --- dsh-mcp-toggle: managed block (id-targeted disables) ---')
    // The user's own `- id: mcp-rea` insert row stays; only the managed row goes.
    expect(rewritten).not.toContain('"mcp-rea"')
    expect(readManagedRows(patchPath)).toEqual([])
  })

  it('upgrades legacy text rows on the first write', () => {
    writeFileSync(
      patchPath,
      USER_CONTENT
        + '# --- dsh-mcp-toggle: managed block (id-targeted disables) ---\n'
        + '- id: include:mcp-rea\n'
        + '  disabled: true\n'
        + '- id: mcp-rea\n'
        + '  disabled: true\n'
        + '# --- end dsh-mcp-toggle ---\n',
    )

    // Both stale rows came from older writers; readManagedRows decodes them,
    // and the first enabled write replaces the whole block with the uniform
    // flow-JSON shape.
    expect(readManagedRows(patchPath)).toEqual([
      { id: 'include:mcp-rea', disabled: true },
      { id: 'mcp-rea', disabled: true },
    ])
    toggleEntryDisabled(patchPath, 'mcp-rea', true)
    const rewritten = readFileSync(patchPath, 'utf8')
    // Both stale spellings are gone, and the block is uniform flow-JSON —
    // with the entry re-enabled the block holds nothing at all.
    expect(rewritten).not.toContain('include:mcp-rea')
    expect(readManagedRows(patchPath)).toEqual([])
    expect(rewritten.match(/- \{"id":/g)).toBeNull()
  })
})

describe('addServerRow', () => {
  let directory: string
  let patchPath: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'dsh-mcp-add-'))
    patchPath = path.join(directory, 'cordis.patch.yml')
    writeFileSync(patchPath, USER_CONTENT)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes one insert row whose flow-JSON the loader parses as a patch item', () => {
    const rows = addServerRow(patchPath, {
      id: 'mcp-github',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'github',
        transport: 'stdio',
        command: 'C:/Program Files/npx.cmd',
        args: ['arg with spaces', "quote'arg"],
        env: { TOKEN: 'value with spaces' },
        toolCallTimeoutMs: 90_000,
      },
    })

    expect(rows.map(row => 'insert' in row ? row.insert[0]?.id : row.id)).toEqual(['mcp-github'])
    const body = readFileSync(patchPath, 'utf8').split('\n')
    const item = body.find(line => line.startsWith('- {"insert":'))!
    expect(JSON.parse(item.slice(2))).toEqual({
      insert: [{
        id: 'mcp-github',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'github',
          transport: 'stdio',
          command: 'C:/Program Files/npx.cmd',
          args: ['arg with spaces', "quote'arg"],
          env: { TOKEN: 'value with spaces' },
          toolCallTimeoutMs: 90_000,
        },
      }],
    })
    expect(readDeclaredIds(patchPath)).toEqual(new Set(['mcp-github']))
  })

  it('appends beside an existing managed disable without touching user bytes', () => {
    toggleEntryDisabled(patchPath, 'mcp-rea', false)

    addServerRow(patchPath, {
      id: 'mcp-github',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'github', transport: 'streamable-http', url: 'http://github.local/mcp' },
    })

    const rewritten = readFileSync(patchPath, 'utf8')
    // The append lands inside the managed block: the user region — everything
    // before the begin marker — is byte-identical.
    expect(rewritten.startsWith(USER_CONTENT.trimEnd())).toBe(true)
    expect(readManagedRows(patchPath)).toEqual([
      { id: 'mcp-rea', disabled: true },
      { insert: [{ id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'github', transport: 'streamable-http', url: 'http://github.local/mcp' } }] },
    ])
  })
})
