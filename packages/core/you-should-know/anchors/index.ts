export type {
  RegisteredTipAnchor,
  SchedulableTip,
  TipAnchorDescriptor,
  TipAnchorDisplayState,
  TipAnchorLevel,
  TipAnchorRect,
  TipAnchorScope,
  TipPlacement,
  TipQueueEntry,
  TipSchedule,
  TipScheduleAnchor,
  TipScheduleInput,
} from "./types";
export { isTipAnchorCandidate, tipAnchorDescriptorKey } from "./descriptor";
export {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
  type TipAnchorRegistryState,
} from "./registry";
export { scheduleTips, shouldShowSettingsHint, TIP_DWELL_MS } from "./schedule";
export {
  INITIAL_TIP_ROTATION,
  measureTipAnchors,
  rotateTips,
  type TipRotation,
  type TipRotationEvent,
} from "./rotation";
