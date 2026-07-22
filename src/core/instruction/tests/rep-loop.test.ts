import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import {
  createInstructionFunction
} from "#test/support/instruction-function.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import { immBinding, memBinding, regBinding, staticMemSegment } from "#core/instruction/bindings.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import type { IfControl, LoopControl } from "#compiler/ir/controls/index.js";
import type { BodyNode, Body, IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { movSemantic } from "#core/semantics/mov.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  repeCmpsSemantic,
  repeScasSemantic,
  repneCmpsSemantic,
  repneScasSemantic,
  repLodsSemantic,
  repMovsSemantic,
  repStosSemantic
} from "#core/semantics/strings.js";
import { validateIrFunction } from "#ir/validate.js";
import {
  stateWriteValue,
  isStateRead,
  isStateWrite,
  readsStateChannel,
  writesStateChannel,
  type StateReadOperation,
  type StateWriteOperation
} from "./state-operations.js";

// The fused rep shape: one loop control carrying the string registers, a
// per-iteration path with no state traffic for carried channels, fault arms
// that restore iteration-start state, one exit-tail commit, and the unit
// count settled from the ecx delta after the loop.

const repEip = 0x1000;
const repNextEip = 0x1002;

function siOperand(): ReturnType<typeof memBinding> {
  return memBinding({ base: "esi", index: undefined, scale: 1, disp: 0 }, staticMemSegment("ds"));
}

function diOperand(): ReturnType<typeof memBinding> {
  return memBinding({ base: "edi", index: undefined, scale: 1, disp: 0 }, staticMemSegment("es"));
}

function repMovsBlock(): IrFunction {
  const builder = createInstructionFunction();

  builder.add(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
  return builder.finish();
}

function findLoop(block: IrBlock): LoopControl {
  const loops = collectLoops(block.body.nodes);

  strictEqual(loops.length, 1, "block has exactly one loop control");
  return loops[0]!;
}

function collectLoops(nodes: readonly BodyNode[]): LoopControl[] {
  return nodes.flatMap((node): LoopControl[] => {
    if (node.category === "operation") {
      return [];
    }
    switch (node.kind) {
      case "loop":
        return [node];
      case "if":
        return [
          ...collectLoops(node.thenBody.nodes),
          ...(node.elseBody === undefined ? [] : collectLoops(node.elseBody.nodes))
        ];
      case "switch":
        return [
          ...node.cases.flatMap((entry) => collectLoops(entry.body.nodes)),
          ...collectLoops(node.defaultBody.nodes)
        ];
      case "loopContinue":
      case "return":
        return [];
    }
  });
}

// The if whose then-body is the single loopContinue control: the back edge.
function backEdgeIndex(body: Body): number {
  const index = body.nodes.findIndex(
    (node) => node.kind === "if" && node.thenBody.nodes[0]?.kind === "loopContinue"
  );

  ok(index >= 0, "loop body has a back edge");
  return index;
}

function backEdgeUpdates(body: Body): readonly ValueId[] {
  const backEdge = body.nodes[backEdgeIndex(body)] as IfControl;
  const loopContinue = backEdge.thenBody.nodes[0]!;

  ok(loopContinue.kind === "loopContinue", "back edge arm is a loopContinue");
  return loopContinue.updates;
}

function stateWrites(nodes: readonly BodyNode[]): StateWriteOperation[] {
  return nodes.filter(isStateWrite);
}

function readFor(
  block: IrBlock,
  nodes: readonly BodyNode[],
  channel: InstructionStateChannel
): StateReadOperation | undefined {
  return nodes.find((node): node is StateReadOperation =>
    readsStateChannel(block.values, node, channel)
  );
}

function carriedCellFor(
  block: IrBlock,
  loop: LoopControl,
  channel: InstructionStateChannel
): LoopControl["carried"][number] | undefined {
  const backEdge = backEdgeIndex(loop.body);
  const commits = stateWrites(loop.body.nodes.slice(backEdge + 1));
  const index = commits.findIndex((write) =>
    writesStateChannel(block.values, write, channel)
  );

  return index < 0 ? undefined : loop.carried[index];
}

function assertCarriedChannels(
  block: IrBlock,
  loop: LoopControl,
  channels: readonly InstructionStateChannel[]
): void {
  strictEqual(loop.carried.length, channels.length, "carried channel count");
  const backEdge = backEdgeIndex(loop.body);
  const updates = backEdgeUpdates(loop.body);
  const commits = stateWrites(loop.body.nodes.slice(backEdge + 1));

  for (let index = 0; index < channels.length; index += 1) {
    const cell = loop.carried[index];
    const channel = channels[index]!;
    const commit = commits[index];

    ok(cell !== undefined, `carried cell ${index} exists`);
    ok(commit !== undefined, `${channel.kind} commit exists`);
    ok(
      writesStateChannel(block.values, commit, channel),
      `${channel.kind} commit preserves channel order`
    );
    strictEqual(
      stateWriteValue(commit),
      updates[index],
      `${channel.kind} commit uses its loop update`
    );
  }
}

function stateTraffic(nodes: readonly BodyNode[]): BodyNode[] {
  return nodes.filter((node) =>
    isStateRead(node) || isStateWrite(node)
  );
}

function preLoopNodes(block: IrBlock, loop: LoopControl): readonly BodyNode[] {
  const nodes = nodesBeforeLoop(block.body.nodes, loop);

  ok(nodes !== undefined, "loop belongs to the block");
  return nodes;
}

function nodesBeforeLoop(
  nodes: readonly BodyNode[],
  target: LoopControl
): readonly BodyNode[] | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;

    if (node === target) {
      return nodes.slice(0, index);
    }

    const nestedBodies: readonly Body[] = node.kind === "if"
      ? [node.thenBody, ...(node.elseBody === undefined ? [] : [node.elseBody])]
      : node.kind === "switch"
        ? [...node.cases.map((entry) => entry.body), node.defaultBody]
        : node.kind === "loop"
          ? [node.body]
          : [];

    for (const body of nestedBodies) {
      const nested = nodesBeforeLoop(body.nodes, target);

      if (nested !== undefined) {
        return [...nodes.slice(0, index), ...nested];
      }
    }
  }
  return undefined;
}

