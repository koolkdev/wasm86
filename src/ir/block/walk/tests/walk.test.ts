import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding,
  memBinding,
  valueBinding
} from "#ir/block/bindings/resolver.js";
import {
  BlockState,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import type { BlockTimelineSite } from "#ir/block/timeline.js";
import {
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrOp,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("shared block walk applies register writes through RegisterState", () => {
  const result = walkFragment({
    block: [
      { op: "value.const", type: "i32", dst: v(0), value: 0x12 },
      { op: "set", target: { kind: "reg", reg: "al" }, value: v(0), accessWidth: 8 }
    ]
  });

  deepStrictEqual(
    result.final.registers.read("eax"),
    exprInsertBits(exprInput({ kind: "reg", reg: "eax" }), exprConst(0x12), 0, 8)
  );
  deepStrictEqual(result.timeline, []);
});

test("shared block walk rejects value bindings as write targets", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "operand", index: 0 }, value: c(1), accessWidth: 32 }
      ],
      resolver: new BindingResolver({
        operands: [valueBinding(exprConst(7))]
      })
    }),
    /operand 0 is a value binding, not storage/
  );
});

test("shared block walk reads value-bound operands as expressions", () => {
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [valueBinding(binary("add", exprInput({ kind: "reg", reg: "ebx" }), exprConst(4)))]
    })
  });

  deepStrictEqual(
    result.final.registers.read("eax"),
    binary("add", exprInput({ kind: "reg", reg: "ebx" }), exprConst(4))
  );
});

test("shared block walk writes operand storage using the binding width", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0xaa), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [memBinding(exprConst(0x3000), 8)]
    })
  });
  const action = onlyAction(blockWalkActions(result));

  strictEqual(action.kind, "memoryStore");
  if (action.kind === "memoryStore") {
    strictEqual(action.width, 8);
    deepStrictEqual(action.address, exprConst(0x3000));
    deepStrictEqual(action.value, exprConst(0xaa));
  }
});

test("shared block walk keeps dynamic register reads and writes as ordered runtime facts", () => {
  const readIndex = exprInput({ kind: "flag", flag: "ZF" });
  const writeIndex = exprInput({ kind: "reg", reg: "esi" });
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(readIndex, 32),
        dynamicRegBinding(writeIndex, 32)
      ]
    })
  });
  const definitions = blockWalkDefinitions(result);
  const definition = definitions[0]!;
  const action = onlyAction(blockWalkActions(result));

  strictEqual(definitions.length, 1);
  strictEqual(definition.kind, "dynamicRegisterLoad");
  if (definition.kind === "dynamicRegisterLoad") {
    strictEqual(definition.id, 0);
    deepStrictEqual(definition.result, { kind: "def", id: 0 });
    deepStrictEqual(definition.index, readIndex);
    strictEqual(definition.width, 32);
  }

  strictEqual(action.kind, "dynamicRegisterStore");
  if (action.kind === "dynamicRegisterStore") {
    deepStrictEqual(action.index, writeIndex);
    deepStrictEqual(action.value, exprInput(definition.result));
    strictEqual(action.width, 32);
  }

  deepStrictEqual(
    result.timeline.map(timelineSiteKind),
    ["dynamicRegisterLoad", "dynamicRegisterStore"]
  );
  deepStrictEqual(result.final.registers.read("eax"), exprInput({ kind: "reg", reg: "eax" }));
  deepStrictEqual(result.final.registers.read("esi"), exprInput({ kind: "reg", reg: "esi" }));
});

test("dynamic register validation requires loads to use the pre-write register state", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x55), accessWidth: 32 },
        { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 }
      ],
      resolver: new BindingResolver({
        operands: [dynamicRegBinding(exprConst(1), 32)]
      })
    }),
    /dynamic register load after register write/
  );
});

test("dynamic register validation rejects loads after dynamic register stores", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
        { op: "get", dst: v(0), source: { kind: "operand", index: 1 }, accessWidth: 32 }
      ],
      resolver: new BindingResolver({
        operands: [
          dynamicRegBinding(exprConst(1), 32),
          dynamicRegBinding(exprConst(2), 32)
        ]
      })
    }),
    /dynamic register load after register write/
  );
});

test("dynamic register validation rejects later static register reads", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 }
      ],
      resolver: new BindingResolver({
        operands: [dynamicRegBinding(exprConst(1), 32)]
      })
    }),
    /register read after dynamic register store/
  );
});

test("dynamic register validation rejects partial static register writes after dynamic register stores", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
        { op: "set", target: { kind: "reg", reg: "al" }, value: c(0x66), accessWidth: 8 }
      ],
      resolver: new BindingResolver({
        operands: [dynamicRegBinding(exprConst(1), 32)]
      })
    }),
    /partial register write after dynamic register store/
  );
});

test("dynamic register validation rejects later static register writes", () => {
  throws(
    () => walkFragment({
      block: [
        { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: c(0x66), accessWidth: 32 }
      ],
      resolver: new BindingResolver({
        operands: [dynamicRegBinding(exprConst(1), 32)]
      })
    }),
    /register write after dynamic register store/
  );
});

test("dynamic register stores allow earlier static register writes", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "reg", reg: "esp" }, value: c(0x44), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(4), 32)]
    })
  });

  strictEqual(onlyAction(blockWalkActions(result)).kind, "dynamicRegisterStore");
  deepStrictEqual(result.timeline.map(timelineSiteKind), ["stateSync", "dynamicRegisterStore"]);
  strictEqual(result.timeline[0]?.kind, "boundary");
  if (result.timeline[0]?.kind === "boundary") {
    deepStrictEqual(result.timeline[0].boundary.state.registers.read("esp"), exprConst(0x44));
  }
  deepStrictEqual(result.final.registers.read("esp"), exprInput({ kind: "reg", reg: "esp" }));
});

test("dynamic register stores allow xchg-style tail stores from preloaded values", () => {
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "get", dst: v(1), source: { kind: "operand", index: 1 }, accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 0 }, value: v(1), accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(1), 32),
        dynamicRegBinding(exprConst(2), 32)
      ]
    })
  });
  const definitions = blockWalkDefinitions(result);
  const actions = blockWalkActions(result);

  strictEqual(definitions.length, 2);
  deepStrictEqual(actions.map((action) => action.kind), ["dynamicRegisterStore", "dynamicRegisterStore"]);
  strictEqual(actions[0]?.kind, "dynamicRegisterStore");
  if (actions[0]?.kind === "dynamicRegisterStore") {
    deepStrictEqual(actions[0].value, exprInput(definitions[1]!.result));
  }
  strictEqual(actions[1]?.kind, "dynamicRegisterStore");
  if (actions[1]?.kind === "dynamicRegisterStore") {
    deepStrictEqual(actions[1].value, exprInput(definitions[0]!.result));
  }
});

test("shared block walk applies flags.write and resolves direct flag conditions", () => {
  const result = walkExpressionBlock({
    block: [
      {
        op: "flags.write",
        cells: {
          ZF: { kind: "expr", value: c(0) }
        },
        conditions: {
          E: c(1)
        }
      },
      { op: "flags.condition", dst: v(0), cc: "E" },
      { op: "conditionalJump", condition: v(0), taken: c(0x20), notTaken: c(0x30) }
    ]
  });

  strictEqual(blockWalkActions(result).length, 1);
  const action = onlyAction(blockWalkActions(result));
  strictEqual(action.kind, "branch");
  deepStrictEqual(action.condition, exprConst(1));
  deepStrictEqual(action.takenTarget, exprConst(0x20));
  deepStrictEqual(action.continuation, { kind: "continuation", value: exprConst(0x30) });
  deepStrictEqual(action.notTaken.payload, { kind: "branch", direction: "notTaken" });
  deepStrictEqual(result.final.flags.read("ZF"), { kind: "expr", value: exprConst(0) });
});

