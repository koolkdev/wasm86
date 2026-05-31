import { RegisterState } from "#ir/block/state/register-state.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { RegisterAlias } from "#x86/types.js";
import type {
  RegisterAccessValidator,
  StaticRegisterReadReason
} from "./register-access-validator.js";
import type { OpSite } from "./site.js";

export class RegisterWalkState {
  readonly #site: () => OpSite;
  readonly #validator: RegisterAccessValidator;
  #registers: RegisterState;

  constructor(input: Readonly<{
    registers: RegisterState;
    site: () => OpSite;
    validator: RegisterAccessValidator;
  }>) {
    this.#registers = input.registers;
    this.#site = input.site;
    this.#validator = input.validator;
  }

  get state(): RegisterState {
    return this.#registers;
  }

  readAlias(reg: RegisterAlias, reason: StaticRegisterReadReason): ExprRef {
    this.#validator.staticRead(this.#site(), reason);

    return this.#registers.readAlias(reg);
  }

  writeAlias(reg: RegisterAlias, value: ExprRef): void {
    const at = this.#site();

    if (reg.width !== 32) {
      this.#validator.staticRead(at, "partialRegisterWrite");
    }

    this.#validator.staticWrite(at);

    this.#registers = this.#registers.writeAlias(reg, value);
  }

  resetForDynamicRegisterStore(): void {
    this.#registers = RegisterState.initial();
  }
}
