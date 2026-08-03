import { registerAlias, registerAliasByIndex } from "../registers.js";
import type { Reg8, Reg16, Reg32 } from "../types.js";

export function registerAliasTypeContract(): void {
  const ah = registerAlias("ah");
  const ahName: "ah" = ah.name;
  const byteWidth: 8 = ah.width;
  const byteName: Reg8 = registerAliasByIndex(8, 0).name;
  const wordName: Reg16 = registerAliasByIndex(16, 0).name;
  const dwordName: Reg32 = registerAliasByIndex(32, 0).name;

  // @ts-expect-error an 8-bit alias does not widen to a 16-bit alias.
  const wrongWidth: 16 = ah.width;

  void ahName;
  void byteWidth;
  void byteName;
  void wordName;
  void dwordName;
  void wrongWidth;
}
