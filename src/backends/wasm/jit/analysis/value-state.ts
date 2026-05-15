import type { IrExprOp } from "#backends/wasm/codegen/expressions.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  createJitValueState,
  createJitValueStateFromSnapshot,
  type JitAluFlagValueFamily,
  type JitRegisterValueFamily,
  type JitValueState,
  type JitValueStateSnapshot
} from "#backends/wasm/jit/state/value-state.js";
import { type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import {
  jitFlagSetProducerValue,
  jitFlagSetWrittenMask
} from "./flag-values.js";

export type ValueStateWrite = Readonly<{
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export class ValueStateBuilder {
  readonly #valueState: JitValueState;
  readonly #registers: RegisterValueStateBuilder;
  readonly #flags: FlagValueStateBuilder;

  constructor(snapshot?: JitValueStateSnapshot) {
    this.#valueState = snapshot === undefined
      ? createJitValueState()
      : createJitValueStateFromSnapshot(snapshot);
    this.#registers = new RegisterValueStateBuilder(this.#valueState.regs);
    this.#flags = new FlagValueStateBuilder(this.#valueState.flags);
  }

  snapshot(): JitValueStateSnapshot {
    return this.#valueState.snapshot();
  }

  registers(): RegisterValueStateBuilder {
    return this.#registers;
  }

  flags(): FlagValueStateBuilder {
    return this.#flags;
  }
}

export class RegisterValueStateBuilder {
  readonly #regs: JitRegisterValueFamily;

  constructor(regs: JitRegisterValueFamily) {
    this.#regs = regs;
  }

  readReg32(reg: Reg32): JitValue {
    return this.#regs.readReg32(reg);
  }

  recordSet(
    reg: Reg32,
    bitOffset: number,
    width: OperandWidth,
    value: JitValue
  ): ValueStateWrite {
    if (width === 32 && bitOffset === 0) {
      this.#regs.writeReg32(reg, value);
    } else {
      this.#regs.writeRegPart(reg, bitOffset, width, value);
    }

    return {
      slot: { kind: "reg32", reg },
      value: this.#regs.readReg32(reg)
    };
  }
}

export class FlagValueStateBuilder {
  readonly #flags: JitAluFlagValueFamily;

  constructor(flags: JitAluFlagValueFamily) {
    this.#flags = flags;
  }

  readAluFlags(): JitValue {
    return this.#flags.readAluFlags();
  }

  recordSet(
    op: Extract<IrExprOp, { op: "flags.set" }>,
    resolveInputs: () => Readonly<Record<string, JitValue>>
  ): ValueStateWrite | undefined {
    const mask = jitFlagSetWrittenMask(op);

    if (mask === 0) {
      return undefined;
    }

    const producer = jitFlagSetProducerValue(op, resolveInputs());

    this.#flags.writeFlagBits(mask, producer);
    return {
      slot: { kind: "aluFlags" },
      value: this.#flags.readAluFlags()
    };
  }
}
