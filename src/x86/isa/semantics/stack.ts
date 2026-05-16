import type {
  OperandRef,
  SemanticTemplate,
  IrBuilder,
  IrRollbackWrite,
  SemanticBuildContext,
  StorageInput,
  ValueInput,
  VarRef
} from "#x86/ir/model/types.js";
import { guardStorageRead, guardStorageWrite } from "./memory.js";

export function push32(s: IrBuilder, context: SemanticBuildContext, value: ValueInput): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = s.i32Sub(esp, 4);
  const stack = s.mem(nextEsp);

  guardStorageWrite(s, context, stack, 32);
  s.set(stack, value);
  s.set(s.reg("esp"), nextEsp);
}

export function pop32(s: IrBuilder, context: SemanticBuildContext): VarRef {
  return pop32WithStackPointer(s, context).value;
}

function pop32WithStackPointer(
  s: IrBuilder,
  context: SemanticBuildContext
): Readonly<{ value: VarRef; stackPointer: VarRef }> {
  const esp = s.get(s.reg("esp"));
  const stack = s.mem(esp);

  guardStorageRead(s, context, stack, 32);
  const value = s.get(stack);
  const nextEsp = s.i32Add(esp, 4);

  s.set(s.reg("esp"), nextEsp);
  return { value, stackPointer: esp };
}

export function pushSemantic(): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, 32);
    push32(s, context, s.get(src));
  };
}

export function popSemantic(): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    const popped = pop32WithStackPointer(s, context);
    const target = popTargetStorage(s, context, dst, popped.stackPointer);

    s.set(target, popped.value);
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, context) => {
    const frame = s.get(s.reg("ebp"));
    const savedFrameStorage = s.mem(frame);

    guardStorageRead(s, context, savedFrameStorage, 32);
    const savedFrame = s.get(savedFrameStorage);
    const nextEsp = s.i32Add(frame, 4);

    s.set(s.reg("esp"), nextEsp);
    s.set(s.reg("ebp"), savedFrame);
  };
}

function popTargetStorage(
  s: IrBuilder,
  context: SemanticBuildContext,
  dst: OperandRef,
  oldEsp: VarRef
): StorageInput {
  const rollback: readonly IrRollbackWrite[] = [{ target: s.reg("esp"), value: oldEsp }];

  switch (context.operandInfo(dst).storage) {
    case "mem": {
      const address = s.address(dst);
      const target = s.mem(address);

      s.memoryGuard(address, 4, "write", { faultRollback: rollback });
      return target;
    }
    case "regOrMem": {
      const address = s.address(dst);

      s.memoryGuard(address, 4, "write", { faultRollback: rollback });
      return dst;
    }
    case "reg":
    case "imm":
    case "relTarget":
      guardStorageWrite(s, context, dst, 32);
      return dst;
  }
}
