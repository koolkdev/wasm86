import type { FieldRef } from "#compiler/layout/handles.js";
import type {
  GprChannel,
  SegmentChannel
} from "#core/state/channels.js";

export type StateFieldChannel = FieldRef | SegmentChannel;

export type InstructionStateChannel = GprChannel | StateFieldChannel;
