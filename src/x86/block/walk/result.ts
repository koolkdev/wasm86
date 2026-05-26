import type { BlockExit } from "#x86/block/exits.js";
import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth, RegisterAlias } from "#x86/isa/types.js";
import type { BlockSchedule } from "../schedule.js";
import type { BlockState } from "./state.js";
import type { OpSite } from "./site.js";

export type {
  ActionScheduleEntry,
  BlockSchedule,
  BlockScheduleEntry,
  BoundaryScheduleEntry,
  DefinitionScheduleEntry,
  Placement
} from "../schedule.js";

export type BlockRegisterAccess =
  | Readonly<{
      kind: "registerRead";
      at: OpSite;
      reg: RegisterAlias;
      reason: "storageRead" | "partialRegisterWrite";
    }>
  | Readonly<{
      kind: "registerWrite";
      at: OpSite;
      reg: RegisterAlias;
    }>
  | Readonly<{
      kind: "dynamicRegisterLoad";
      at: OpSite;
      index: ExprRef;
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "dynamicRegisterStore";
      at: OpSite;
      index: ExprRef;
      value: ExprRef;
      width: OperandWidth;
    }>;

export type BlockWalkResult = Readonly<{
  final: BlockState;
  schedule: BlockSchedule;
  registerAccesses: readonly BlockRegisterAccess[];
  exits: readonly BlockExit[];
}>;
