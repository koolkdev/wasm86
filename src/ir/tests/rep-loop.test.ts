import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { subFlagSource } from "#core/semantics/flag-writes.js";
import { immBinding, memBinding, regBinding, staticMemSegment } from "#ir/operands.js";
import {
  gprChannel,
  instructionCountChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  type StateChannel
} from "#ir/slots.js";
import type { Action, IfAction, LoopAction, StateWriteAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { slotsMayAlias } from "#ir/aliasing.js";
import type { ValueId } from "#ir/values.js";
import { movSemantic } from "#core/semantics/mov.js";
import {
  repeCmpsSemantic,
  repeScasSemantic,
  repneCmpsSemantic,
  repneScasSemantic,
  repLodsSemantic,
  repMovsSemantic,
  repStosSemantic
} from "#core/semantics/strings.js";
import { isStateRead, isStateWrite, stateWrite } from "#ir/tests/storage-op-helpers.js";

// The fused rep shape: one loop action carrying the string registers, a
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

function repMovsBlock(): IrBlock {
  const builder = createIrBlockBuilder();

  builder.addInstruction(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
  return builder.finish();
}

function findLoop(block: IrBlock): LoopAction {
  const loops = collectLoops(block.body.actions);

  strictEqual(loops.length, 1, "block has exactly one loop action");
  return loops[0]!;
}

function collectLoops(actions: readonly Action[]): LoopAction[] {
  return actions.flatMap((action): LoopAction[] => {
    switch (action.kind) {
      case "loop":
        return [action];
      case "if":
        return [
          ...collectLoops(action.thenBody.actions),
          ...(action.elseBody === undefined ? [] : collectLoops(action.elseBody.actions))
        ];
      case "switch":
        return [
          ...action.cases.flatMap((entry) => collectLoops(entry.body.actions)),
          ...collectLoops(action.defaultBody.actions)
        ];
      case "op":
      case "loopContinue":
      case "finish":
        return [];
    }
  });
}

// The if whose then-body is the single loopContinue action: the back edge.
function backEdgeIndex(body: Body): number {
  const index = body.actions.findIndex(
    (action) => action.kind === "if" && action.thenBody.actions[0]?.kind === "loopContinue"
  );

  ok(index >= 0, "loop body has a back edge");
  return index;
}

function backEdgeUpdates(body: Body): readonly ValueId[] {
  const backEdge = body.actions[backEdgeIndex(body)] as IfAction;
  const loopContinueAction = backEdge.thenBody.actions[0]!;

  ok(loopContinueAction.kind === "loopContinue", "back edge arm is a loopContinue");
  return loopContinueAction.updates;
}

function stateWrites(actions: readonly Action[]): StateWriteAction[] {
  return actions.filter((action): action is StateWriteAction => isStateWrite(action));
}

function faultArmWrites(body: Body): StateWriteAction[] {
  const guardArm = body.actions.find(
    (action): action is IfAction => action.kind === "if" && action.thenBody.actions[0]?.kind !== "loopContinue"
  );

  ok(guardArm !== undefined, "loop body has a guard fault arm");
  return stateWrites(guardArm.thenBody.actions);
}

function writeFor(writes: readonly StateWriteAction[], channel: StateChannel): StateWriteAction {
  const write = writes.find((action) => slotsMayAlias(action.op.slot, channel));

  ok(write !== undefined, `state write for ${channel.kind} exists`);
  return write;
}

function preLoopActions(block: IrBlock): readonly Action[] {
  const enterIf = loopEnterIf(block);
  const loopIndex = enterIf.thenBody.actions.findIndex((action) => action.kind === "loop");

  ok(loopIndex >= 0, "loop entry arm holds a loop");
  return [
    ...block.body.actions.slice(0, block.body.actions.indexOf(enterIf)),
    ...enterIf.thenBody.actions.slice(0, loopIndex)
  ];
}

test("rep movs carries esi, edi, and ecx as loop cells in body write order", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);

  deepStrictEqual(
    loop.carried.map((cell) => cell.channel),
    [gprChannel("esi"), gprChannel("edi"), gprChannel("ecx")]
  );

  for (const cell of loop.carried) {
    strictEqual(block.values.node(cell.loopInput).kind, "loopInput");
  }

  // Seeds are the pre-loop reads of the carried channels.
  const seedReads = preLoopActions(block).filter(isStateRead);

  for (const cell of loop.carried) {
    const read = seedReads.find(
      (action) => action.output === cell.seed && slotsMayAlias(action.op.slot, cell.channel!)
    );

    ok(read !== undefined, `${cell.channel!.kind} seed comes from a pre-loop read`);
  }
});

