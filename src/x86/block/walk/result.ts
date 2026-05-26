import type { BlockAction } from "#x86/block/actions.js";
import type { BlockDefinition } from "#x86/block/definitions.js";
import type { BlockExit } from "#x86/block/exits.js";
import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth, RegisterAlias } from "#x86/isa/types.js";
import type { BlockState } from "./state.js";
import type { OpSite } from "./site.js";

export type BlockWalkEvent =
  | Readonly<{ kind: "action"; action: BlockAction }>
  | Readonly<{ kind: "definition"; definition: BlockDefinition }>;

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
  events: readonly BlockWalkEvent[];
  registerAccesses: readonly BlockRegisterAccess[];
  exits: readonly BlockExit[];
}>;
