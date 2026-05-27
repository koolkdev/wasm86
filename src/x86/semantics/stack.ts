import type {
  OperandRef,
  SemanticTemplate,
  IrBuilder,
  SemanticBuildContext,
  StorageInput,
  ValueInput,
  VarRef
} from "#ir/model/types.js";
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
  const esp = s.get(s.reg("esp"));
  const stack = s.mem(esp);

  guardStorageRead(s, context, stack, 32);
  const value = s.get(stack);
  const nextEsp = s.i32Add(esp, 4);

  s.set(s.reg("esp"), nextEsp);
  return value;
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
    const target = popTargetStorage(s, context, dst);

    s.set(target, pop32(s, context));
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

function popTargetStorage(s: IrBuilder, context: SemanticBuildContext, dst: OperandRef): StorageInput {
  if (context.operandInfo(dst).storage === "mem") {
    const target = s.mem(s.address(dst));

    guardStorageWrite(s, context, target, 32);
    return target;
  }

  guardStorageWrite(s, context, dst, 32);
  return dst;
}
