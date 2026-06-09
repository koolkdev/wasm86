import type { IrExprOp, IrValueExpr } from "#wasm/codegen/expressions.js";
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
import type { Reg16, Reg32, Reg8 } from "#x86/types.js";
import {
  jitFlagWriteBitsValue,
  jitFlagWriteWrittenMask
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

  recordReg32(reg: Reg32, value: JitValue): ValueStateWrite {
    this.#regs.writeReg32(reg, value);
    return {
      slot: { kind: "reg32", reg },
      value: this.#regs.readReg32(reg)
    };
  }

  recordReg16(reg: Reg16, value: JitValue): ValueStateWrite {
    this.#regs.writeReg16(reg, value);
    return {
      slot: { kind: "reg16", reg },
      value
    };
  }

  recordReg8(reg: Reg8, value: JitValue): ValueStateWrite {
    this.#regs.writeReg8(reg, value);
    return {
      slot: { kind: "reg8", reg },
      value
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

  recordWrite(
    op: Extract<IrExprOp, { op: "flags.write" }>,
    resolveValue: (expr: IrValueExpr) => JitValue
  ): ValueStateWrite | undefined {
    const mask = jitFlagWriteWrittenMask(op);

    if (mask === 0) {
      return undefined;
    }

    this.#flags.writeFlagBits(mask, jitFlagWriteBitsValue(op, resolveValue));
    return {
      slot: { kind: "aluFlags" },
      value: this.#flags.readAluFlags()
    };
  }
}
