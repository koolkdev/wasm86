import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  staticInstructionLocation as loc,
  valueInstructionLocation,
  type InstructionBuilder
} from "#core/instruction/builder.js";
import {
  immBinding,
  memBinding,
  regBinding,
  staticMemSegment
} from "#core/instruction/bindings.js";
import { invalidOpcode } from "#core/exceptions.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { jmpSemantic } from "#core/semantics/control.js";
import { movSemantic } from "#core/semantics/mov.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { IfControl } from "#compiler/ir/controls/index.js";
import type { Region, RegionNode } from "#compiler/ir/region.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  buildInstructionFunction,
  testInstructionDispatch
} from "./instruction-function.js";
import {
  testInstructionConstruction
} from "#test/support/execution-model.js";
import {
  isMemoryRead,
  isMemoryWrite
} from "#test/support/storage-operations.js";
import {
  readsStateChannel,
  stateWriteValue,
  writesStateChannel,
  type StateReadOperation,
  type StateWriteOperation
} from "./state-operations.js";

function regionsIn(region: Region): Region[] {
  return [
    region,
    ...region.nodes.flatMap((node) =>
      node.nestedBodies.flatMap((nested) => regionsIn(nested.body))
    )
  ];
}

function allNodes(block: FunctionGraph): RegionNode[] {
  return regionsIn(block.body).flatMap((region) => region.nodes);
}

function stateReadsFor(
  block: FunctionGraph,
  nodes: readonly RegionNode[],
  channel: InstructionStateChannel
): StateReadOperation[] {
  return nodes.filter((node): node is StateReadOperation =>
    readsStateChannel(block.values, node, channel)
  );
}

function stateWritesFor(
  block: FunctionGraph,
  nodes: readonly RegionNode[],
  channel: InstructionStateChannel
): StateWriteOperation[] {
  return nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(block.values, node, channel)
  );
}

function dispatchTargets(block: FunctionGraph): ValueId[] {
  return allNodes(block).flatMap((node) => {
    if (
      node.kind !== "return" ||
      node.source.kind !== "invocation" ||
      node.source.invocation.target !== testInstructionDispatch
    ) {
      return [];
    }

    const target = node.source.invocation.inputs[0]?.value;

    return target === undefined ? [] : [target];
  });
}

function rootIf(block: FunctionGraph): IfControl | undefined {
  return block.body.nodes.find(
    (node): node is IfControl => node.kind === "if"
  );
}

test("build publishes state and leaves fallthrough continuation to its caller", () => {
  const values = new ValueTable();
  const instructionStart = values.parameter(0, "i32");
  const nextEip = values.parameter(1, "i32");
  const region = new RegionBuilder(values, undefined, ["i64"]);
  const dispatched: ValueId[] = [];
  const finalFallthrough = testInstructionConstruction.build(
    region,
    {
      dispatch: (_body, targetEip) => {
        dispatched.push(targetEip);
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
          valueInstructionLocation(instructionStart, nextEip)
        ),
        true
      );
    }
  );
  strictEqual(finalFallthrough, nextEip);
  deepStrictEqual(dispatched, []);

  const nodes = region.build().nodes;
  const eipWrites = nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(values, node, coreStateFields.eip)
  );
  const eaxWrites = nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(values, node, gprChannel("eax"))
  );
  const countWrites = nodes.filter((node): node is StateWriteOperation =>
    writesStateChannel(values, node, instructionCountField)
  );

  strictEqual(eipWrites.length, 1);
  strictEqual(stateWriteValue(eipWrites[0]!), nextEip);
  strictEqual(eaxWrites.length, 1);
  strictEqual(values.constValue(stateWriteValue(eaxWrites[0]!)), 1);
  strictEqual(countWrites.length, 1);
});

test("pending values forward across instructions and the last write wins", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(7)],
      loc(0x1000, 0x1005)
    );
    builder.add(
      movSemantic(32),
      [regBinding("ebx"), regBinding("eax")],
      loc(0x1005, 0x1007)
    );
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(9)],
      loc(0x1007, 0x100c)
    );
  });
  const eaxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("eax")
  );
  const ebxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("ebx")
  );

  validateIrFunction(block);
  strictEqual(
    stateReadsFor(block, block.body.nodes, gprChannel("eax")).length,
    0,
    "the second instruction should consume the pending value"
  );
  strictEqual(eaxWrites.length, 1);
  strictEqual(block.values.constValue(stateWriteValue(eaxWrites[0]!)), 9);
  strictEqual(ebxWrites.length, 1);
  strictEqual(block.values.constValue(stateWriteValue(ebxWrites[0]!)), 7);
  deepStrictEqual(
    dispatchTargets(block).map((target) => block.values.constValue(target)),
    [0x100c]
  );
});

