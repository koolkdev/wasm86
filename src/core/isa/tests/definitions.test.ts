import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { X86_32_CORE } from "#core/isa/x86-32.js";

const instructionsById = new Map(
  X86_32_CORE.instructions.map((instruction) => [
    instruction.id,
    instruction
  ])
);

test("x86-32 core exposes its identity and architectural limit", () => {
  strictEqual(X86_32_CORE.name, "x86-32-core");
  strictEqual(X86_32_CORE.instructionLengthLimit, 15);
});

test("representative fixed, slash-r, slash-digit, and opcode-register forms are described independently", () => {
  const clc = instructionsById.get("clc.near");
  const mov = instructionsById.get("mov.r32_rm32");
  const sub = instructionsById.get("sub.rm32_imm8");
  const movImmediate = instructionsById.get("mov.r32_imm32");

  ok(clc);
  ok(mov);
  ok(sub);
  ok(movImmediate);

  deepStrictEqual(
    {
      opcode: clc.opcode,
      operands: clc.operands,
      syntax: clc.syntax
    },
    {
      opcode: [0xf8],
      operands: undefined,
      syntax: "clc"
    }
  );

  deepStrictEqual(
    {
      opcode: mov.opcode,
      modrm: mov.modrm,
      operands: mov.operands,
      syntax: mov.syntax
    },
    {
      opcode: [0x8b],
      modrm: undefined,
      operands: [
        { kind: "modrm.reg", type: "r32" },
        { kind: "modrm.rm", type: "rm32" }
      ],
      syntax: "mov {0}, {1}"
    }
  );

  deepStrictEqual(
    {
      opcode: sub.opcode,
      modrm: sub.modrm,
      operands: sub.operands
    },
    {
      opcode: [0x83],
      modrm: { match: { reg: 5 } },
      operands: [
        { kind: "modrm.rm", type: "rm32" },
        {
          kind: "imm",
          width: 8,
          semanticWidth: 32,
          extension: "sign"
        }
      ]
    }
  );

  deepStrictEqual(
    {
      opcode: movImmediate.opcode,
      operands: movImmediate.operands
    },
    {
      opcode: [{ byte: 0xb8, bits: 5 }],
      operands: [
        { kind: "opcode.reg", type: "r32" },
        { kind: "imm", width: 32 }
      ]
    }
  );
});

test("operand-size variants describe only their architectural width changes", () => {
  const movDword = instructionsById.get("mov.r32_rm32");
  const movWord = instructionsById.get("mov.r16_rm16");
  const pushWordImmediate = instructionsById.get("push.imm8_o16");
  const jmpWord = instructionsById.get("jmp.rel16");

  ok(movDword);
  ok(movWord);
  ok(pushWordImmediate);
  ok(jmpWord);

  deepStrictEqual(movDword.prefixes, undefined);
  deepStrictEqual(movWord.prefixes, { operandSize: "override" });
  deepStrictEqual(movWord.opcode, movDword.opcode);
  deepStrictEqual(movWord.operands, [
    { kind: "modrm.reg", type: "r16" },
    { kind: "modrm.rm", type: "rm16" }
  ]);

  deepStrictEqual(pushWordImmediate.prefixes, {
    operandSize: "override"
  });
  deepStrictEqual(pushWordImmediate.operands, [
    {
      kind: "imm",
      width: 8,
      semanticWidth: 16,
      extension: "sign"
    }
  ]);

  deepStrictEqual(jmpWord.prefixes, { operandSize: "override" });
  deepStrictEqual(jmpWord.opcode, [0xe9]);
  deepStrictEqual(jmpWord.operands, [{ kind: "rel", width: 16 }]);
});