test("the iteration path has no state ops; carried commits sit in the exit tail", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const backEdge = backEdgeIndex(loop.body);
  const iterationPath = loop.body.actions.slice(0, backEdge + 1);

  // Carried state lives in cells: nothing on the per-iteration path reads
  // or writes state directly (fault arms are nested, not on the path).
  deepStrictEqual(iterationPath.filter((action) => isStateRead(action) || isStateWrite(action)), []);

  // The exit tail commits each carried channel once, and the back edge
  // carries exactly the values the exit tail commits.
  const updates = backEdgeUpdates(loop.body);
  const tailWrites = stateWrites(loop.body.actions.slice(backEdge + 1));

  deepStrictEqual(
    tailWrites.map((action) => action.op.slot),
    loop.carried.map((cell) => cell.channel)
  );
  deepStrictEqual(tailWrites.map((action) => action.op.value), updates);
});

test("a mid-body fault restores iteration-start carried values and the rep eip", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const writes = faultArmWrites(loop.body);

  for (const cell of loop.carried) {
    strictEqual(writeFor(writes, cell.channel!).op.value, cell.loopInput);
  }

  const eipWrite = writes.find((action) => action.op.slot.kind === "eip");

  ok(eipWrite !== undefined, "fault arm flushes eip");
  strictEqual(block.values.constValue(eipWrite.op.value), repEip);
});

// The if whose then-body holds the loop: the loop's enter join.
function loopEnterIf(block: IrBlock): IfAction {
  const entry = block.body.actions.find(
    (action): action is IfAction =>
      action.kind === "if" && action.thenBody.actions.some((nested) => nested.kind === "loop")
  );

  ok(entry !== undefined, "loop entry if exists");
  return entry;
}

// A channel dirtied before the loop survives only as the cell seed, which the
// ran arm consumes; the zero-trip arm must commit it or memory keeps the
// stale pre-loop value.
test("a dirty-at-entry carried channel commits its seed on the zero-trip arm", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("ebx")], loc(repEip - 2, repEip));
  builder.addInstruction(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);
  const enterIf = loopEnterIf(block);

  ok(enterIf.elseBody !== undefined, "the loop entry if has a zero-trip arm");

  const elseWrites = stateWrites(enterIf.elseBody.actions);
  const ecxCell = loop.carried.find((cell) => cell.channel === gprChannel("ecx"));

  ok(ecxCell !== undefined, "loop carries ecx");
  strictEqual(writeFor(elseWrites, gprChannel("ecx")).op.value, ecxCell.seed);

  // Memory-backed carried channels already read back correctly when the loop
  // never runs; only dirty-at-entry channels commit here.
  for (const reg of ["esi", "edi"] as const) {
    ok(
      elseWrites.every((write) => !slotsMayAlias(write.op.slot, gprChannel(reg))),
      `${reg} gets no zero-trip commit`
    );
  }

  // A lone rep dirties nothing before the loop: no else arm at all.
  strictEqual(loopEnterIf(repMovsBlock()).elseBody, undefined);
});

// The count is not carried: the root settles extra completed units as
// (entryEcx - exitEcx) - enter, then implicit fallthrough folds in the instruction itself.
test("the root count write folds the ecx delta over the block's read", () => {
  const block = repMovsBlock();
  const v = block.values;
  const loop = findLoop(block);
  const enterIf = loopEnterIf(block);
  const loopIndex = enterIf.thenBody.actions.findIndex((action) => action.kind === "loop");

  ok(loopIndex >= 0, "loop entry arm holds a loop");

  const enteredAfterLoop = enterIf.thenBody.actions.slice(loopIndex + 1);
  const rootAfterEntry = block.body.actions.slice(block.body.actions.indexOf(enterIf) + 1);
  const exitEcxRead = rootAfterEntry
    .filter(isStateRead)
    .find((action) => slotsMayAlias(action.op.slot, gprChannel("ecx")));
  const countRead = rootAfterEntry
    .filter(isStateRead)
    .find((action) => action.op.slot.kind === "instructionCount");
  const finish = block.body.actions.at(-1);

  deepStrictEqual(enteredAfterLoop.filter((action) => isStateRead(action) || isStateWrite(action)), []);
  ok(exitEcxRead !== undefined, "the count settle re-reads ecx after the loop");
  ok(countRead !== undefined, "the count folds from a post-entry read");
  ok(finish?.kind === "finish" && finish.finish.kind === "dispatch", "fallthrough dispatches");
  strictEqual(v.constValue(finish.finish.targetEip), repNextEip);

  const ecxSeed = loop.carried.find((cell) => cell.channel === gprChannel("ecx"))!.seed;
  const delta = v.binary("sub", v.binary("sub", ecxSeed, exitEcxRead.output), enterIf.condition);

  deepStrictEqual(
    stateWrites(rootAfterEntry).filter((action) => action.op.slot.kind === "instructionCount"),
    [stateWrite(instructionCountChannel, v.binary("add", v.binary("add", countRead.output, delta), v.const(1)))]
  );
});

