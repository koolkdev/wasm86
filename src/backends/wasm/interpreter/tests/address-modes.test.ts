import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { planInterpreterAddressModes } from "#backends/wasm/interpreter/decode/address-modes.js";
import { buildIr } from "#x86/ir/build/builder.js";
import type { SemanticOperandInfo } from "#x86/ir/model/types.js";
import { xchgSemantic } from "#x86/isa/semantics/xchg.js";

test("interpreter address modes defer first addressing after a register write", () => {
  const operandInfo = [{ storage: "regOrMem" }] as const satisfies readonly SemanticOperandInfo[];
  const program = buildIr((s) => {
    const dst = s.operand(0);
    const esp = s.get(s.reg("esp"));

    s.set(s.reg("esp"), s.i32Add(esp, 4));
    s.memoryGuard(s.address(dst), 4, "write");
  }, { operandInfo });

  deepStrictEqual(planInterpreterAddressModes(program, operandInfo), ["deferred"]);
});

test("interpreter address modes keep XCHG r/m32, r32 addressing eager", () => {
  const operandInfo = [
    { storage: "regOrMem" },
    { storage: "reg" }
  ] as const satisfies readonly SemanticOperandInfo[];
  const program = buildIr(xchgSemantic(32), { operandInfo });

  deepStrictEqual(planInterpreterAddressModes(program, operandInfo), ["eager", "eager"]);
});
