import { memo, useEffect, useRef, useState } from 'react'
// Type-only: the compactionPolicy / contextPressure / contextBreakdown key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { CompactionSessionMode } from '@deepseek-ai/dsh-compaction'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { contextOccupancy } from './context-occupancy.ts'
import type { ContextControlKey } from './locales.ts'
import css from './ContextControl.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '{