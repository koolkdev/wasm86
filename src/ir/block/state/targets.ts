import type { FlagName } from "#ir/model/flags.js";
import type { RegisterAlias } from "#x86/types.js";

export type RegisterStateTarget = Readonly<{ kind: "reg"; reg: RegisterAlias }>;
export type FlagStateTarget = Readonly<{ kind: "flag"; flag: FlagName }>;

export type StateTarget =
  | RegisterStateTarget
  | FlagStateTarget;

export function stateTargetsEqual(left: StateTarget, right: StateTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "reg":
      return right.kind === "reg" && left.reg === right.reg;
    case "flag":
      return right.kind === "flag" && left.flag === right.flag;
  }
}
