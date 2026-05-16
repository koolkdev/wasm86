import { assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { irOpDst, irOpIsTerminator } from "#x86/ir/model/op-semantics.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type {
  IrFlagSetOp,
  IrMemoryAccessKind,
  IrOp,
  IrBlock,
  StorageRef,
  ValueRef
} from "#x86/ir/model/types.js";

export type ValidateIrBlockOptions = Readonly<{
  operandCount?: number;
  terminatorMode?: "none" | "single" | "multi";
}>;

export function validateIrBlock(block: IrBlock, options: ValidateIrBlockOptions = {}): void {
  const definedVars = new Set<number>();
  const terminatorMode = options.terminatorMode ?? "single";
  let terminatorCount = 0;
  let sawTerminator = false;

  for (const op of block) {
    if (sawTerminator && terminatorMode === "single") {
      throw new Error(`IR op ${op.op} appears after terminator`);
    }

    validateOpUses(op, definedVars, options);
    defineOpVar(op, definedVars);

    if (irOpIsTerminator(op)) {
      if (terminatorMode === "none") {
        throw new Error(`IR block must not contain a terminator, got ${op.op}`);
      }

      terminatorCount += 1;
      sawTerminator = true;
    }
  }

  switch (terminatorMode) {
    case "none":
      return;
    case "single":
      if (terminatorCount !== 1) {
        throw new Error(`IR block must contain exactly one terminator, got ${terminatorCount}`);
      }
      return;
    case "multi":
      if (terminatorCount === 0) {
        throw new Error("IR block must contain at least one terminator");
      }
      return;
  }
}

function validateOpUses(
  op: IrOp,
  definedVars: ReadonlySet<number>,
  options: ValidateIrBlockOptions
): void {
  switch (op.op) {
    case "get":
      validateAccessWidth(op.accessWidth);
      validateSignedGet(op);
      validateStorageRef(op.source, definedVars, options);
      break;
    case "set":
      validateAccessWidth(op.accessWidth);
      validateStorageRef(op.target, definedVars, options);
      validateValueRef(op.value, definedVars);
      break;
    case "memory.guard":
      validateValueRef(op.address, definedVars);
      validateMemoryGuardByteLength(op.byteLength);
      validateMemoryGuardAccess(op.access);
      for (const write of op.faultRollback ?? []) {
        validateValueRef(write.value, definedVars);
      }
      break;
    case "address":
      validateOperandIndex(op.operand.index, options);
      break;
    case "value.const":
      break;
    case "value.binary":
      validateValueRef(op.a, definedVars);
      validateValueRef(op.b, definedVars);
      break;
    case "value.unary":
      validateValueRef(op.value, definedVars);
      break;
    case "value.select":
      validateValueRef(op.condition, definedVars);
      validateValueRef(op.whenTrue, definedVars);
      validateValueRef(op.whenFalse, definedVars);
      break;
    case "flags.set":
      validateFlagSetDescriptor(op, definedVars);
      break;
    case "flags.condition":
      break;
    case "jump":
      validateValueRef(op.target, definedVars);
      break;
    case "conditionalJump":
      validateValueRef(op.condition, definedVars);
      validateValueRef(op.taken, definedVars);
      validateValueRef(op.notTaken, definedVars);
      break;
    case "hostTrap":
      validateValueRef(op.vector, definedVars);
      break;
  }
}

function defineOpVar(op: IrOp, definedVars: Set<number>): void {
  const dst = irOpDst(op);

  if (dst === undefined) {
    return;
  }

  if (definedVars.has(dst.id)) {
    throw new Error(`IR var ${dst.id} is assigned more than once`);
  }

  definedVars.add(dst.id);
}

function validateStorageRef(
  storage: StorageRef,
  definedVars: ReadonlySet<number>,
  options: ValidateIrBlockOptions
): void {
  if (storage.kind === "operand") {
    validateOperandIndex(storage.index, options);
    return;
  }

  if (storage.kind === "mem") {
    validateValueRef(storage.address, definedVars);
  }
}

