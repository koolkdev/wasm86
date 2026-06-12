import { x86ArithmeticFlags } from "#x86/flags.js";
import type { FlagName } from "./flags.js";

export const IR_ALU_FLAGS = x86ArithmeticFlags satisfies readonly FlagName[];
