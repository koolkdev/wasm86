import { reg32, type Reg32, type RegisterAlias } from "#x86/isa/types.js";
import {
  exprBits,
  exprInput,
  exprInsertBits,
  exprProject
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import { exprsEqual } from "#backends/wasm/jit/ir/expressions/equality.js";
import type { ExprRef } from "#backends/wasm/jit/ir/expressions/types.js";

export type RegisterCell = Readonly<{
  reg: Reg32;
  value: ExprRef;
}>;

export class RegisterState {
  readonly #cells: ReadonlyMap<Reg32, RegisterCell>;

  private constructor(cells: ReadonlyMap<Reg32, RegisterCell>) {
    this.#cells = cells;
    Object.freeze(this);
  }

  static initial(): RegisterState {
    const cells = new Map<Reg32, RegisterCell>();

    for (const reg of reg32) {
      cells.set(reg, registerCell(reg, exprInput({ kind: "reg", reg })));
    }

    return new RegisterState(cells);
  }

  read(reg: Reg32): ExprRef {
    return this.#cellFor(reg).value;
  }

  readAlias(alias: RegisterAlias): ExprRef {
    const base = this.read(alias.base);

    if (alias.width === 32) {
      return base;
    }

    return canonicalizeExpr(
      alias.bitOffset === 0
        ? exprProject(alias.width, base)
        : exprBits(base, alias.bitOffset, alias.width)
    );
  }

  write(reg: Reg32, value: ExprRef): RegisterState {
    const nextValue = canonicalizeExpr(value);

    if (exprsEqual(this.read(reg), nextValue)) {
      return this;
    }

    return this.#withCell(registerCell(reg, nextValue));
  }

  writeAlias(alias: RegisterAlias, value: ExprRef): RegisterState {
    const currentAliasValue = this.readAlias(alias);
    const nextAliasValue = canonicalizeExpr(value);

    if (exprsEqual(currentAliasValue, nextAliasValue)) {
      return this;
    }

    if (alias.width === 32) {
      return this.write(alias.base, nextAliasValue);
    }

    const nextBaseValue = canonicalizeExpr(
      exprInsertBits(this.read(alias.base), nextAliasValue, alias.bitOffset, alias.width)
    );

    if (exprsEqual(this.read(alias.base), nextBaseValue)) {
      return this;
    }

    return this.#withCell(registerCell(alias.base, nextBaseValue));
  }

  cells(): readonly RegisterCell[] {
    return Object.freeze(reg32.map((reg) => this.#cellFor(reg)));
  }

  #withCell(cell: RegisterCell): RegisterState {
    const cells = new Map(this.#cells);
    cells.set(cell.reg, cell);

    return new RegisterState(cells);
  }

  #cellFor(reg: Reg32): RegisterCell {
    const cell = this.#cells.get(reg);

    if (cell === undefined) {
      throw new Error(`register state is missing base cell ${reg}`);
    }

    return cell;
  }
}

function registerCell(reg: Reg32, value: ExprRef): RegisterCell {
  return Object.freeze({ reg, value: canonicalizeExpr(value) });
}
