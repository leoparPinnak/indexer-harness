/**
 * Bundled `shellbox` skill provider: the Shellbox usage manual the model
 * loads on demand from the skill catalog, and the user reads by typing
 * `/shellbox`.
 *
 * @module @deepseek-ai/dsh-deamon/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'shellbox'
const SKILL_BODY_URL = new URL('../assets/shellbox.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Operate the DSH Shellbox isolated Windows desktop: launch GUI apps with shellbox_launch, review desktop changes with shellbox_state, send mouse and keyboard input with shellbox_input, troubleshoot the live Shellbox tab stream and vmconnect consoles, and apply its limits (no GPU acceleration, host-desktop input refused, console windows unsupported). Use when the user mentions the Shellbox desktop or tab, its changes, or sending input.'
const CANDIDATE: SkillCandidate = {
  name: 'shellbox',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** The provider the bundle plugin registers on `ctx.skills`. */
export const shellboxSkillProvider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
