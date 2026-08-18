import type { AnyFieldRef } from "#compiler/layout/handles.js";
import type { GprChannel, SegmentChannel } from "#core/state/channels.js";

export type StateFieldChannel = AnyFieldRef | SegmentChannel;

export type InstructionStateChannel = GprChannel | StateFieldChannel;
