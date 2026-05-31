import type { FlagName } from "#ir/model/flags.js";
import type { RegisterAlias } from "#x86/types.js";

export type RegisterStateTarget = Readonly<{ kind: "reg"; reg: RegisterAlias }>;
export type FlagStateTarget = Readonly<{ kind: "flag"; flag: FlagName }>;

export type StateTarget =
  | RegisterStateTarget
  | FlagStateTarget;
