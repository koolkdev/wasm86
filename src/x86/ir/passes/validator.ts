import { CONDITIONS } from "#x86/ir/model/conditions.js";
import { assertIrAluFlagMask, IR_ALU_FLAGS } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS, type FlagName } from "#x86/ir/model/flags.js";
import { irOpDst, irOpIsTerminator } from "#x86/ir/model/op-semantics.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type {
  ConditionCode,
  IrCompareOperator,
  IrFlagSetOp,
  IrFlagWriteCell,
  IrFlagWriteOp,
  IrMemoryAccessKind,
  IrOp,
  IrUnaryOperator,
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
      validateUnaryOperator(op.operator);
      validateValueRef(op.value, definedVars);
      break;
    case "value.select":
      validateValueRef(op.condition, definedVars);
      validateValueRef(op.whenTrue, definedVars);
      validateValueRef(op.whenFalse, definedVars);
      break;
    case "value.project":
      validateAccessWidth(op.width);
      validateValueRef(op.value, definedVars);
      break;
    case "value.compare":
      validateAccessWidth(op.width);
      validateCompareOperator(op.operator);
      validateValueRef(op.a, definedVars);
      validateValueRef(op.b, definedVars);
      break;
    case "flags.set":
      validateFlagSetDescriptor(op, definedVars);
      break;
    case "flags.write":
      validateFlagWrite(op, definedVars);
      break;
    case "flags.condition":
      validateConditionCode(op.cc, "flags.condition");
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
    case "next":
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
  if (value === undefined) {
    throw new Error("IR value ref must not be undefined");
  }

  switch (value.kind) {
    case "var":
      if (!definedVars.has(value.id)) {
        throw new Error(`IR var ${value.id} is used before definition`);
      }
      return;
    case "const":
    case "nextEip":
      return;
  }

  throw new Error(`IR value ref has unknown kind '${String((value as { kind?: unknown }).kind)}'`);
}

function validateFlagWrite(
  op: Pick<IrFlagWriteOp, "cells" | "conditions">,
  definedVars: ReadonlySet<number>
): void {
  validateFlagWriteCells(op.cells, definedVars);

  if (op.conditions === undefined) {
    return;
  }

  for (const cc of Object.keys(op.conditions)) {
    validateConditionCode(cc, "flags.write");

    const value = op.conditions[cc];

    if (value === undefined) {
      throw new Error(`flags.write condition ${cc} must not be undefined`);
    }

    validateValueRef(value, definedVars);
  }
}

function validateFlagWriteCells(
  cells: IrFlagWriteOp["cells"],
  definedVars: ReadonlySet<number>
): void {
  for (const flag of Object.keys(cells)) {
    validateFlagName(flag, "flags.write");

    const cell = cells[flag];

    if (cell === undefined) {
      throw new Error(`flags.write ${flag} cell must not be undefined`);
    }

    validateFlagWriteCell(flag, cell, definedVars);
  }
}

function validateFlagWriteCell(
  flag: FlagName,
  cell: IrFlagWriteCell,
  definedVars: ReadonlySet<number>
): void {
  switch (cell.kind) {
    case "expr":
      if (cell.value === undefined) {
        throw new Error(`flags.write ${flag} expr cell value must not be undefined`);
      }

      validateValueRef(cell.value, definedVars);
      return;
    case "undef":
      return;
  }

  throw new Error(`flags.write ${flag} cell has unknown kind '${String((cell as { kind?: unknown }).kind)}'`);
}

function validateFlagName(flag: string, label: "flags.write"): asserts flag is FlagName {
  if (!(IR_ALU_FLAGS as readonly string[]).includes(flag)) {
    throw new Error(`${label} has unknown flag '${flag}'`);
  }
}

function validateConditionCode(cc: string, label: "flags.write" | "flags.condition"): asserts cc is ConditionCode {
  if (!Object.hasOwn(CONDITIONS, cc)) {
    throw new Error(`${label} has unknown condition code '${cc}'`);
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

function validateCompareOperator(operator: IrCompareOperator): void {
  switch (operator) {
    case "eq":
    case "ne":
    case "lt_u":
    case "le_u":
    case "gt_u":
    case "ge_u":
    case "lt_s":
    case "le_s":
    case "gt_s":
    case "ge_s":
      return;
  }

  throw new Error(`IR value.compare has unknown operator '${String(operator)}'`);
}

function validateUnaryOperator(operator: IrUnaryOperator): void {
  switch (operator) {
    case "extend8_s":
    case "extend16_s":
    case "popcnt":
      return;
  }

  throw new Error(`IR value.unary has unknown operator '${String(operator)}'`);
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
