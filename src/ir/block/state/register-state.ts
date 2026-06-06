import { reg32, type Reg32, type RegisterAlias } from "#x86/types.js";
import { exprInput } from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type { ExprRef } from "#ir/expr/types.js";
import {
  materializeRegisterBase,
  normalizeRegisterOverlayWrites,
  readRegisterAlias,
  registerAliasWrite
} from "./register-overlays.js";

const registerStateBrand: unique symbol = Symbol("RegisterState");

type RegisterBaseSnapshot = Readonly<{
  base: Reg32;
  baseValue: ExprRef;
  overlays: readonly ReturnType<typeof registerAliasWrite>[];
}>;

export interface RegisterState {
  readonly [registerStateBrand]: true;
  read(reg: Reg32): ExprRef;
  readAlias(alias: RegisterAlias): ExprRef;
  write(reg: Reg32, value: ExprRef): RegisterState;
  writeAlias(alias: RegisterAlias, value: ExprRef): RegisterState;
}

export const RegisterState = Object.freeze({
  initial(): RegisterState {
    return RegisterStateImpl.initial();
  }
});

class RegisterStateImpl implements RegisterState {
  readonly [registerStateBrand] = true;
  readonly #bases: ReadonlyMap<Reg32, RegisterBaseSnapshot>;

  private constructor(bases: ReadonlyMap<Reg32, RegisterBaseSnapshot>) {
    this.#bases = bases;
    Object.freeze(this);
  }

  static initial(): RegisterStateImpl {
    const bases = new Map<Reg32, RegisterBaseSnapshot>();

    for (const base of reg32) {
      bases.set(base, registerBaseSnapshot({
        base,
        baseValue: exprInput({ kind: "reg", reg: base }),
        overlays: []
      }));
    }

    return new RegisterStateImpl(bases);
  }

  read(reg: Reg32): ExprRef {
    const base = this.#baseFor(reg);

    return materializeRegisterBase(base.baseValue, base.overlays);
  }

  readAlias(alias: RegisterAlias): ExprRef {
    const base = this.#baseFor(alias.base);

    return readRegisterAlias(base.baseValue, base.overlays, alias);
  }

  write(reg: Reg32, value: ExprRef): RegisterState {
    const nextValue = canonicalizeExpr(value);

    if (exprsEqual(this.read(reg), nextValue)) {
      return this;
    }

    return this.#withBase(registerBaseSnapshot({
      base: reg,
      baseValue: nextValue,
      overlays: []
    }));
  }

  writeAlias(alias: RegisterAlias, value: ExprRef): RegisterState {
    const nextAliasValue = canonicalizeExpr(value);

    if (exprsEqual(this.readAlias(alias), nextAliasValue)) {
      return this;
    }

    if (alias.width === 32) {
      return this.write(alias.base, nextAliasValue);
    }

    const current = this.#baseFor(alias.base);
    const overlays = normalizeRegisterOverlayWrites(
      current.overlays,
      registerAliasWrite(alias, nextAliasValue)
    );

    return this.#withBase(registerBaseSnapshot({
      base: current.base,
      baseValue: current.baseValue,
      overlays
    }));
  }

  baseState(reg: Reg32): RegisterBaseSnapshot {
    return this.#baseFor(reg);
  }

  #withBase(base: RegisterBaseSnapshot): RegisterStateImpl {
    const bases = new Map(this.#bases);
    bases.set(base.base, base);

    return new RegisterStateImpl(bases);
  }

  #baseFor(reg: Reg32): RegisterBaseSnapshot {
    const base = this.#bases.get(reg);

    if (base === undefined) {
      throw new Error(`register state is missing base snapshot ${reg}`);
    }

    return base;
  }
}

function registerBaseSnapshot(input: RegisterBaseSnapshot): RegisterBaseSnapshot {
  return Object.freeze({
    base: input.base,
    baseValue: canonicalizeExpr(input.baseValue),
    overlays: Object.freeze(input.overlays.map((write) =>
      registerAliasWrite(write.reg, write.value)
    ))
  });
}
