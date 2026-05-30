import type { OpSite } from "./site.js";

type RegisterWriteAccess = Readonly<{
  at: OpSite;
}>;

type DynamicRegisterStoreAccess = Readonly<{
  at: OpSite;
}>;

export type StaticRegisterReadReason = "storageRead" | "partialRegisterWrite";

export class RegisterAccessValidator {
  #firstRegisterWrite: RegisterWriteAccess | undefined;
  #firstDynamicRegisterStore: DynamicRegisterStoreAccess | undefined;

  staticRead(at: OpSite, reason: StaticRegisterReadReason): void {
    if (this.#firstDynamicRegisterStore !== undefined) {
      throw new Error(
        `${registerReadDescription(reason)} after dynamic register store at op ` +
        `${this.#firstDynamicRegisterStore.at.opIndex} is unsupported by the shared block pipeline ` +
        `at op ${at.opIndex}`
      );
    }
  }

  staticWrite(at: OpSite): void {
    if (this.#firstDynamicRegisterStore !== undefined) {
      throw new Error(
        `register write after dynamic register store at op ` +
        `${this.#firstDynamicRegisterStore.at.opIndex} is unsupported by the shared block pipeline ` +
        `at op ${at.opIndex}`
      );
    }

    this.#firstRegisterWrite ??= Object.freeze({ at });
  }

  dynamicLoad(at: OpSite): void {
    if (this.#firstRegisterWrite !== undefined) {
      throw new Error(
        `dynamic register load after register write at op ${this.#firstRegisterWrite.at.opIndex} ` +
        `is unsupported by the shared block pipeline at op ${at.opIndex}`
      );
    }
  }

  dynamicStore(at: OpSite): void {
    const access = Object.freeze({ at });

    this.#firstRegisterWrite ??= access;
    this.#firstDynamicRegisterStore ??= access;
  }
}

function registerReadDescription(reason: StaticRegisterReadReason): string {
  return reason === "partialRegisterWrite"
    ? "partial register write"
    : "register read";
}
