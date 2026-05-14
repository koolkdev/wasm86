import {
  buildIrExpressionBlock,
  type IrExpressionOptions,
  type IrExpressionInputBlock,
  type IrExprOp,
  type IrExprBlock,
  type IrMemoryGuardExprOp,
  type IrSetExprOp,
  type IrStorageExpr,
  type IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type {
  ConditionCode,
  IrBinaryOperator,
  IrFlagSetOp,
  IrUnaryOperator,
} from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { assignIrExprVarSlots, type IrExprVarSlotAssignment } from "./var-slots.js";
import {
  cleanValueWidth,
  constValueWidth,
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  i32BinaryResultValueWidth,
  i32SelectResultValueWidth,
  maskedConstValue,
  untrackedValueWidth,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "./value-width.js";

export type WasmIrEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  expression?: IrExpressionOptions;
  emitGet(
    source: IrStorageExpr,
    accessWidth: OperandWidth,
    helpers: WasmIrEmitHelpers,
    options?: WasmIrEmitValueOptions
  ): ValueWidth;
  emitSet(
    target: IrStorageExpr,
    value: IrValueExpr,
    accessWidth: OperandWidth,
    helpers: WasmIrEmitHelpers,
    op: IrSetExprOp
  ): void;
  emitMemoryGuard(op: IrMemoryGuardExprOp, helpers: WasmIrEmitHelpers): void;
  emitAddress(source: IrStorageExpr, helpers: WasmIrEmitHelpers): void;
  emitSetFlags(descriptor: IrFlagSetOp, helpers: WasmIrEmitHelpers): void;
  emitFlagsCondition(cc: ConditionCode): void;
  emitNext(helpers: WasmIrEmitHelpers): void;
  emitNextEip(helpers: WasmIrEmitHelpers): void;
  emitJump(target: IrValueExpr, helpers: WasmIrEmitHelpers): void;
  emitConditionalJump(condition: IrValueExpr, taken: IrValueExpr, notTaken: IrValueExpr, helpers: WasmIrEmitHelpers): void;
  emitHostTrap(vector: IrValueExpr, helpers: WasmIrEmitHelpers): void;
}>;

export type WasmIrEmitHelpers = Readonly<{
  emitValue(value: IrValueExpr, options?: WasmIrEmitValueOptions): ValueWidth;
  emitMaskedValue(value: IrValueExpr, width: OperandWidth): ValueWidth;
}>;

export function emitIrToWasm(block: IrExpressionInputBlock, context: WasmIrEmitContext): void {
  emitIrExpressionBlockToWasm(buildIrExpressionBlock(block, context.expression), context);
}

export function emitIrExpressionBlockToWasm(block: IrExprBlock, context: WasmIrEmitContext): void {
  new IrExprWasmEmitter(block, context).emit();
}

export function applyRequestedValueWidth(
  body: WasmFunctionBodyEncoder,
  valueWidth: ValueWidth,
  options: WasmIrEmitValueOptions
): ValueWidth {
  if (options.requestedWidth === undefined) {
    return valueWidth;
  }

  return options.requestedWidth === 32
    ? emitCleanValueForFullUse(body, valueWidth)
    : emitMaskValueToWidth(body, options.requestedWidth, valueWidth);
}

function allocateWasmLocalsForIrExprSlots(
  context: WasmIrEmitContext,
  slotCount: number
): number[] {
  return Array.from(
    { length: slotCount },
    () => context.scratch.allocLocal(wasmValueType.i32)
  );
}

class IrExprWasmEmitter {
  readonly #block: IrExprBlock;
  readonly #context: WasmIrEmitContext;
  readonly #slots: IrExprVarSlotAssignment;
  readonly #slotLocals: readonly number[];
  readonly #localValueWidths = new Map<number, ValueWidth>();
  readonly #helpers: WasmIrEmitHelpers = {
    emitValue: (value, options) => this.#emitValue(value, options),
    emitMaskedValue: (value, width) => this.#emitMaskedValue(value, width)
  };

  constructor(block: IrExprBlock, context: WasmIrEmitContext) {
    this.#block = block;
    this.#context = context;
    this.#slots = assignIrExprVarSlots(this.#block);
    this.#slotLocals = allocateWasmLocalsForIrExprSlots(this.#context, this.#slots.slotCount);
  }

  emit(): void {
    try {
      for (let opIndex = 0; opIndex < this.#block.length; opIndex += 1) {
        const op = this.#block[opIndex];

        if (op === undefined) {
          throw new Error(`missing IR expression op: ${opIndex}`);
        }

        this.#emitOp(op);
      }
    } finally {
      this.#freeSlotLocals();
    }
  }

  #emitOp(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        this.#localValueWidths.set(op.dst.id, this.#emitValue(op.value));
        this.#context.body.localSet(this.#wasmLocalForVar(op.dst.id));
        return;
      case "set":
        this.#context.emitSet(op.target, op.value, op.accessWidth, this.#helpers, op);
        return;
      case "memory.guard":
        this.#context.emitMemoryGuard(op, this.#helpers);
        return;
      case "flags.set":
        this.#context.emitSetFlags(op, this.#helpers);
        return;
      case "next":
        this.#context.emitNext(this.#helpers);
        return;
      case "jump":
        this.#context.emitJump(op.target, this.#helpers);
        return;
      case "conditionalJump":
        this.#context.emitConditionalJump(op.condition, op.taken, op.notTaken, this.#helpers);
        return;
      case "hostTrap":
        this.#context.emitHostTrap(op.vector, this.#helpers);
        return;
    }
  }

  #emitValue(value: IrValueExpr, options: WasmIrEmitValueOptions = {}): ValueWidth {
    const valueWidth = this.#emitValueDirect(value, options);

    return applyRequestedValueWidth(this.#context.body, valueWidth, options);
  }

  #emitMaskedValue(value: IrValueExpr, width: OperandWidth): ValueWidth {
    if (value.kind === "const") {
      const masked = maskedConstValue(value.value, width);

      this.#context.body.i32Const(masked);
      return constValueWidth(masked);
    }

    return emitMaskValueToWidth(this.#context.body, width, this.#emitValue(value));
  }

  #emitValueDirect(value: IrValueExpr, options: WasmIrEmitValueOptions): ValueWidth {
    switch (value.kind) {
      case "var":
        this.#context.body.localGet(this.#wasmLocalForVar(value.id));
        return this.#localValueWidths.get(value.id) ?? untrackedValueWidth();
      case "const":
        this.#context.body.i32Const(i32(value.value));
        return constValueWidth(value.value);
      case "nextEip":
        this.#context.emitNextEip(this.#helpers);
        return untrackedValueWidth();
      case "source":
        return this.#context.emitGet(value.source, value.accessWidth, this.#helpers, {
          ...options,
          signed: options.signed === true || value.signed === true
        });
      case "address":
        this.#context.emitAddress(value.operand, this.#helpers);
        return untrackedValueWidth();
      case "flags.condition":
        this.#context.emitFlagsCondition(value.cc);
        return cleanValueWidth(8);
      case "value.binary":
        return this.#emitI32Binary(value.operator, value.a, value.b);
      case "value.unary":
        return this.#emitI32Unary(value.operator, value.value, options);
      case "value.select":
        return this.#emitI32Select(value.condition, value.whenTrue, value.whenFalse);
    }
  }

  #emitI32Binary(operator: IrBinaryOperator, a: IrValueExpr, b: IrValueExpr): ValueWidth {
    const operandOptions = i32BinaryOperandEmitOptions(operator);
    const left = this.#emitValue(a, operandOptions);
    const right = this.#emitValue(b, operandOptions);

    emitI32BinaryInstruction(this.#context.body, operator);
    return i32BinaryResultValueWidth(operator, left, right);
  }

  #emitI32Unary(operator: IrUnaryOperator, value: IrValueExpr, options: WasmIrEmitValueOptions): ValueWidth {
    switch (operator) {
      case "extend8_s":
        return this.#emitSignExtend(value, 8, options);
      case "extend16_s":
        return this.#emitSignExtend(value, 16, options);
    }
  }

  #emitSignExtend(value: IrValueExpr, width: 8 | 16, options: WasmIrEmitValueOptions): ValueWidth {
    if (value.kind === "source" && value.accessWidth === width) {
      return this.#context.emitGet(value.source, value.accessWidth, this.#helpers, { ...options, signed: true });
    }

    this.#emitValue(value, { widthInsensitive: true });
    return emitSignExtendValueToWidth(this.#context.body, width);
  }

  #emitI32Select(condition: IrValueExpr, whenTrue: IrValueExpr, whenFalse: IrValueExpr): ValueWidth {
    const trueWidth = this.#emitValue(whenTrue);
    const falseWidth = this.#emitValue(whenFalse);
    const conditionWidth = this.#emitValue(condition, { requestedWidth: 32 });

    this.#context.body.select();
    return i32SelectResultValueWidth(conditionWidth, trueWidth, falseWidth);
  }

  #freeSlotLocals(): void {
    for (let index = this.#slotLocals.length - 1; index >= 0; index -= 1) {
      this.#context.scratch.freeLocal(this.#slotLocals[index]!);
    }
  }

  #wasmLocalForVar(id: number): number {
    const slot = this.#slots.slotByVar.get(id);

    if (slot === undefined) {
      throw new Error(`missing IR expression slot for var: ${id}`);
    }

    const local = this.#slotLocals[slot];

    if (local === undefined) {
      throw new Error(`missing Wasm local for IR expression slot: ${slot}`);
    }

    return local;
  }
}

export function emitI32BinaryInstruction(body: WasmFunctionBodyEncoder, operator: IrBinaryOperator): void {
  switch (operator) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "or":
      body.i32Or();
      return;
    case "and":
      body.i32And();
      return;
    case "shl":
      body.i32Shl();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

export function i32BinaryOperandEmitOptions(operator: IrBinaryOperator): WasmIrEmitValueOptions {
  switch (operator) {
    case "add":
    case "sub":
    case "shl":
    case "shr_u":
      return { requestedWidth: 32 };
    case "xor":
    case "or":
    case "and":
      return { widthInsensitive: true };
  }
}
