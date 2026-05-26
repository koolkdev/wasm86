import type { RegisterState } from "#x86/block/state/register-state.js";
import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth, RegisterAlias } from "#x86/isa/types.js";
import type { BlockRegisterAccess } from "./result.js";
import type { OpSite } from "./site.js";

type RegisterReadReason = Extract<
  BlockRegisterAccess,
  Readonly<{ kind: "registerRead" }>
>["reason"];

export class RegisterWalkState {
  readonly #accesses: BlockRegisterAccess[] = [];
  readonly #site: () => OpSite;
  #registers: RegisterState;

  constructor(input: Readonly<{
    registers: RegisterState;
    site: () => OpSite;
  }>) {
    this.#registers = input.registers;
    this.#site = input.site;
  }

  get state(): RegisterState {
    return this.#registers;
  }

  accesses(): readonly BlockRegisterAccess[] {
    return Object.freeze([...this.#accesses]);
  }

  readAlias(reg: RegisterAlias, reason: RegisterReadReason): ExprRef {
    this.#access(Object.freeze({
      kind: "registerRead",
      at: this.#site(),
      reg,
      reason
    }));

    return this.#registers.readAlias(reg);
  }

  writeAlias(reg: RegisterAlias, value: ExprRef): void {
    const at = this.#site();

    if (reg.width !== 32) {
      this.#access(Object.freeze({
        kind: "registerRead",
        at,
        reg,
        reason: "partialRegisterWrite"
      }));
    }

    this.#registers = this.#registers.writeAlias(reg, value);
    this.#access(Object.freeze({
      kind: "registerWrite",
      at,
      reg
    }));
  }

  dynamicLoad(index: ExprRef, width: OperandWidth): void {
    this.#access(Object.freeze({
      kind: "dynamicRegisterLoad",
      at: this.#site(),
      index,
      width
    }));
  }

  dynamicStore(index: ExprRef, value: ExprRef, width: OperandWidth): void {
    this.#access(Object.freeze({
      kind: "dynamicRegisterStore",
      at: this.#site(),
      index,
      value,
      width
    }));
  }

  #access(access: BlockRegisterAccess): void {
    this.#accesses.push(access);
  }
}