test("rep movs carries esi, edi, and ecx as loop cells in body write order", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const channels = [gprChannel("esi"), gprChannel("edi"), gprChannel("ecx")];

  assertCarriedChannels(block, loop, channels);

  for (const cell of loop.carried) {
    strictEqual(block.values.node(cell.loopInput).kind, "loopInput");
  }

  // Seeds are the pre-loop reads of the carried channels.
  for (let index = 0; index < loop.carried.length; index += 1) {
    const cell = loop.carried[index]!;
    const channel = channels[index]!;
    const read = readFor(block, preLoopNodes(block, loop), channel);

    ok(
      read !== undefined && read.outputs[0] === cell.seed,
      `${channel.kind} seed comes from a pre-loop read`
    );
  }
});

test("the iteration path has no state ops; carried commits sit in the exit tail", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const backEdge = backEdgeIndex(loop.body);
  const iterationPath = loop.body.nodes.slice(0, backEdge + 1);

  // Carried state lives in cells: nothing on the per-iteration path reads
  // or writes state directly (fault arms are nested, not on the path).
  deepStrictEqual(stateTraffic(iterationPath), []);

  // The exit tail commits each carried channel once, and the back edge
  // carries exactly the values the exit tail commits.
  const updates = backEdgeUpdates(loop.body);
  const tailWrites = stateWrites(loop.body.nodes.slice(backEdge + 1));

  const channels = [gprChannel("esi"), gprChannel("edi"), gprChannel("ecx")];

  strictEqual(tailWrites.length, channels.length);
  for (let index = 0; index < channels.length; index += 1) {
    ok(writesStateChannel(block.values, tailWrites[index]!, channels[index]!));
  }
  deepStrictEqual(tailWrites.map(stateWriteValue), updates);
});