test("instructions after the loop rebase the count from state", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), immBinding(7)], loc(repNextEip, repNextEip + 5));

  const block = builder.finish();
  const loopIndex = block.body.actions.findIndex(
    (action) => action.kind === "if" && action.thenBody.actions.some((nested) => nested.kind === "loop")
  );

  ok(loopIndex >= 0, "loop entry if exists");

  const countReads = block.body.actions
    .slice(loopIndex + 1)
    .filter((action) => isStateRead(action) && action.op.slot.kind === "instructionCount");

  strictEqual(countReads.length, 1, "the post-loop count folds from a fresh read");
});

test("rep lods carries its accumulator instead of writing it through each iteration", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(repLodsSemantic(8), [siOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);

  deepStrictEqual(
    loop.carried.map((cell) => cell.channel),
    [gprChannel("al"), gprChannel("esi"), gprChannel("ecx")]
  );

  const backEdge = backEdgeIndex(loop.body);
  const iterationWrites = stateWrites(loop.body.actions.slice(0, backEdge + 1));

  deepStrictEqual(iterationWrites, []);
  strictEqual(writeFor(faultArmWrites(loop.body), gprChannel("al")).op.value, loop.carried[0]!.loopInput);
});

test("repe cmps carries the lazy flag cells and updates them per unit", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(repeCmpsSemantic(8), [siOperand(), diOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);

  deepStrictEqual(
    loop.carried.map((cell) => cell.channel),
    [
      gprChannel("esi"),
      gprChannel("edi"),
      gprChannel("ecx"),
      lazyFlagsKindChannel,
      lazyFlagsAChannel,
      lazyFlagsBChannel
    ]
  );

  // A first-unit fault must report the pre-rep flags: the lazy cells seed
  // from state and restore through their loop inputs like any carried cell.
  const writes = faultArmWrites(loop.body);

  for (const cell of loop.carried) {
    strictEqual(writeFor(writes, cell.channel!).op.value, cell.loopInput);
  }

  const updates = backEdgeUpdates(loop.body);
  const kindUpdate = updates[loop.carried.findIndex((cell) => cell.channel === lazyFlagsKindChannel)]!;

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
        lazyFlagsKindChannel,
        lazyFlagsAChannel,
        lazyFlagsBChannel
      ]
    },
    {
      name: "repe scas",
      template: repeScasSemantic(8),
      bindings: [diOperand()],
      channels: [gprChannel("edi"), gprChannel("ecx"), lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel]
    },
    {
      name: "repne scas",
      template: repneScasSemantic(8),
      bindings: [diOperand()],
      channels: [gprChannel("edi"), gprChannel("ecx"), lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel]
    }
  ];

  for (const entry of cases) {
    const builder = createIrBlockBuilder();

    builder.addInstruction(entry.template, entry.bindings, loc(repEip, repNextEip));

    deepStrictEqual(findLoop(builder.finish()).carried.map((cell) => cell.channel), entry.channels, entry.name);
  }
});

test("loop bodies derive carries in a scratch value view before real emission", () => {
  const builder = createIrBlockBuilder();
  const loopValueViews: unknown[] = [];
  let outerValueView: unknown;

  builder.addInstruction(
    (s, v) => {
      outerValueView = v;
      s.loop((_b, loopV) => {
        loopValueViews.push(loopV);
        return loopV.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  builder.finish();
  strictEqual(loopValueViews.length, 2);
  notStrictEqual(loopValueViews[0], loopValueViews[1]);
  strictEqual(loopValueViews[1], outerValueView);
});

test("a loop body register write is derived as a carried channel", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    (s, _v) => {
      s.loop((b, loopV) => {
        b.set(b.reg("eax"), loopV.const(0));
        return loopV.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  deepStrictEqual(findLoop(builder.finish()).carried.map((cell) => cell.channel), [gprChannel("eax")]);
});

test("a loop body status-flag source write derives the lazy flag carries", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
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

  deepStrictEqual(
    findLoop(builder.finish()).carried.map((cell) => cell.channel),
    [lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel]
  );
});

test("overlapping loop body register writes assert during carry derivation", () => {
  const builder = createIrBlockBuilder();

  throws(
    () =>
      builder.addInstruction(
        (s, _v) => {
          s.loop((b, loopV) => {
            b.set(b.reg("al"), loopV.const(1), 8);
            b.set(b.reg("ax"), loopV.const(2), 16);
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
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    (s, v) => {
      const counter = s.var(v.const(3));

      s.loop((b, loopV) => {
        const next = loopV.binary("sub", b.get(counter), loopV.const(1));

        b.set(counter, next);
        return loopV.compare(32, "ne", next, loopV.const(0));
      });
      s.set(s.reg("eax"), s.get(counter));
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = findLoop(block);

  deepStrictEqual(loop.carried, []);

  // The post-loop read is its own var.read op, ordered after the loop.
  const actions = block.body.actions;
  const loopIndex = actions.findIndex((action) => action === loop);
  const readIndex = actions.findIndex(
    (action) => action.kind === "op" && action.op.kind === "var.read"
  );

  ok(loopIndex >= 0, "the block holds the var-driven loop");
  ok(readIndex > loopIndex, "the post-loop var read sits after the loop");
});
