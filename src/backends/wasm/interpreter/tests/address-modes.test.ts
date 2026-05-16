import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { planInterpreterAddressModes } from "#backends/wasm/interpreter/decode/address-modes.js";
import { buildIr } from "#x86/ir/build/builder.js";
import type { SemanticOperandInfo } from "#x86/ir/model/types.js";
import { popSemantic } from "#x86/isa/semantics/stack.js";
import { xchgSemantic } from "#x86/isa/semantics/xchg.js";

test("interpreter address modes defer POP r/m32 destination addressing", () => {
  const operandInfo = [{ storage: "regOrMem" }] as const satisfies readonly SemanticOperandInfo[];
  const program = buildIr(popSemantic(), { operandInfo });

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
