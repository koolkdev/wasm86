import type {
  IrExprBlock,
  IrExprOp,
  IrSetExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type {
  WasmIrEmitHelpers
} from "#backends/wasm/codegen/emit.js";
import {
  applyRequestedValueWidth,
  emitI32BinaryInstruction,
  i32BinaryOperandEmitOptions
} from "#backends/wasm/codegen/emit.js";
import {
  constValueWidth,
  dirtyValueWidth,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  i32BinaryResultValueWidth,
  i32SelectResultValueWidth,
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { i32 } from "#x86/state/cpu-state.js";
import type {
  IrBinaryOperator,
  IrUnaryOperator
} from "#x86/ir/model/types.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt,
  type JitInstructionValueTimeline
} from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type {
  JitValueCacheRuntime
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import type {
  JitExpressionCaptureMap
} from "#backends/wasm/jit/codegen/plan/value-captures.js";
import type {
  JitArchitecturalSlot,
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import {
  emitJitValue,
  emitJitValueWithoutRootCache,
  emitMaskedJitValue,
  type JitValueEmitContext
} from "./jit-values.js";

export type JitExpressionBlockInstruction = Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: JitInstructionValueTimeline;
  plannedValueCaptures: JitExpressionCaptureMap;
}>;

export type JitExpressionBlockEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  instruction: JitExpressionBlockInstruction;
  valueCache?: JitValueCacheRuntime | undefined;
  beginExpressionOp?(opIndex: number): void;
  emitInput(slot: JitArchitecturalSlot): ValueWidth;
  emitInputBits?(
    slot: JitArchitecturalSlot,
    bitOffset: number,
    width: OperandWidth,
    signed: boolean
  ): ValueWidth | undefined;
  emitGet(
    source: IrStorageExpr,
    accessWidth: OperandWidth,
    helpers: WasmIrEmitHelpers,
    options?: WasmIrEmitValueOptions
  ): ValueWidth;
  emitSet(op: IrSetExprOp, helpers: WasmIrEmitHelpers): void;
  emitMemoryGuard(op: Extract<IrExprOp, { op: "memory.guard" }>, helpers: WasmIrEmitHelpers): void;
  emitAddress(source: IrStorageExpr, helpers: WasmIrEmitHelpers): void;
  emitNextEip(): ValueWidth;
  emitNext(): void;
  emitJump(target: IrValueExpr, helpers: WasmIrEmitHelpers): void;
  emitConditionalJump(condition: IrValueExpr, taken: IrValueExpr, notTaken: IrValueExpr, helpers: WasmIrEmitHelpers): void;
  emitHostTrap(vector: IrValueExpr, helpers: WasmIrEmitHelpers): void;
}>;

export function emitJitExpressionBlock(context: JitExpressionBlockEmitContext): void {
  new JitExpressionBlockEmitter(context).emit();
}

class JitExpressionBlockEmitter {
  readonly #context: JitExpressionBlockEmitContext;
  #currentOpIndex = -1;
  readonly #helpers: WasmIrEmitHelpers = {
    emitValue: (value, options) => this.#emitValue(value, options),
    emitMaskedValue: (value, width) => this.#emitMaskedValue(value, width)
  };

  constructor(context: JitExpressionBlockEmitContext) {
    this.#context = context;
  }

  emit(): void {
    const { expressionBlock } = this.#context.instruction;

    for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
      const op = expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT expression-block op: ${opIndex}`);
      }

      this.#currentOpIndex = opIndex;
      this.#beginExpressionOp(opIndex);
      this.#capturePlannedValues(opIndex);
      this.#emitOp(op);
    }
  }

  #beginExpressionOp(opIndex: number): void {
    if (this.#context.beginExpressionOp !== undefined) {
      this.#context.beginExpressionOp(opIndex);
      return;
    }

    this.#context.valueCache?.beginExpressionOp(opIndex);
  }

  #emitOp(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        this.#emitLet32(op);
        return;
      case "hostTrap":
        this.#context.emitHostTrap(op.vector, this.#helpers);
        return;
      case "next":
        this.#context.emitNext();
        return;
      case "set":
        this.#context.emitSet(op, this.#helpers);
        return;
      case "memory.guard":
        this.#context.emitMemoryGuard(op, this.#helpers);
        return;
      case "flags.set":
        return;
      case "jump":
        this.#context.emitJump(op.target, this.#helpers);
        return;
      case "conditionalJump":
        this.#context.emitConditionalJump(op.condition, op.taken, op.notTaken, this.#helpers);
        return;
    }
  }

  #emitValue(value: IrValueExpr, options: WasmIrEmitValueOptions = {}): ValueWidth {
    if (value.kind === "nextEip") {
      return applyRequestedValueWidth(
        this.#context.body,
        this.#context.emitNextEip(),
        options
      );
    }

    return emitJitValue(
      this.#jitValueContext(),
      this.#requiredJitValueForExpression(value),
      options
    );
  }

  #emitMaskedValue(value: IrValueExpr, width: OperandWidth): ValueWidth {
    if (value.kind === "nextEip") {
      return emitMaskValueToWidth(
        this.#context.body,
        width,
        this.#context.emitNextEip()
      );
    }

    return emitMaskedJitValue(
      this.#jitValueContext(),
      this.#requiredJitValueForExpression(value),
      width
    );
  }

  #jitValueContext(): JitValueEmitContext {
    return {
      body: this.#context.body,
      valueCache: this.#context.valueCache,
      emitInput: this.#context.emitInput,
      emitInputBits: this.#context.emitInputBits
    };
  }

  #capturePlannedValues(opIndex: number): void {
    const captures = this.#context.instruction.plannedValueCaptures.get(opIndex) ?? [];

    for (const capture of captures) {
      if (capture.value.kind === "produced") {
        throw new Error("produced JIT values are captured at their definition");
      }

      const captured = this.#context.valueCache?.captureForReuse(
        capture.value,
        () => emitJitValueWithoutRootCache(this.#jitValueContext(), capture.value)
      );

      captured?.release();
    }
  }

  #emitLet32(op: Extract<IrExprOp, { op: "let32" }>): void {
    const produced = this.#producedDefinitionForValueRef(op.dst);

    if (produced !== undefined) {
      this.#emitProducedDefinition(produced, op.value);
      return;
    }

    if (this.#valueForValueRef(op.dst) === undefined) {
      throw new Error(
        `JIT expression-block let32 has no timeline value at expression op ${this.#currentOpIndex}`
      );
    }
  }

  #emitProducedDefinition(produced: JitProducedValue, value: IrValueExpr): void {
    const captured = this.#context.valueCache?.captureForReuse(
      produced,
      () => this.#emitDefinitionValue(value)
    );

    if (captured !== undefined) {
      captured.release();
      return;
    }
  }

  #emitDefinitionValue(value: IrValueExpr, options: WasmIrEmitValueOptions = {}): ValueWidth {
    return applyRequestedValueWidth(
      this.#context.body,
      this.#emitDefinitionValueDirect(value, options),
      options
    );
  }

  #emitDefinitionValueDirect(value: IrValueExpr, options: WasmIrEmitValueOptions): ValueWidth {
    switch (value.kind) {
      case "var":
      case "flags.condition":
        return this.#emitValue(value, options);
      case "const":
        this.#context.body.i32Const(i32(value.value));
        return constValueWidth(value.value);
      case "nextEip":
        return this.#context.emitNextEip();
      case "source":
        return this.#context.emitGet(value.source, value.accessWidth, this.#helpers, {
          ...options,
          signed: options.signed === true || value.signed === true
        });
      case "address":
        this.#context.emitAddress(value.operand, this.#helpers);
        return dirtyValueWidth(32);
      case "value.binary":
        return this.#emitDefinitionI32Binary(value.operator, value.a, value.b);
      case "value.unary":
        return this.#emitDefinitionI32Unary(value.operator, value.value, options);
      case "value.select":
        return this.#emitDefinitionI32Select(value.condition, value.whenTrue, value.whenFalse);
    }
  }

  #emitDefinitionI32Binary(operator: IrBinaryOperator, a: IrValueExpr, b: IrValueExpr): ValueWidth {
    const operandOptions = i32BinaryOperandEmitOptions(operator);
    const left = this.#emitDefinitionValue(a, operandOptions);
    const right = this.#emitDefinitionValue(b, operandOptions);

    emitI32BinaryInstruction(this.#context.body, operator);
    return i32BinaryResultValueWidth(operator, left, right);
  }

  #emitDefinitionI32Unary(
    operator: IrUnaryOperator,
    value: IrValueExpr,
    options: WasmIrEmitValueOptions
  ): ValueWidth {
    switch (operator) {
      case "extend8_s":
        return this.#emitDefinitionSignExtend(value, 8, options);
      case "extend16_s":
        return this.#emitDefinitionSignExtend(value, 16, options);
    }
  }

  #emitDefinitionSignExtend(
    value: IrValueExpr,
    width: 8 | 16,
    options: WasmIrEmitValueOptions
  ): ValueWidth {
    if (value.kind === "source" && value.accessWidth === width) {
      return this.#context.emitGet(value.source, value.accessWidth, this.#helpers, { ...options, signed: true });
    }

    this.#emitDefinitionValue(value, { widthInsensitive: true });
    return emitSignExtendValueToWidth(this.#context.body, width);
  }

  #emitDefinitionI32Select(condition: IrValueExpr, whenTrue: IrValueExpr, whenFalse: IrValueExpr): ValueWidth {
    const trueWidth = this.#emitDefinitionValue(whenTrue);
    const falseWidth = this.#emitDefinitionValue(whenFalse);
    const conditionWidth = this.#emitDefinitionValue(condition, { requestedWidth: 32 });

    this.#context.body.select();
    return i32SelectResultValueWidth(conditionWidth, trueWidth, falseWidth);
  }

  #producedDefinitionForValueRef(valueRef: ValueRef): JitProducedValue | undefined {
    if (valueRef.kind !== "var") {
      return undefined;
    }

    return this.#context.instruction.valueTimeline.producedDefinitions.find((definition) =>
      definition.expressionOpIndex === this.#currentOpIndex &&
      definition.valueRef.kind === "var" &&
      definition.valueRef.id === valueRef.id
    )?.value;
  }

  #requiredJitValueForExpression(value: IrValueExpr): JitValue {
    const resolved = this.#valueForExpression(value);

    if (resolved === undefined) {
      throw new Error(
        `JIT expression-block value is not available at expression op ${this.#currentOpIndex}`
      );
    }

    return resolved;
  }

  #valueForExpression(value: IrValueExpr): JitValue | undefined {
    if (value.kind === "nextEip") {
      return undefined;
    }

    const cachedExpressionValue = this.#context.valueCache?.valueForExpression(value);

    if (cachedExpressionValue !== undefined) {
      return cachedExpressionValue;
    }

    const valueRef = valueRefExpression(value);
    if (valueRef !== undefined) {
      return this.#valueForValueRef(valueRef);
    }

    return jitTimelineExpressionValueAt(
      this.#context.instruction.valueTimeline,
      this.#currentOpIndex,
      value
    );
  }

  #valueForValueRef(valueRef: ValueRef): JitValue | undefined {
    if (valueRef.kind === "nextEip") {
      return undefined;
    }

    const cachedValueRefValue = this.#context.valueCache?.valueForValueRef(valueRef);

    if (cachedValueRefValue !== undefined) {
      return cachedValueRefValue;
    }

    return jitTimelineValueRefValueAt(
      this.#context.instruction.valueTimeline,
      this.#currentOpIndex,
      valueRef
    );
  }
}

function valueRefExpression(value: IrValueExpr): ValueRef | undefined {
  switch (value.kind) {
    case "var":
    case "const":
      return value;
    case "nextEip":
      return undefined;
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return undefined;
  }
}
