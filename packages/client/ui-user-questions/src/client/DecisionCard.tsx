import { useMemo, useState } from 'react'
import { Button, IconEditOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion, PlanDecision, QuestionComposerProps } from './contract/slots.ts'
import css from './DecisionCard.module.css'

/** The card's own props: the question domain face, the narrowed decision, and the locale seat. */
export type DecisionCardProps =
  { pending: PendingQuestion; decision: PlanDecision } & Pick<QuestionComposerProps, 't'>

/**
 * Optional-prop spread for a decision button's tooltip: `title` is optional on
 * the DOM props, and exactOptionalPropertyTypes rejects an explicit undefined.
 *
 * @param description - the asker's option description, when it carries one.
 * @returns The `title` prop to spread, or nothing.
 */
function tooltip(description: string | undefined): { title?: string } {
  return description === undefined ? {} : { title: description }
}

/**
 * Render one intent-tagged question as a decision card.
 *
 * The strip and both verbs come from this package's dictionaries rather than
 * from the asker's option labels: those are written in the language the asker
 * writes prompts in, while the card is read in the reader's. The labels still
 * travel back verbatim, because they are the answer encoding. Only a review
 * keeps them as button tooltips; an offer's own copy already says what its two
 * verbs do, so it does not put the asker's words back on the card.
 *
 * @param props - the question domain face, the narrowed decision, and `t`.
 * @returns The decision card for this request.
 */
export function DecisionCard({ pending, decision, t }: DecisionCardProps) {
  const review = decision.kind === 'plan-review'
  const copy = review
    ? {
      header: t('plan.header'), approve: t('plan.approve'),
      decline: t('plan.decline'), discuss: t('plan.discuss'),
    }
    : {
      header: t('offer.header'), approve: t('offer.accept'),
      decline: t('offer.decline'), discuss: t('offer.discuss'),
    }
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  // The card waits for the host's resolved frame before leaving, so repeated
  // clicks must not resubmit. A failed send re-enables it and shows the error.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settle = (send: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const decide = (label: string): void => {
    settle(() => pending.answer({ answers: [{ id: decision.id, selected: [label] }] }))
  }
  const decline = decision.decline

  return (
    <div className={css.frame} data-plan-decision-key={pending.key} data-plan-decision-kind={decision.kind}>
      <section className={css.card} aria-label={decision.question}>
        <div className={css.strip}>
          <span className={css.dot} />
          {copy.header}
        </div>
        <div className={css.body}>
          <MarkdownText text={decision.body} labels={markdownLabels} />
        </div>
        <div className={css.footer}>
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.actions}>
            <Button
              variant="ghost" className={css.discuss} icon={<IconEditOutline16 size={14} />}
              disabled={busy} onClick={() => { settle(() => pending.cancel()) }}
            >
              {copy.discuss}
            </Button>
            {decline !== undefined && (
              <Button
                variant="outline" {...review ? tooltip(decline.description) : {}}
                disabled={busy} onClick={() => { decide(decline.label) }}
              >
                {copy.decline}
              </Button>
            )}
            <Button
              variant="primary" {...review ? tooltip(decision.approve.description) : {}}
              disabled={busy} onClick={() => { decide(decision.approve.label) }}
            >
              {copy.approve}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
