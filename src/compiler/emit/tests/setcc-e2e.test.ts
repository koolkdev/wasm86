import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import {
  immBinding,
  regBinding
} from "#core/instruction/bindings.js";
import { cmpSemantic } from "#core/semantics/cmp.js";
import { setccSemantic } from "#core/semantics/setcc.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { gprChannel } from "#core/state/channels.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { createInstructionFunction } from "./instruction-function.js";
import {
  instantiateTestFunction,
  testFunctionCompleted
} from "./harness.js";

test("a condition after a flag-writing branch keeps the pending SUB source", async () => {
  const joinedLazyCondition: SemanticTemplate = (s, v) => {
    const left = s.read(s.reg("ebx"), { width: 32 });
    const right = v.const(5);

    s.writeStatusFlagsSource({
      kind: "sub",
      width: 32,
      left,
      right,
      result: v.binary("sub", left, right)
    });
    s.if(
      s.read(s.reg("ecx"), { width: 32 }),
      (then) => then.writeFlag("ZF", v.const(1))
    );
    s.write(
      s.reg("eax"),
      v.select(s.condition("B"), v.const(1), v.const(0)),
      { width: 32 }
    );
  };
  const builder = createInstructionFunction();

  builder.add(joinedLazyCondition, [], loc(0x1000, 0x1001));
  const { stateView, run } = await instantiateTestFunction(builder.finish());

  for (const ecx of [0, 1]) {
    writeWasmCpuStateSnapshot(stateView, {
      eax: 0,
      ebx: 3,
      ecx,
      lazyFlagsA: 10,
      lazyFlagsB: 1
    });
    strictEqual(run(), testFunctionCompleted);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      1,
      `branch condition ${ecx}`
    );
  }
});

test("cmp followed by setbe uses the pending comparison and merges AL", async () => {
  const builder = createInstructionFunction();

  builder.add(
    cmpSemantic(32),
    [regBinding("ebx"), immBinding(5)],
    loc(0x1000, 0x1006)
  );
  builder.add(
    setccSemantic("BE"),
    [regBinding("al")],
    loc(0x1006, 0x1009)
  );
  const { stateView, run } = await instantiateTestFunction(builder.finish());

  for (const [ebx, expected] of [
    [3, 0xdead_be01],
    [7, 0xdead_be00]
  ] as const) {
    writeWasmCpuStateSnapshot(stateView, {
      eax: 0xdead_beaa,
      ebx
    });
    strictEqual(run(), testFunctionCompleted);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      expected
    );
  }
});
