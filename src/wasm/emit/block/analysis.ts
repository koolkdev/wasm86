import {
  analyzeBarrierFacts,
  analyzeExpressionNeeds,
  analyzePlacementPlan,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildBlockLayout,
  buildTimelineGeometry,
  buildTimelineValueUseIndex
} from "#ir/block/planning/index.js";
import type { RegisterAccessMode } from "#ir/block/state/register-materialization.js";
import {
  walkExpressionBlock,
  type BlockWalkInput
} from "#ir/block/walk/index.js";
import type { IrBlock } from "#ir/model/types.js";

export const wasmLocalRegisterAccessMode: RegisterAccessMode = "full-base";
export const wasmMemoryRegisterAccessMode: RegisterAccessMode = "exact-alias";

export type WasmBlockAnalysisInput =
  Omit<BlockWalkInput, "block" | "dynamicRegisterAccessMode"> &
  Readonly<{
    block: IrBlock;
    registerAccessMode: RegisterAccessMode;
  }>;

export type WasmBlockAnalysis = Readonly<{
  walked: ReturnType<typeof walkExpressionBlock>;
  geometry: ReturnType<typeof buildTimelineGeometry>;
  timelineUses: ReturnType<typeof buildTimelineValueUseIndex>;
  obligations: ReturnType<typeof analyzeStateObligations>;
  needs: ReturnType<typeof analyzeExpressionNeeds>;
  facts: ReturnType<typeof analyzeBarrierFacts>;
  values: ReturnType<typeof analyzeValuePlan>;
  stateWrites: ReturnType<typeof analyzeStateWrites>;
  placement: ReturnType<typeof analyzePlacementPlan>;
  layout: ReturnType<typeof buildBlockLayout>;
}>;

export function analyzeWasmBlock(input: WasmBlockAnalysisInput): WasmBlockAnalysis {
  const walked = walkExpressionBlock({
    ...input,
    dynamicRegisterAccessMode: input.registerAccessMode
  });
  const geometry = buildTimelineGeometry(walked);
  const timelineUses = buildTimelineValueUseIndex({ walked, geometry });
  const obligations = analyzeStateObligations({
    walked,
    geometry,
    registerMaterializationMode: input.registerAccessMode
  });
  const needs = analyzeExpressionNeeds({ timelineUses, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs: needs.needs, geometry, facts });
  const stateWrites = analyzeStateWrites({
    obligations,
    valueNeeds: needs.valueNeedByObligation,
    values
  });
  const placement = analyzePlacementPlan({ geometry, facts, values, stateWrites });
  const layout = buildBlockLayout({
    walked,
    geometry,
    timelineUses,
    timelineNeedByUse: needs.timelineNeedByUse,
    values,
    stateWrites,
    placement
  });

  return {
    walked,
    geometry,
    timelineUses,
    obligations,
    needs,
    facts,
    values,
    stateWrites,
    placement,
    layout
  };
}
