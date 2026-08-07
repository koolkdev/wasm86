import { assert } from "#common/assert.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { zeroExtendedRequiredBits } from "#compiler/wasm/function/values/integer/required-bits.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { toWasmValueType, wasmValueTypeFor } from "#compiler/wasm/type-lowering.js";
import type { FunctionValues, ValueIdentity } from "#compiler/function/values/scope.js";
import type { ValueRecord, ZeroTestOperator } from "#compiler/function/values/record.js";
import type { IntegerRef } from "#compiler/function/values/reference.js";
import type { ValueRef } from "#compiler/function/values.js";
import { lowerFloatOperation } from "./float.js";
import { LowBits } from "./integer/low-bits.js";
import {
  lowerIntegerOperation,
  normalizeInteger,
  type IntegerLowering,
  type IntegerView
} from "./integer/operations.js";

type LoweredValue = Readonly<{
  base: WasmValueId;
  unsigned?: WasmValueId;
  signed?: WasmValueId;
}>;

// A Wasm value id is the position of the lowering walk's first demand;
// placement orders by these positions (plan/placement.ts).
// The walk never identity-mints: resolutionOf answers what a builder identity
// moment already resolved, and lowering memoizes per identity.
export class ValueLowerer {
  readonly #source: FunctionValues;
  readonly #lowered: (LoweredValue | undefined)[];
  readonly #integerLowering: IntegerLowering;

  constructor(
    source: FunctionValues,
    readonly wasm: WasmValuesBuilder
  ) {
    this.#source = source;
    const size = source.identityCount();

    this.#lowered = new Array(size);
    const lower = (value: IntegerRef) => this.lower(value);
    const lowBits = new LowBits(source, wasm, lower);

    this.#integerLowering = {
      wasm,
      lowBits,
      lower,
      normalize: (value, view) => this.normalize(value, view)
    };
  }

  bind(value: ValueRef, wasmValue: WasmValueId): void {
    const { identity, record } = this.#source.resolutionOf(value);
    const wasmType = this.wasm.node(wasmValue).type;

    assert(this.#lowered[identity] === undefined, `source value ${identity} is already defined`);
    assert(
      wasmValueTypeFor(record.kind, record.width) === wasmType,
      `source value ${identity} and Wasm value ${wasmValue} have different representations`
    );
    this.#lowered[identity] = this.#loweringFromBase(record, wasmValue);
  }

  lower(value: ValueRef): WasmValueId {
    return this.#lowering(value).base;
  }

  normalize(value: IntegerRef, view: IntegerView): WasmValueId {
    const { identity, record } = this.#source.resolutionOf(value);
    const width = record.width;
    const lowered = this.#loweringAt(identity, record);

    if (width === 32 || width === 64) {
      return lowered.base;
    }
    const existing = lowered[view];

    if (existing !== undefined) {
      return existing;
    }
    const normalized = normalizeInteger(this.wasm, width, lowered.base, view);

    this.#lowered[identity] = { ...lowered, [view]: normalized };
    return normalized;
  }

  condition(value: IntegerRef): WasmValueId {
    const record = this.#source.resolutionOf(value).record;

    if (record.op === "integer.zeroTest") {
      return record.attr === "eqz"
        ? this.wasm.eqz(this.#zeroTestOperand(record.a))
        : this.#nonzeroCondition(record.a);
    }
    return this.normalize(value, "unsigned");
  }

  isUnreachable(value: ValueRef): boolean {
    return this.#source.resolutionOf(value).record.op === "integer.unreachable";
  }

  // Recursion depth is bounded by the longest unresolved dependent chain:
  // jit/policy.ts caps blocks at 64 instructions, and the interpreter
  // program's 122k selections peak at depth 13.
  #lowering(value: ValueRef): LoweredValue {
    const { identity, record } = this.#source.resolutionOf(value);

    return this.#loweringAt(identity, record);
  }

  #loweringAt(identity: ValueIdentity, record: ValueRecord): LoweredValue {
    const existing = this.#lowered[identity];

    if (existing !== undefined) {
      return existing;
    }
    const lowered = this.#lowerNode(record);

    this.#lowered[identity] = lowered;
    return lowered;
  }

  #lowerNode(record: ValueRecord): LoweredValue {
    switch (record.op) {
      case "integer.bound":
      case "float.bound": {
        const slot = record.bound.slot;

        if (slot.source !== "parameter") {
          assert(false, `source ${slot.source} has not been defined`);
        }
        const width = record.width;

        // The compiler's internal function ABI zero-extends narrow integers in
        // their i32 representation. Body lowering normalizes call arguments and
        // defined results; imported bindings are trusted internal providers.
        return this.#loweringFromBase(
          record,
          this.wasm.parameter(
            slot.index,
            toWasmValueType(slot.type),
            width < 32 ? zeroExtendedRequiredBits(32, width) : undefined
          ),
          width < 32 ? "unsigned" : undefined
        );
      }
      case "integer.constant":
      case "integer.unreachable":
      case "integer.binary":
      case "integer.compare":
      case "integer.truncate":
      case "integer.extend":
      case "integer.bitCount": {
        const { base, normalizedAs } = lowerIntegerOperation(record, this.#integerLowering);

        return this.#loweringFromBase(record, base, normalizedAs);
      }
      case "float.constant":
      case "float.binary":
      case "float.compare":
        return this.#loweringFromBase(record, lowerFloatOperation(record, this));
      case "integer.select":
      case "float.select":
        return this.#loweringFromBase(
          record,
          this.wasm.select(this.condition(record.a), this.lower(record.b), this.lower(record.c))
        );
      case "integer.zeroTest":
        return this.#loweringFromBase(record, this.#zeroTest(record.attr, record.a));
    }
  }

  #zeroTest(operator: ZeroTestOperator, value: IntegerRef): WasmValueId {
    const operand = this.#zeroTestOperand(value);

    if (
      operator === "nonzero" &&
      this.wasm.node(operand).type === "i32" &&
      this.wasm.requiredBits(operand).unsigned <= 1
    ) {
      return operand;
    }
    const zero = this.wasm.eqz(operand);

    return operator === "eqz" ? zero : this.wasm.eqz(zero);
  }

  #zeroTestOperand(value: IntegerRef): WasmValueId {
    const width = value.width;

    if (width >= 32) {
      return this.lower(value);
    }
    const lowered = this.#lowering(value);
    const existing = lowered.signed ?? lowered.unsigned;

    return existing ?? this.normalize(value, width === 1 ? "unsigned" : "signed");
  }

  #nonzeroCondition(value: IntegerRef): WasmValueId {
    const width = value.width;

    if (width === 64) {
      return this.wasm.eqz(this.wasm.eqz(this.lower(value)));
    }
    return width === 32 ? this.lower(value) : this.normalize(value, "unsigned");
  }

  #loweringFromBase(
    record: ValueRecord,
    base: WasmValueId,
    normalizedAs?: IntegerView
  ): LoweredValue {
    const width = record.width;

    if (width >= 32) {
      return { base };
    }
    const bits = this.wasm.requiredBits(base);
    const unreachable = record.op === "integer.unreachable";
    let unsigned = unreachable || bits.unsigned <= width ? base : undefined;
    let signed = unreachable || bits.signed <= width ? base : undefined;

    if (normalizedAs === "unsigned") {
      unsigned = base;
    } else if (normalizedAs === "signed") {
      signed = base;
    }
    return {
      base,
      ...(unsigned === undefined ? {} : { unsigned }),
      ...(signed === undefined ? {} : { signed })
    };
  }
}