test("an overlapping byte write is committed before a wider register read", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(8),
      [regBinding("al"), immBinding(0xaa)],
      loc(0x1000, 0x1002)
    );
    builder.add(
      movSemantic(32),
      [regBinding("ecx"), regBinding("eax")],
      loc(0x1002, 0x1004)
    );
  });
  const nodes = block.body.nodes;
  const alWriteIndex = nodes.findIndex((node) =>
    writesStateChannel(block.values, node, gprChannel("al"))
  );
  const eaxReadIndex = nodes.findIndex((node) =>
    readsStateChannel(block.values, node, gprChannel("eax"))
  );
  const eaxReads = stateReadsFor(block, nodes, gprChannel("eax"));
  const ecxWrites = stateWritesFor(block, nodes, gprChannel("ecx"));

  validateIrFunction(block);
  ok(
    alWriteIndex >= 0 && eaxReadIndex > alWriteIndex,
    "the wider read must observe the committed byte update"
  );
  strictEqual(eaxReads.length, 1);
  strictEqual(ecxWrites.length, 1);
  strictEqual(stateWriteValue(ecxWrites[0]!), eaxReads[0]!.outputs[0]);
});

test("a value captured before a dynamic branch remains valid in both arms", () => {
  const useCapturedValue: SemanticTemplate = (s) => {
    const value = s.read(s.reg("eax"), { width: 32 });
    const condition = s.read(s.reg("edx"), { width: 32 });

    s.ifElse(
      condition,
      (then) => then.write(then.reg("ebx"), value, { width: 32 }),
      (otherwise) =>
        otherwise.write(otherwise.reg("ebx"), value, { width: 32 })
    );
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(useCapturedValue, [], loc(0x1000, 0x1001));
  });
  const branch = rootIf(block);
  const eaxReads = stateReadsFor(
    block,
    block.body.nodes,
    gprChannel("eax")
  );

  validateIrFunction(block);
  ok(branch !== undefined, "the runtime condition should produce a branch");
  ok(branch.elseBody !== undefined, "ifElse should have an else arm");
  strictEqual(eaxReads.length, 1);

  const captured = eaxReads[0]!.outputs[0];
  const thenWrites = stateWritesFor(
    block,
    branch.thenBody.nodes,
    gprChannel("ebx")
  );
  const elseWrites = stateWritesFor(
    block,
    branch.elseBody.nodes,
    gprChannel("ebx")
  );

  strictEqual(thenWrites.length, 1);
  strictEqual(elseWrites.length, 1);
  strictEqual(stateWriteValue(thenWrites[0]!), captured);
  strictEqual(stateWriteValue(elseWrites[0]!), captured);
});

test("continuing branch writes are joined before later instructions read them", () => {
  const selectValue: SemanticTemplate = (s, v) => {
    s.ifElse(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.write(then.reg("ebx"), v.const(1), { width: 32 }),
      (otherwise) =>
        otherwise.write(otherwise.reg("ebx"), v.const(2), { width: 32 })
    );
    s.write(
      s.reg("ecx"),
      s.read(s.reg("ebx"), { width: 32 }),
      { width: 32 }
    );
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(selectValue, [], loc(0x1000, 0x1001));
  });
  const branch = rootIf(block);
  const joinedReads = stateReadsFor(
    block,
    block.body.nodes,
    gprChannel("ebx")
  );
  const resultWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("ecx")
  );

  validateIrFunction(block);
  ok(branch !== undefined && branch.elseBody !== undefined);
  strictEqual(
    stateWritesFor(block, branch.thenBody.nodes, gprChannel("ebx")).length,
    1
  );
  strictEqual(
    stateWritesFor(block, branch.elseBody.nodes, gprChannel("ebx")).length,
    1
  );
  strictEqual(joinedReads.length, 1);
  strictEqual(resultWrites.length, 1);
  strictEqual(
    stateWriteValue(resultWrites[0]!),
    joinedReads[0]!.outputs[0]
  );
});

test("a jump in a dynamic arm terminates that arm but preserves fallthrough", () => {
  const conditionalJump: SemanticTemplate = (s, v) => {
    s.if(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.jump(v.const(0x2000))
    );
  };
  const block = buildInstructionFunction((builder) => {
    strictEqual(
      builder.add(conditionalJump, [], loc(0x1000, 0x1005)),
      true
    );
  });
  const targets = dispatchTargets(block)
    .map((target) => block.values.constValue(target))
    .sort((a, b) => (a ?? 0) - (b ?? 0));

  validateIrFunction(block);
  deepStrictEqual(targets, [0x1005, 0x2000]);
});

