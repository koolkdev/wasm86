import { CONDITION_CODE_DESCRIPTORS } from "#x86/isa/defs/condition-codes.js";
import { form, mnemonic } from "#x86/isa/schema/builders.js";
import { modrmRm } from "#x86/isa/schema/operands.js";
import { setccSemantic } from "#x86/isa/semantics/setcc.js";

export const SETCC = CONDITION_CODE_DESCRIPTORS.map((descriptor) =>
  mnemonic(`set${descriptor.suffix}`, [
    // 0F 90+cc /r: SETcc r/m8
    form("rm8", {
      opcode: [0x0f, 0x90 + descriptor.opcodeLow],
      operands: [modrmRm("rm8")],
      format: { syntax: `set${descriptor.suffix} {0}` },
      semantics: setccSemantic(descriptor.cc)
    })
  ])
);