test("instructions after the loop rebase the count from state", () => {
  const builder = createInstructionFunction();

  builder.add(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
  builder.add(movSemantic(32), [regBinding("ebx"), immBinding(7)], loc(repNextEip, repNextEip + 5));

  const block = builder.finish();
  const loopIndex = block.body.nodes.findIndex(
    (node) => node.kind === "if" && node.thenBody.nodes.some((nested) => nested.kind === "loop")
  );

  ok(loopIndex >= 0, "loop entry if exists");

  const countReads = block.body.nodes
    .slice(loopIndex + 1)
    .filter((node) => readsStateChannel(block.values, node, instructionCountField));

  strictEqual(countReads.length, 1, "the post-loop count folds from a fresh read");
});

test("rep lods carries its accumulator instead of writing it through each iteration", () => {
  const builder = createInstructionFunction();

  builder.add(repLodsSemantic(8), [siOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);

  assertCarriedChannels(
    block,
    loop,
    [gprChannel("al"), gprChannel("esi"), gprChannel("ecx")]
  );

  const backEdge = backEdgeIndex(loop.body);
  const iterationWrites = stateWrites(loop.body.nodes.slice(0, backEdge + 1));

  deepStrictEqual(iterationWrites, []);
});

test("repe cmps carries the lazy flag cells and updates them per unit", () => {
  const builder = createInstructionFunction();

  builder.add(repeCmpsSemantic(8), [siOperand(), diOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);
  const channels = [
    gprChannel("esi"),
    gprChannel("edi"),
    gprChannel("ecx"),
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ];

  assertCarriedChannels(block, loop, channels);

  const updates = backEdgeUpdates(loop.body);
  const kindCell = carriedCellFor(block, loop, flagStateFields.lazyKind);

  ok(kindCell !== undefined, "loop carries the lazy flag kind");
  const kindUpdate = updates[loop.carried.indexOf(kindCell)]!;

  strictEqual(block.values.constValue(kindUpdate), lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 8));
});

// GPRs land in body write order (the wrapper decrements ecx after the unit),
// then the lazy trio as one facet-ordered unit.
test("derived carried channels follow body write order across rep forms", () => {
  const cases = [
    {
      name: "rep stos",
      template: repStosSemantic(32),
      bindings: [diOperand()],
      channels: [gprChannel("edi"), gprChannel("ecx")]
    },
    {
      name: "rep lods",
      template: repLodsSemantic(16),
      bindings: [siOperand()],
      channels: [gprChannel("ax"), gprChannel("esi"), gprChannel("ecx")]
    },
    {
      name: "repne cmps",
      template: repneCmpsSemantic(32),
      bindings: [siOperand(), diOperand()],
      channels: [
        gprChannel("esi"),
        gprChannel("edi"),
        gprChannel("ecx"),
        flagStateFields.lazyKind,
        flagStateFields.lazyA,
        flagStateFields.lazyB
      ]
    },
    {
      name: "repe scas",
      template: repeScasSemantic(8),
      bindings: [diOperand()],
      channels: [
        gprChannel("edi"),
        gprChannel("ecx"),
        flagStateFields.lazyKind,
        flagStateFields.lazyA,
        flagStateFields.lazyB
      ]
    },
    {
      name: "repne scas",
      template: repneScasSemantic(8),
      bindings: [diOperand()],
      channels: [
        gprChannel("edi"),
        gprChannel("ecx"),
        flagStateFields.lazyKind,
        flagStateFields.lazyA,
        flagStateFields.lazyB
      ]
    }
  ];

  for (const entry of cases) {
    const builder = createInstructionFunction();

    builder.add(entry.template, entry.bindings, loc(repEip, repNextEip));

    const block = builder.finish();

    assertCarriedChannels(block, findLoop(block), entry.channels);
  }
});

test("loop analysis preserves captured outer value identities", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      const outerConstant = v.const(7);
      let outerValue = s.read(s.reg("eax"), { width: 32 });

      // Keep the captured value well beyond the handful of ids a detached
      // scratch table would happen to allocate before entering the callback.
      for (let index = 0; index < 12; index++) {
        outerValue = v.binary("add", outerValue, v.const(index + 1));
      }

      s.loop((loop, loopV) => {
        loop.write(loop.reg("ebx"), loopV.binary("add", outerValue, outerConstant), { width: 32 });
        return loopV.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();

  assertCarriedChannels(block, findLoop(block), [gprChannel("ebx")]);
  doesNotThrow(() => validateIrFunction(block));
});

test("independent loop analysis and final bodies can access an enclosing-arm cell", () => {
  const builder = createInstructionFunction();

  doesNotThrow(() => {
    builder.add(
      (s, _v) => {
        s.if(s.read(s.reg("eax"), { width: 32 }), (then, thenValues) => {
          const counter = then.var(thenValues.const(2));

          then.loop((loop, loopValues) => {
            const next = loopValues.binary("sub", loop.read(counter, { width: 32 }), loopValues.const(1));

            loop.write(counter, next, { width: 32 });
            return loopValues.compare(32, "ne", next, loopValues.const(0));
          });
          then.read(counter, { width: 32 });
        });
      },
      [],
      loc(repEip, repNextEip)
    );

    validateIrFunction(builder.finish());
  });
});

test("loop analysis does not force its control shape onto final construction", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      const counter = s.var(v.const(3));

      // Discovery sees a fresh architectural state read and inspects the arm
      // conservatively. Final construction sees this pending constant and
      // can inline the selected arm independently.
      s.write(s.reg("eax"), v.const(1), { width: 32 });
      s.loop((loop, loopValues) => {
        loop.if(loop.read(loop.reg("eax"), { width: 32 }), (outer, outerValues) => {
          const next = outerValues.binary(
            "sub",
            outer.read(counter, { width: 32 }),
            outerValues.const(1)
          );

          outer.write(counter, next, { width: 32 });
          outer.if(outer.read(outer.reg("ebx"), { width: 32 }), (inner, innerValues) => {
            inner.write(counter, innerValues.const(0), { width: 32 });
          });
        });
        return loopValues.const(0);
      });
      s.read(counter, { width: 32 });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = findLoop(block);
  const constantStructuredArm = loop.body.nodes.find(
    (node): node is IfControl => (
      node.kind === "if" && block.values.constValue(node.condition) === 1
    )
  );
  const finalNestedArm = loop.body.nodes.find(
    (node): node is IfControl => (
      node.kind === "if" && node.thenBody.nodes[0]?.kind !== "loopContinue"
    )
  );

  strictEqual(constantStructuredArm, undefined, "final loop does not replay discovery control");
  ok(finalNestedArm !== undefined, "selected final arm still builds its nested control");
  doesNotThrow(() => validateIrFunction(block));
});

test("loop analysis conservatively includes writes from an unknown scratch arm", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      // Scratch analysis has no pending EAX fact and visits the arm. Final
      // construction knows the arm is false, but the extra EBX carry remains
      // a safe over-approximation of the loop's architectural writes.
      s.write(s.reg("eax"), v.const(0), { width: 32 });
      s.loop((loop, loopValues) => {
        loop.if(loop.read(loop.reg("eax"), { width: 32 }), (then) => {
          then.write(then.reg("ebx"), loopValues.const(1), { width: 32 });
        });
        return loopValues.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = findLoop(block);

  assertCarriedChannels(block, loop, [gprChannel("ebx")]);
  strictEqual(
    loop.body.nodes.filter((node) => node.kind === "if").length,
    1,
    "only the loop back edge remains in final construction"
  );
  doesNotThrow(() => validateIrFunction(block));
});

test("a loop body register write is derived as a carried channel", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, _v) => {
      s.loop((b, loopV) => {
        b.write(b.reg("eax"), loopV.const(0), { width: 32 });
        return loopV.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();

  assertCarriedChannels(block, findLoop(block), [gprChannel("eax")]);
});

test("a loop body status-flag source write derives the lazy flag carries", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, _v) => {
      s.loop((b, loopV) => {
        b.writeStatusFlagsSource(
          subFlagSource({
            width: 32,
            left: loopV.const(0),
            right: loopV.const(0),
            result: loopV.const(0)
          })
        );
        return loopV.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();

  assertCarriedChannels(
    block,
    findLoop(block),
    [flagStateFields.lazyKind, flagStateFields.lazyA, flagStateFields.lazyB]
  );
});

test("overlapping loop body register writes assert during carry derivation", () => {
  const builder = createInstructionFunction();

  throws(
    () =>
      builder.add(
        (s, _v) => {
          s.loop((b, loopV) => {
            b.write(b.reg("al"), loopV.const(1), { width: 8 });
            b.write(b.reg("ax"), loopV.const(2), { width: 16 });
            return loopV.const(0);
          });
        },
        [],
        loc(repEip, repNextEip)
      ),
    /overlapping state channels/
  );
});

test("a loop body advancing only semantic vars carries nothing", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      const counter = s.var(v.const(3));

      s.loop((b, loopV) => {
        const next = loopV.binary("sub", b.read(counter, { width: 32 }), loopV.const(1));

        b.write(counter, next, { width: 32 });
        return loopV.compare(32, "ne", next, loopV.const(0));
      });
      s.write(s.reg("eax"), s.read(counter, { width: 32 }), { width: 32 });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = findLoop(block);

  deepStrictEqual(loop.carried, []);

  // The post-loop read is its own cell.read op, ordered after the loop.
  const nodes = block.body.nodes;
  const loopIndex = nodes.findIndex((node) => node === loop);
  const readIndex = nodes.findIndex(
    (node) => node.kind === "cell.read"
  );

  ok(loopIndex >= 0, "the block holds the var-driven loop");
  ok(readIndex > loopIndex, "the post-loop cell read sits after the loop");
});
