import { CONDITION_CODE_DESCRIPTORS } from "#core/instructions/condition-codes.js";
import { form, mnemonic, modrmRm } from "./dsl.js";
import { setccSemantic } from "#core/semantics/setcc.js";

export const SETCC = CONDITION_CODE_DESCRIPTORS.map((descriptor) =>
  mnemonic(`set${descriptor.suffix}`, [
    // 0F 90+cc /r: SETcc r/m8
    form("rm8", {
      opcode: [0x0f, 0x90 + descriptor.opcodeLow],
      operands: [modrmRm("rm8")],
      syntax: `set${descriptor.suffix} {0}`,
      semantics: setccSemantic(descriptor.cc)
    })
  ])
);
