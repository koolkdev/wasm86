import { form, mnemonic, modrmRm } from "../dsl.js";
import { divImplicitSemantic, idivImplicitSemantic } from "#core/semantics/div.js";

export const DIV = mnemonic("div", [
  // F6 /6: DIV r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm8")],
    syntax: "div {0}",
    semantics: divImplicitSemantic(8)
  }),
  // 66 F7 /6: DIV r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm16")],
    syntax: "div {0}",
    semantics: divImplicitSemantic(16)
  }),
  // F7 /6: DIV r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 6 } },
    operands: [modrmRm("rm32")],
    syntax: "div {0}",
    semantics: divImplicitSemantic(32)
  })
]);

export const IDIV = mnemonic("idiv", [
  // F6 /7: IDIV r/m8
  form("rm8", {
    opcode: [0xf6],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm8")],
    syntax: "idiv {0}",
    semantics: idivImplicitSemantic(8)
  }),
  // 66 F7 /7: IDIV r/m16
  form("rm16", {
    prefixes: { operandSize: "override" },
    opcode: [0xf7],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm16")],
    syntax: "idiv {0}",
    semantics: idivImplicitSemantic(16)
  }),
  // F7 /7: IDIV r/m32
  form("rm32", {
    opcode: [0xf7],
    modrm: { match: { reg: 7 } },
    operands: [modrmRm("rm32")],
    syntax: "idiv {0}",
    semantics: idivImplicitSemantic(32)
  })
]);
