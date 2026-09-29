/**
 * CodexNative: a faithful replica of Codex's computer-use mechanism.
 *
 * A prebuilt standalone helper (`native/cua`, native COM UIA + SendInput +
 * Windows.Graphics.Capture) speaks stdio NDJSON; this package spawns it and
 * exposes the client surface plus the `GuiBackend` adapter the gui-motor A/B
 * benchmark loads.
 */

export {
  APPROVED_APP_META_KEY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LAUNCH_APP_TIMEOUT_MS,
  NdjsonDecoder,
  REQUEST_BUDGET_META_KEY,
  decodeLine,
  encodeRequest,
  requestTimeoutFor,
  type CuaApprovalRequest,
  type CuaRequestMeta,
  type DecodedLine,
} from './protocol.ts'

export {
  resolveHelperPath,
  resolveHelperPathFrom,
  type HelperPathCandidates,
} from './helper-path.ts'

export {
  CuaApprovalRequiredError,
  CuaHelperClient,
  CuaHelperExitError,
  CuaHelperProtocolError,
  CuaHelperRequestError,
  CuaHelperTimeoutError,
  type CuaAccessibility,
  type CuaCaptureResult,
  type CuaElementRecord,
  type CuaHelperClientOptions,
  type CuaHelperInfo,
  type CuaInputOutcome,
  type CuaRequestOptions,
  type CuaScreenshot,
  type CuaWindowInfo,
  type CuaWindowRef,
  type CuaWindowStateResult,
} from './client.ts'

export {
  CUA_CAPTURE_BLACK,
  type CuaBounds,
  type CuaCapabilities,
  type CuaCaptureFrame,
  type CuaCaptureTarget,
  type CuaGuiBackend,
  type CuaInputOp,
  type CuaInputReceipt,
  type CuaMouseButton,
  type CuaUiaElement,
  type CuaUiaSelector,
  type CuaUiaTreeSnapshot,
} from './backend-contract.ts'

export {
  codexNativeBackendIdentity,
  codexNativeCapabilities,
  createCodexNativeBackend,
  type CreateCodexNativeBackendOptions,
  type CodexNativeBackend,
  type CuaRegionSample,
} from './adapter.ts'
