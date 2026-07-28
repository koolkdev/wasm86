import { FieldRef, NamedArrayRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";
import { reg32, segmentRegisters } from "#core/types.js";

export const coreStateFields = {
  gprs: new NamedArrayRef("core.state.gprs", "u32", reg32),
  eip: new FieldRef("core.state.eip", "u32"),
  segmentSelectors: new NamedArrayRef("core.state.segments.selector", "u16", segmentRegisters),
  segmentBases: new NamedArrayRef("core.state.segments.base", "u32", segmentRegisters),
  segmentLimits: new NamedArrayRef("core.state.segments.limit", "u32", segmentRegisters),
  segmentAccess: new NamedArrayRef("core.state.segments.access", "u32", segmentRegisters)
} as const;

export const coreStateLayout = layoutStructure("core.state", [
  coreStateFields.gprs,
  coreStateFields.eip,
  coreStateFields.segmentSelectors,
  coreStateFields.segmentBases,
  coreStateFields.segmentLimits,
  coreStateFields.segmentAccess
]);
