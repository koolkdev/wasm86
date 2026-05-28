import { RegisterState } from "#ir/block/state/register-state.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { OperandWidth, RegisterAlias } from "#x86/types.js";
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
  #revision = 0;

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

  get revision(): number {
    return this.#revision;
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

    const nextRegisters = this.#registers.writeAlias(reg, value);

    if (nextRegisters !== this.#registers) {
      this.#revision += 1;
    }

    this.#registers = nextRegisters;
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
    this.#registers = RegisterState.initial();
  }

  #access(access: BlockRegisterAccess): void {
    this.#accesses.push(access);
  }
}