test("shared block walk resolves composed flag conditions from current flag cells", () => {
  const result = walkExpressionBlock({
    block: [
      {
        op: "flags.write",
        cells: {
          CF: { kind: "expr", value: c(0) },
          ZF: { kind: "expr", value: c(0) }
        }
      },
      { op: "flags.condition", dst: v(0), cc: "A" },
      { op: "conditionalJump", condition: v(0), taken: c(0x20), notTaken: c(0x30) }
    ]
  });

  const action = onlyAction(blockWalkActions(result));
  strictEqual(action.kind, "branch");
  deepStrictEqual(action.condition, binary(
    "and",
    binary("xor", exprConst(0), exprConst(1)),
    binary("xor", exprConst(0), exprConst(1))
  ));
});

test("shared block walk rejects legacy packed flags.set producers", () => {
  throws(
    () => walkFragment({
      block: [
        {
          op: "flags.set",
          producer: "logic",
          width: 32,
          writtenMask: 0,
          undefMask: 0,
          inputs: {}
        }
      ]
    }),
    /legacy flags\.set is not supported/
  );
});

test("shared block walk emits branch actions with resolved expressions and snapshots", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "value.compare", type: "i32", operator: "eq", width: 32, dst: v(0), a: c(3), b: c(4) },
      { op: "conditionalJump", condition: v(0), taken: c(0x40), notTaken: c(0x44) }
    ]
  });

  const action = onlyAction(blockWalkActions(result));
  strictEqual(action.kind, "branch");
  deepStrictEqual(action.condition, compare("eq", exprConst(3), exprConst(4)));
  deepStrictEqual(action.taken.payload, { kind: "branch", direction: "taken", target: exprConst(0x40) });
  deepStrictEqual(action.continuation, { kind: "continuation", value: exprConst(0x44) });
  deepStrictEqual(action.notTaken.payload, { kind: "branch", direction: "notTaken" });
  strictEqual(action.taken.id, 0);
  strictEqual(action.notTaken.id, 1);
  strictEqual(action.taken.snapshot.progress.opIndex, 1);
  strictEqual(action.notTaken.snapshot.progress.phase, "before");
});

test("conditional branch not-taken nextEip uses the caller continuation", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: { kind: "nextEip" } }
    ],
    continuation: exprConst(0x44)
  });
  const action = onlyAction(blockWalkActions(result));

  strictEqual(action.kind, "branch");
  deepStrictEqual(action.continuation, { kind: "continuation", value: exprConst(0x44) });
  deepStrictEqual(action.notTaken.payload, {
    kind: "branch",
    direction: "notTaken"
  });
});

test("shared block walk emits jump and fallthrough exits carrying current snapshots", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x1234), accessWidth: 32 },
      { op: "jump", target: c(0x80) }
    ]
  });
  const action = onlyAction(blockWalkActions(result));

  strictEqual(action.kind, "jump");
  deepStrictEqual(action.exit.snapshot.registers.read("eax"), exprConst(0x1234));
  deepStrictEqual(action.exit.payload, { kind: "jump", target: exprConst(0x80) });

  const fallthrough = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "reg", reg: "ebx" }, value: c(0x5678), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  });
  const fallthroughAction = onlyAction(blockWalkActions(fallthrough));

  strictEqual(fallthroughAction.kind, "fallthrough");
  deepStrictEqual(fallthroughAction.continuation, { kind: "continuation", value: exprConst(0x90) });
  deepStrictEqual(fallthroughAction.exit.snapshot.registers.read("ebx"), exprConst(0x5678));
  deepStrictEqual(fallthroughAction.exit.payload, { kind: "fallthrough" });
});

test("memory guard fault exits preserve the pre-fault snapshot", () => {
  const result = walkFragment({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0xfeed), accessWidth: 32 }
    ]
  });

  const action = onlyAction(blockWalkActions(result));
  strictEqual(action.kind, "memoryGuard");
  deepStrictEqual(action.faultExit.snapshot.registers.read("eax"), exprInput({ kind: "reg", reg: "eax" }));
  deepStrictEqual(result.final.registers.read("eax"), exprConst(0xfeed));
  deepStrictEqual(action.faultExit.payload, {
    kind: "memoryFault",
    address: exprConst(0x1000),
    byteLength: 4,
    access: "read"
  });
});

