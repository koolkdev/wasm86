import type {
  IrExprBlock,
  IrExprOp,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type {
  WasmIrEmitHelpers
} from "#backends/wasm/codegen/emit.js";
import {
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt,
  type JitInstructionValueTimeline
} from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type {
  JitValueCacheRuntime
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import {
  jitValueDependencies,
  type JitArchitecturalSlot,
  type JitProducedValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import {
  emitJitValue,
  emitMaskedJitValue,
  type JitValueEmitContext
} from "./jit-values.js";

export type JitExpressionBlockInstruction = Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: JitInstructionValueTimeline;
}>;

export type JitExpressionBlockEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  instruction: JitExpressionBlockInstruction;
  valueCache?: JitValueCacheRuntime | undefined;
  emitInput(slot: JitArchitecturalSlot): ValueWidth;
  emitNext(helpers: WasmIrEmitHelpers): void;
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
      this.#context.valueCache?.beginExpressionOp(opIndex);
      this.#emitOp(op);
    }
  }

  #emitOp(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        this.#assertLet32ValueIsSupported(op.dst);
        return;
      case "hostTrap":
        this.#context.emitHostTrap(op.vector, this.#helpers);
        return;
      case "next":
        this.#context.emitNext(this.#helpers);
        return;
      case "set":
      case "flags.set":
      case "jump":
      case "conditionalJump":
        throw new Error(`unsupported JIT expression-block op in 3H emitter: ${op.op}`);
    }
  }

  #emitValue(value: IrValueExpr, options: WasmIrEmitValueOptions = {}): ValueWidth {
    return emitJitValue(
      this.#jitValueContext(),
      this.#requiredJitValueForExpression(value),
      options
    );
  }

  #emitMaskedValue(value: IrValueExpr, width: OperandWidth): ValueWidth {
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
      emitInput: this.#context.emitInput
    };
  }

  #assertLet32ValueIsSupported(valueRef: ValueRef): void {
    const value = this.#jitValueForValueRef(valueRef);

    if (value === undefined) {
      throw new Error(
        `JIT expression-block let32 has no timeline value at expression op ${this.#currentOpIndex}`
      );
    }

    this.#assertSupportedValue(value);
  }

  #assertSupportedValue(value: JitValue): void {
    const producedValue = firstProducedValue(value);

    if (producedValue !== undefined) {
      throw new Error(
        `unsupported JIT expression-block let32 produced value at expression op ${this.#currentOpIndex}: ${producedValue.id}`
      );
    }
  }

  #requiredJitValueForExpression(value: IrValueExpr): JitValue {
    const resolved = this.#jitValueForExpression(value);

    if (resolved === undefined) {
      throw new Error(
        `JIT expression-block value is not available at expression op ${this.#currentOpIndex}`
      );
    }

    return resolved;
  }

  #jitValueForExpression(value: IrValueExpr): JitValue | undefined {
    const cachedExpressionValue = this.#context.valueCache?.jitValueForExpression(value);

    if (cachedExpressionValue !== undefined) {
      return cachedExpressionValue;
    }

    const valueRef = valueRefExpression(value);
    if (valueRef !== undefined) {
      return this.#jitValueForValueRef(valueRef);
    }

    return jitTimelineExpressionValueAt(
      this.#context.instruction.valueTimeline,
      this.#currentOpIndex,
      value
    );
  }

  #jitValueForValueRef(valueRef: ValueRef): JitValue | undefined {
    const cachedValueRefValue = this.#context.valueCache?.jitValueForValueRef(valueRef);

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
    case "nextEip":
      return value;
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return undefined;
  }
}

function firstProducedValue(value: JitValue): JitProducedValue | undefined {
  if (value.kind === "produced") {
    return value;
  }

  for (const dependency of jitValueDependencies(value)) {
    const produced = firstProducedValue(dependency);

    if (produced !== undefined) {
      return produced;
    }
  }

  return undefined;
}
