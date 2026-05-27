import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrMemoryAccessKind
} from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { BlockExit } from "./exits.js";
import type { OpSite } from "./walk/site.js";

export type BlockContinuation = Readonly<{
  kind: "continuation";
  value?: ExprRef;
}>;

export type BlockAction =
  | Readonly<{
      kind: "memoryGuard";
      at: OpSite;
      address: ExprRef;
      byteLength: number;
      access: IrMemoryAccessKind;
      faultExit: BlockExit;
    }>
  | Readonly<{
      kind: "memoryStore";
      at: OpSite;
      address: ExprRef;
      value: ExprRef;
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "dynamicRegisterStore";
      at: OpSite;
      index: ExprRef;
      value: ExprRef;
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "jump";
      at: OpSite;
      target: ExprRef;
      exit: BlockExit;
    }>
  | Readonly<{
      kind: "branch";
      at: OpSite;
      condition: ExprRef;
      takenTarget: ExprRef;
      continuation: BlockContinuation;
      taken: BlockExit;
      notTaken: BlockExit;
    }>
  | Readonly<{
      kind: "hostTrap";
      at: OpSite;
      vector: ExprRef;
      exit: BlockExit;
    }>
  | Readonly<{
      kind: "fallthrough";
      at: OpSite;
      continuation: BlockContinuation;
      exit: BlockExit;
    }>;