test("memory loads create sequential definitions and later expressions read def inputs", () => {
  const result = walkFragment({
    block: [
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c(1) },
      { op: "get", dst: v(2), source: { kind: "mem", address: c(0x2000) }, accessWidth: 16 },
      { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 32 }
    ]
  });

  deepStrictEqual(blockWalkActions(result), []);
  deepStrictEqual(result.exits, []);
  const definitions = blockWalkDefinitions(result);
  strictEqual(definitions.length, 2);
  strictEqual(definitions[0]!.id, 0);
  strictEqual(definitions[1]!.id, 1);
  deepStrictEqual(definitions[0]!.result, { kind: "def", id: 0 });
  strictEqual(definitions[0]!.kind, "memoryLoad");
  if (definitions[0]!.kind === "memoryLoad") {
    deepStrictEqual(definitions[0]!.address, exprConst(0x1000));
    strictEqual(definitions[0]!.width, 32);
  }
  strictEqual(definitions[1]!.kind, "memoryLoad");
  if (definitions[1]!.kind === "memoryLoad") {
    strictEqual(definitions[1]!.width, 16);
  }
  deepStrictEqual(result.timeline.map((site) => site.kind), ["definition", "definition"]);
  deepStrictEqual(
    result.final.registers.read("ebx"),
    binary("add", exprInput(definitions[0]!.result), exprConst(1))
  );
});

test("walk timeline preserves memory guard, load definition, and store order", () => {
  const result = walkFragment({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "memory.guard", address: c(0x2000), byteLength: 4, access: "write" },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: v(0), accessWidth: 32 }
    ]
  });

  deepStrictEqual(
    result.timeline.map(timelineSiteKind),
    ["memoryGuard", "exitState", "memoryLoad", "memoryGuard", "exitState", "memoryStore"]
  );
});

test("memory stores become ordered actions", () => {
  const result = walkFragment({
    block: [
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: c(0xaa), accessWidth: 8 }
    ]
  });

  const action = onlyAction(blockWalkActions(result));
  strictEqual(action.kind, "memoryStore");
  deepStrictEqual(action.address, exprConst(0x3000));
  deepStrictEqual(action.value, exprConst(0xaa));
  strictEqual(action.width, 8);
  deepStrictEqual(blockWalkDefinitions(result), []);
});

test("shared block walk throws on unsupported ops without fallback routing", () => {
  const unsupported = { op: "unsupported.shared-walk-test" } as unknown as IrOp;

  throws(
    () => walkFragment({
      block: [
        { op: "value.const", type: "i32", dst: v(0), value: 1 },
        unsupported
      ]
    }),
    /unsupported block walk op unsupported\.shared-walk-test at 1/
  );
});

test("BlockState is immutable and updates structurally", () => {
  const initial = BlockState.initial();
  const same = initial.withRegisters(initial.registers);
  const changed = initial.withProgress({ opIndex: 2, phase: "before" });

  strictEqual(same, initial);
  strictEqual(changed === initial, false);
  strictEqual(changed.progress.opIndex, 2);
});

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}

function onlyAction<T>(actions: readonly T[]): T {
  strictEqual(actions.length, 1);
  return actions[0]!;
}

function walkFragment(
  input: Parameters<typeof walkExpressionBlock>[0]
): ReturnType<typeof walkExpressionBlock> {
  return walkExpressionBlock(input);
}

function blockWalkActions(result: ReturnType<typeof walkExpressionBlock>): readonly BlockAction[] {
  return result.timeline.flatMap((site) => site.kind === "action" ? [site.action] : []);
}

function blockWalkDefinitions(result: ReturnType<typeof walkExpressionBlock>): readonly BlockDefinition[] {
  return result.timeline.flatMap((site) => site.kind === "definition" ? [site.definition] : []);
}

function timelineSiteKind(
  site: BlockTimelineSite
): string {
  switch (site.kind) {
    case "action":
      return site.action.kind;
    case "definition":
      return site.definition.kind;
    case "boundary":
      return site.boundary.kind;
  }
}

function binary(op: "add" | "and" | "xor", left: ExprRef, right: ExprRef): ExprRef {
  return canonicalizeExpr(exprBinary(op, left, right));
}

function compare(op: "eq", left: ExprRef, right: ExprRef): ExprRef {
  return canonicalizeExpr(exprCompare(32, op, left, right));
}
