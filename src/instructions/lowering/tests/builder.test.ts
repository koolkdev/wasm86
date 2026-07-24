import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  staticInstructionLocation as loc
} from "#instructions/lowering/builder.js";
import {
  immBinding,
  regBinding
} from "#instructions/lowering/bindings.js";
import type { SemanticTemplate } from "#instructions/semantics/builder.js";
import { jmpSemantic } from "#instructions/semantics/control.js";
import { movSemantic } from "#instructions/semantics/mov.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import {
  buildInstructionFunction
} from "./instruction-function.js";
import {
  testInstructionLowerer
} from "#test/support/execution-model.js";

test("lower returns its fallthrough without dispatching", () => {
  const values = new ValueTable();
  const region = new RegionBuilder(values, undefined, ["i64"]);
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
        builder.add(
          movSemantic(32),
          [regBinding("eax"), immBinding(1)],
          loc(0x1000, 0x1005)
        ),
        true
      );
    }
  );

  ok(finalFallthrough !== undefined);
  strictEqual(values.constValue(finalFallthrough), 0x1005);
  strictEqual(dispatches, 0);
});

test("a terminating dynamic arm preserves the fallthrough path", () => {
  const conditionalJump: SemanticTemplate = (s, v) => {
    s.if(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.jump(v.const(0x2000))
    );
  };
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(
      conditionalJump,
      [],
      loc(0x1000, 0x1005)
    );
  });

  validateIrFunction(block);
  strictEqual(continues, true);
});

test("two terminating dynamic arms complete the instruction path", () => {
  const trapEitherWay: SemanticTemplate = (s, v) => {
    s.ifElse(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.hostTrap(v.const(1)),
      (otherwise) => otherwise.hostTrap(v.const(2))
    );
    s.write(s.reg("ebx"), v.const(7), { width: 32 });
  };
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(
      trapEitherWay,
      [],
      loc(0x1000, 0x1005)
    );
  });

  validateIrFunction(block);
  strictEqual(continues, false);
});

test("a root jump completes the instruction path", () => {
  let continues: boolean | undefined;
  const block = buildInstructionFunction((builder) => {
    continues = builder.add(
      jmpSemantic(),
      [immBinding(0x2000)],
      loc(0x1000, 0x1005)
    );
  });

  validateIrFunction(block);
  strictEqual(continues, false);
});

test("a possible fault cannot be introduced after a memory write", () => {
  const storeThenGuard: SemanticTemplate = (s, v) => {
    const first = s.memory.guard({
      reference: s.memory.reference("ds", v.const(0x2000)),
      byteLength: v.const(4),
      intent: "write"
    });

    s.memory.store(first, {
      width: 32,
      value: v.const(1)
    });
    s.memory.guard({
      reference: s.memory.reference(
        "ds",
        s.read(s.reg("eax"), { width: 32 })
      ),
      byteLength: v.const(4),
      intent: "read"
    });
  };

  throws(
    () => buildInstructionFunction((builder) => {
      builder.add(
        storeThenGuard,
        [],
        loc(0x1000, 0x1001)
      );
    }),
    /CPU exception cannot follow a memory write/
  );
});

test("constant branches build only the selected semantic arms", () => {
  let selectedArms = 0;
  const folded: SemanticTemplate = (s, v) => {
    s.if(v.const(0), () => {
      throw new Error("constant-false arm was built");
    });
    s.ifElse(
      v.const(1),
      (then) => {
        selectedArms += 1;
        then.write(then.reg("eax"), v.const(7), { width: 32 });
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

  validateIrFunction(block);
  strictEqual(selectedArms, 1);
  strictEqual(continues, true);
});