test("special memory and segment encodings retain their distinct operand shapes", () => {
  const segmentMove = instructionsById.get("mov.rm32_sreg");
  const moffsLoad = instructionsById.get("mov.eax_moffs32");
  const xlat = instructionsById.get("xlat.m8_al");
  const compareExchange = instructionsById.get("cmpxchg8b.m64");

  ok(segmentMove);
  ok(moffsLoad);
  ok(xlat);
  ok(compareExchange);

  deepStrictEqual(
    {
      opcode: segmentMove.opcode,
      operands: segmentMove.operands
    },
    {
      opcode: [0x8c],
      operands: [
        { kind: "modrm.rm", type: "r32_m16" },
        { kind: "modrm.sreg" }
      ]
    }
  );

  deepStrictEqual(
    {
      opcode: moffsLoad.opcode,
      operands: moffsLoad.operands
    },
    {
      opcode: [0xa1],
      operands: [
        { kind: "implicit.reg", reg: "eax", type: "r32" },
        { kind: "moffs", width: 32 }
      ]
    }
  );

  deepStrictEqual(
    {
      opcode: xlat.opcode,
      operands: xlat.operands,
      syntax: xlat.syntax
    },
    {
      opcode: [0xd7],
      operands: [
        {
          kind: "implicit.mem",
          width: 8,
          base: "ebx",
          disp: 0
        }
      ],
      syntax: "xlat"
    }
  );

  deepStrictEqual(
    {
      opcode: compareExchange.opcode,
      modrm: compareExchange.modrm,
      operands: compareExchange.operands
    },
    {
      opcode: [0x0f, 0xc7],
      modrm: { match: { reg: 1 } },
      operands: [{ kind: "modrm.rm", type: "m64" }]
    }
  );
});

test("string descriptors distinguish overridable sources from fixed ES destinations", () => {
  const movs = instructionsById.get("movs.m32_m32");
  const repeatMovs = instructionsById.get("movs.rep_m32_m32");
  const repeatNotEqualCmps = instructionsById.get("cmps.repne_m32_m32");

  ok(movs);
  ok(repeatMovs);
  ok(repeatNotEqualCmps);

  deepStrictEqual(movs.operands, [
    { kind: "implicit.mem", width: 32, base: "esi", disp: 0 },
    {
      kind: "implicit.mem",
      width: 32,
      base: "edi",
      disp: 0,
      segment: "es"
    }
  ]);
  strictEqual(movs.syntax, "movs");

  deepStrictEqual(repeatMovs.prefixes, { rep: "rep" });
  strictEqual(repeatMovs.syntax, "rep movs");

  deepStrictEqual(repeatNotEqualCmps.prefixes, { rep: "repne" });
  strictEqual(repeatNotEqualCmps.syntax, "repne cmps");
});

test("relative control descriptors preserve displacement widths", () => {
  const shortJump = instructionsById.get("jne.rel8");
  const wordJump = instructionsById.get("jne.rel16");
  const nearJump = instructionsById.get("jne.rel32");
  const enter = instructionsById.get("enter.imm16_imm8");

  ok(shortJump);
  ok(wordJump);
  ok(nearJump);
  ok(enter);

  deepStrictEqual(
    {
      opcode: shortJump.opcode,
      prefixes: shortJump.prefixes,
      operands: shortJump.operands
    },
    {
      opcode: [0x75],
      prefixes: undefined,
      operands: [{ kind: "rel", width: 8 }]
    }
  );
  deepStrictEqual(
    {
      opcode: wordJump.opcode,
      prefixes: wordJump.prefixes,
      operands: wordJump.operands
    },
    {
      opcode: [0x0f, 0x85],
      prefixes: { operandSize: "override" },
      operands: [{ kind: "rel", width: 16 }]
    }
  );
  deepStrictEqual(
    {
      opcode: nearJump.opcode,
      prefixes: nearJump.prefixes,
      operands: nearJump.operands
    },
    {
      opcode: [0x0f, 0x85],
      prefixes: undefined,
      operands: [{ kind: "rel", width: 32 }]
    }
  );
  deepStrictEqual(enter.operands, [
    { kind: "imm", width: 16 },
    { kind: "imm", width: 8 }
  ]);
});
