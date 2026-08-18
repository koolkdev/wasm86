import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#instructions/lowering/builder.js";
import { immBinding, regBinding } from "#instructions/lowering/bindings.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import { jmpSemantic } from "#instructions/semantics/control.js";
import { movSemantic } from "#instructions/semantics/mov.js";
import { gprChannel } from "#core/state/channels.js";
import { RegionBuilder } from "#compiler/function/builder/region.js";
import { integer, i32, nonzero, u8 } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { buildInstructionFunction } from "./instruction-function.js";
import { testInstructionLowerer } from "#test/support/execution-model.js";
import { writesStateChannel } from "./state-operations.js";

test("lower returns its fallthrough without dispatching", () => {
  const values = new ValueResolver();
  const region = new RegionBuilder(values);
  let dispatches = 0;
  const finalFallthrough = testInstructionLowerer.lower(
    region,
    {
      dispatch: () => {
        dispatches += 1;
      },
      returnExit: (body, result) => {
        body.return([result]);
      }
    },
    (builder) => {
      strictEqual(
        builder.add(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1005)),
        true
      );
    }
  );

  ok(finalFallthrough !== undefined);
  strictEqual(region.constValue(finalFallthrough), 0x1005);
  strictEqual(dispatches, 0);
});

test("a terminating dynamic arm preserves the fallthrough path", () => {
  const conditionalJump: InstructionSemantics = (s) => {
    s.if(nonzero(s.read(s.reg("eax"))), (then) => then.jump(i32(0x2000)));
  };
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(conditionalJump, [], loc(0x1000, 0x1005));
  });

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(continues, true);
});

test("two terminating dynamic arms complete the instruction path", () => {
  const trapEitherWay: InstructionSemantics = (s) => {
    s.ifElse(
      nonzero(s.read(s.reg("eax"))),
      (then) => then.hostTrap(u8(1)),
      (otherwise) => otherwise.hostTrap(u8(2))
    );
    s.write(s.reg("ebx"), i32(7));
  };
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(trapEitherWay, [], loc(0x1000, 0x1005));
  });

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(continues, false);
});

test("a root jump completes the instruction path", () => {
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));
  });

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(continues, false);
});

test("a possible fault cannot be introduced after a memory write", () => {
  const storeThenGuard: InstructionSemantics = (s) => {
    const first = s.memory.guard({
      reference: s.memory.reference("ds", i32(0x2000)),
      byteLength: i32(4),
      intent: "write"
    });

    s.memory.store(first, i32(1));
    s.memory.guard({
      reference: s.memory.reference("ds", s.read(s.reg("eax"))),
      byteLength: i32(4),
      intent: "read"
    });
  };

  throws(
    () =>
      buildInstructionFunction((builder) => {
        builder.add(storeThenGuard, [], loc(0x1000, 0x1001));
      }),
    /CPU exception cannot follow a memory write/
  );
});

test("constant branches build only the selected semantic arms", () => {
  let selectedArms = 0;
  const folded: InstructionSemantics = (s) => {
    s.if(integer(1, 0), () => {
      throw new Error("constant-false arm was built");
    });
    s.ifElse(
      integer(1, 1),
      (then) => {
        selectedArms += 1;
        then.write(then.reg("eax"), i32(7));
      },
      () => {
        throw new Error("constant-false else arm was built");
      }
    );
  };
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(folded, [], loc(0x1000, 0x1001));
  });

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(selectedArms, 1);
  strictEqual(continues, true);
});

test("writing a narrow GPR input back does not emit a state writeback", () => {
  const cases = [
    {
      reg: "al",
      semantic: ((s) => {
        const target = s.reg("al");

        s.write(target, s.read(target));
      }) satisfies InstructionSemantics
    },
    {
      reg: "ax",
      semantic: ((s) => {
        const target = s.reg("ax");

        s.write(target, s.read(target));
      }) satisfies InstructionSemantics
    }
  ] as const;

  for (const { reg, semantic } of cases) {
    const block = buildInstructionFunction((builder) => {
      strictEqual(builder.add(semantic, [], loc(0x1000, 0x1001)), true);
    });

    strictEqual(
      block.entry.nodes.some((node) => writesStateChannel(node, gprChannel(reg))),
      false
    );
  }
});