test("two terminating branch arms complete the instruction path", () => {
  const trapEitherWay: SemanticTemplate = (s, v) => {
    s.ifElse(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.hostTrap(v.const(1)),
      (otherwise) => otherwise.hostTrap(v.const(2))
    );
    s.write(s.reg("ebx"), v.const(7), { width: 32 });
  };
  const block = buildInstructionFunction((builder) => {
    strictEqual(
      builder.add(trapEitherWay, [], loc(0x1000, 0x1005)),
      false
    );
  });
  const nodes = allNodes(block);
  const eipWrites = stateWritesFor(
    block,
    nodes,
    coreStateFields.eip
  );

  validateIrFunction(block);
  strictEqual(
    stateWritesFor(block, nodes, gprChannel("ebx")).length,
    0,
    "the semantic tail after the completing branch must not run"
  );
  strictEqual(dispatchTargets(block).length, 0);
  strictEqual(eipWrites.length, 2);
  ok(eipWrites.every(
    (write) => block.values.constValue(stateWriteValue(write)) === 0x1005
  ));
});

test("a root jump flushes pending state and rejects later instructions", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(0x77)],
      loc(0x1000, 0x1005)
    );
    strictEqual(
      builder.add(
        jmpSemantic(),
        [immBinding(0x2000)],
        loc(0x1005, 0x100a)
      ),
      false
    );
    throws(
      () => builder.add(
        movSemantic(32),
        [regBinding("ebx"), immBinding(1)],
        loc(0x100a, 0x100f)
      ),
      /after a block terminator/
    );
  });
  const eaxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("eax")
  );

  validateIrFunction(block);
  strictEqual(eaxWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(eaxWrites[0]!)),
    0x77
  );
  deepStrictEqual(
    dispatchTargets(block).map((target) => block.values.constValue(target)),
    [0x2000]
  );
});

test("a host trap commits the resume EIP and stops the semantic tail", () => {
  const trapThenStore: SemanticTemplate = (s, v) => {
    s.hostTrap(v.const(3));
    s.memory.write(
      s.memory.reference("ds", v.const(0x2000)),
      { width: 32, value: v.const(1) }
    );
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(trapThenStore, [], loc(0x1000, 0x1005));
  });
  const nodes = allNodes(block);
  const eipWrites = stateWritesFor(
    block,
    nodes,
    coreStateFields.eip
  );

  validateIrFunction(block);
  strictEqual(nodes.filter(isMemoryWrite).length, 0);
  strictEqual(dispatchTargets(block).length, 0);
  strictEqual(eipWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(eipWrites[0]!)),
    0x1005
  );
});

test("a CPU exception restores the faulting EIP and earlier pending state", () => {
  const fault: SemanticTemplate = (s, v) => {
    s.cpuException(invalidOpcode());
    s.write(s.reg("ebx"), v.const(1), { width: 32 });
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(0x77)],
      loc(0x1000, 0x1005)
    );
    strictEqual(builder.add(fault, [], loc(0x1005, 0x1006)), false);
  });
  const nodes = block.body.nodes;
  const eaxWrites = stateWritesFor(block, nodes, gprChannel("eax"));
  const eipWrites = stateWritesFor(block, nodes, coreStateFields.eip);

  validateIrFunction(block);
  strictEqual(eaxWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(eaxWrites[0]!)),
    0x77
  );
  strictEqual(eipWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(eipWrites[0]!)),
    0x1005
  );
  strictEqual(stateWritesFor(block, nodes, gprChannel("ebx")).length, 0);
  strictEqual(dispatchTargets(block).length, 0);
});