function validateValueRef(value: ValueRef, definedVars: ReadonlySet<number>): void {
  if (value.kind === "var" && !definedVars.has(value.id)) {
    throw new Error(`IR var ${value.id} is used before definition`);
  }
}

function validateFlagSetDescriptor(
  op: Pick<IrFlagSetOp, "producer" | "width" | "writtenMask" | "undefMask" | "inputs">,
  definedVars: ReadonlySet<number>
): void {
  const producer = FLAG_PRODUCERS[op.producer];

  validateAccessWidth(op.width);
  validateFlagDescriptorMasks(op, "flags.set");
  validateFlagInputs(op, definedVars, {
    label: "flags.set",
    requiredInputs: producer.inputs,
    allowedInputs: producer.inputs
  });
}

function validateAccessWidth(width: OperandWidth | undefined): void {
  if (width !== undefined && width !== 8 && width !== 16 && width !== 32) {
    throw new Error(`IR access width must be 8, 16, or 32, got ${width}`);
  }
}

function validateSignedGet(op: Extract<IrOp, { op: "get" }>): void {
  if (op.signed !== true) {
    return;
  }

  if (op.accessWidth !== 8 && op.accessWidth !== 16) {
    throw new Error("IR signed get requires access width 8 or 16");
  }
}

function validateMemoryGuardByteLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`IR memory.guard byte length must be a positive integer, got ${byteLength}`);
  }
}

function validateMemoryGuardAccess(access: IrMemoryAccessKind): void {
  if (access !== "read" && access !== "write") {
    throw new Error(`IR memory.guard access must be "read" or "write", got ${String(access)}`);
  }
}

function validateFlagDescriptorMasks(
  op: Pick<IrFlagSetOp, "producer" | "writtenMask" | "undefMask">,
  label: "flags.set"
): void {
  const producer = FLAG_PRODUCERS[op.producer];

  assertIrAluFlagMask(op.writtenMask, `${label} writtenMask`);
  assertIrAluFlagMask(op.undefMask, `${label} undefMask`);

  if (op.writtenMask !== producer.writtenMask) {
    throw new Error(`${label} ${op.producer} writtenMask does not match producer metadata`);
  }

  if (op.undefMask !== producer.undefMask) {
    throw new Error(`${label} ${op.producer} undefMask does not match producer metadata`);
  }

  if ((op.undefMask & ~op.writtenMask) !== 0) {
    throw new Error(`${label} ${op.producer} undefMask must be contained in writtenMask`);
  }
}

function validateFlagInputs(
  op: Pick<IrFlagSetOp, "producer" | "inputs">,
  definedVars: ReadonlySet<number>,
  options: Readonly<{
    label: "flags.set";
    requiredInputs: readonly string[];
    allowedInputs: readonly string[];
  }>
): void {
  const allowedInputs: ReadonlySet<string> = new Set(options.allowedInputs);

  for (const inputName of options.requiredInputs) {
    const value = op.inputs[inputName];

    if (value === undefined) {
      throw new Error(`${options.label} ${op.producer} is missing input '${inputName}'`);
    }

    validateValueRef(value, definedVars);
  }

  for (const inputName of Object.keys(op.inputs)) {
    if (!allowedInputs.has(inputName)) {
      throw new Error(`${options.label} ${op.producer} has unexpected input '${inputName}'`);
    }

    const value = op.inputs[inputName];

    if (value !== undefined) {
      validateValueRef(value, definedVars);
    }
  }
}

function validateOperandIndex(index: number, options: ValidateIrBlockOptions): void {
  if (options.operandCount === undefined) {
    return;
  }

  if (index >= options.operandCount) {
    throw new Error(`IR operand ${index} does not exist in ${options.operandCount}-operand instruction`);
  }
}
