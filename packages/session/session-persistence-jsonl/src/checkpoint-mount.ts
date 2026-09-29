/**
 * @deepseek-ai/dsh-session-persistence-jsonl — plan16-checkpoint: the DIR-bound
 * recorder factory. `checkpointRecorderAt` binds one journal directory to the
 * bridge of {@link attachCheckpointRecorder} and returns the attach closure —
 * a FUNCTION a caller can carry across package lines without importing this
 * package's types. That is what lets a lifecycle owner (the tool-runtime side)
 * mount the recorder without depending on the persistence package, and without
 * this package depending on the tool layer: the contract stays the two duck-
 * typed taps plus a capture plan.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/checkpoint-recorder
 */
import { CheckpointJournal, fileCheckpointIo } from './checkpoint.ts'
import {
  attachCheckpointRecorder,
  type CheckpointCapturePlan,
  type CheckpointRecorderOptions,
  type CheckpointToolTaps,
} from './checkpoint-recorder.ts'

/**
 * Bind one checkpoint directory to the recorder bridge.
 * @param dir - the journal directory (`<session>/checkpoints`); created on demand.
 * @param plan - the capture policy (which paths a call touches, and their content).
 * @param options - step kind and the isolated error sink.
 * @returns the attach closure: give it the lifecycle taps, get a disposer back.
 */
export function checkpointRecorderAt(
  dir: string,
  plan: CheckpointCapturePlan,
  options: CheckpointRecorderOptions = {},
): (taps: CheckpointToolTaps) => () => void {
  return (taps) => {
    const journal = new CheckpointJournal(fileCheckpointIo(dir))
    return attachCheckpointRecorder(taps, journal, plan, options)
  }
}