test("a memory fault restores the instruction boundary, not partial writes", () => {
  const writeThenRead: SemanticTemplate = (s, v) => {
    s.write(s.reg("ecx"), v.const(9), { width: 32 });
    s.memory.read(
      s.memory.reference(
        "ds",
        s.read(s.reg("ebx"), { width: 32 })
      ),
      { width: 32 }
    );
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(0x77)],
      loc(0x1000, 0x1005)
    );
    builder.add(writeThenRead, [], loc(0x1005, 0x1007));
  });
  const faultRegion = regionsIn(block.body).slice(1).find((region) =>
    region.nodes.some((node) =>
      node.kind === "return" && node.source.kind === "values"
    )
  );

  validateIrFunction(block);
  ok(faultRegion !== undefined, "the guarded read should have a fault path");

  const faultEaxWrites = stateWritesFor(
    block,
    faultRegion.nodes,
    gprChannel("eax")
  );
  const faultEipWrites = stateWritesFor(
    block,
    faultRegion.nodes,
    coreStateFields.eip
  );

  strictEqual(faultEaxWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(faultEaxWrites[0]!)),
    0x77
  );
  strictEqual(faultEipWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(faultEipWrites[0]!)),
    0x1005
  );
  strictEqual(
    stateWritesFor(block, faultRegion.nodes, gprChannel("ecx")).length,
    0,
    "the current instruction's write must not reach its fault edge"
  );
  strictEqual(faultRegion.nodes.filter(isMemoryRead).length, 0);

  const rootEcxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("ecx")
  );
  const completedEipWrites = stateWritesFor(
    block,
    block.body.nodes,
    coreStateFields.eip
  );

  strictEqual(rootEcxWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(rootEcxWrites[0]!)),
    9
  );
  strictEqual(block.body.nodes.filter(isMemoryRead).length, 1);
  strictEqual(completedEipWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(completedEipWrites[0]!)),
    0x1007
  );
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

test("a failed instruction poisons the builder transaction", () => {
  const partiallyInvalid: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.const(1), { width: 32 });
    s.write(s.operand(1), v.const(2), { width: 32 });
  };

  throws(
    () => buildInstructionFunction((builder) => {
      throws(
        () => builder.add(
          partiallyInvalid,
          [regBinding("eax"), immBinding(0)],
          loc(0x1000, 0x1002)
        ),
        /immediate operand is not writable/
      );
      throws(
        () => builder.add(
          movSemantic(32),
          [regBinding("ecx"), immBinding(2)],
          loc(0x1002, 0x1007)
        ),
        /incomplete instruction/
      );
    }),
    /incomplete instruction/
  );
});

test("build rejects an empty sequence and closes its builder afterward", () => {
  throws(
    () => buildInstructionFunction(() => {}),
    /no instructions were added/
  );

  let escaped: InstructionBuilder | undefined;

  buildInstructionFunction((builder) => {
    escaped = builder;
    builder.add(
      movSemantic(32),
      [regBinding("eax"), immBinding(1)],
      loc(0x1000, 0x1005)
    );
  });

  ok(escaped !== undefined);
  const closedBuilder = escaped;

  throws(
    () => closedBuilder.add(
      movSemantic(32),
      [regBinding("ecx"), immBinding(2)],
      loc(0x1005, 0x100a)
    ),
    /closed instruction builder/
  );
});

test("constant branches build only the reachable semantic path", () => {
  const folded: SemanticTemplate = (s, v) => {
    s.if(v.const(0), () => {
      throw new Error("constant-false arm was built");
    });
    s.ifElse(
      v.const(1),
      (then) => then.write(then.reg("eax"), v.const(7), { width: 32 }),
      () => {
        throw new Error("constant-false else arm was built");
      }
    );
    s.write(
      s.reg("ebx"),
      s.read(s.reg("eax"), { width: 32 }),
      { width: 32 }
    );
  };
  const block = buildInstructionFunction((builder) => {
    builder.add(folded, [], loc(0x1000, 0x1001));
  });
  const eaxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("eax")
  );
  const ebxWrites = stateWritesFor(
    block,
    block.body.nodes,
    gprChannel("ebx")
  );

  validateIrFunction(block);
  strictEqual(
    block.body.nodes.some((node) => node.kind === "if"),
    false
  );
  strictEqual(eaxWrites.length, 1);
  strictEqual(ebxWrites.length, 1);
  strictEqual(
    block.values.constValue(stateWriteValue(eaxWrites[0]!)),
    7
  );
  strictEqual(
    block.values.constValue(stateWriteValue(ebxWrites[0]!)),
    7
  );
});

test("memory operands still participate in the builder's guarded access path", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      movSemantic(32),
      [
        regBinding("eax"),
        memBinding(
          { base: "ebx", index: undefined, scale: 1, disp: 8 },
          staticMemSegment("ds")
        )
      ],
      loc(0x1000, 0x1003)
    );
  });

  validateIrFunction(block);
  strictEqual(block.body.nodes.filter(isMemoryRead).length, 1);
  ok(
    regionsIn(block.body).slice(1).some((region) =>
      stateWritesFor(block, region.nodes, coreStateFields.eip).some(
        (write) =>
          block.values.constValue(stateWriteValue(write)) === 0x1000
      )
    ),
    "the fault path should restart at the instruction boundary"
  );
});
