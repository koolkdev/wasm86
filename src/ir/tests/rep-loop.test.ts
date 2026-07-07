import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { subFlagSource } from "#x86/semantics/flag-writes.js";
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
import { movSemantic } from "#x86/semantics/mov.js";
import {
  repeCmpsSemantic,
  repLodsSemantic,
  repMovsSemantic
} from "#x86/semantics/strings.js";
import { isStateRead, isStateWrite } from "#ir/tests/storage-op-helpers.js";

// The fused rep shape: one loop action carrying the string registers and the
// count, a per-iteration path with no state traffic for carried channels,
// fault arms that restore iteration-start state, and one exit-tail commit.

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

test("rep movs carries ecx, esi, edi, and the count as loop cells", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);

  deepStrictEqual(
    loop.carried.map((cell) => cell.channel),
    [gprChannel("ecx"), gprChannel("esi"), gprChannel("edi"), instructionCountChannel]
  );

  for (const cell of loop.carried) {
    strictEqual(block.values.node(cell.loopInput).kind, "loopInput");
  }

  // Seeds are the pre-loop reads of the carried channels.
  const rootReads = block.body.actions.filter(isStateRead);

  for (const cell of loop.carried) {
    const read = rootReads.find(
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

  // The exit tail commits each carried channel once. Instruction count is
  // different: onContinue adds one only to the taken back edge, while normal
  // fallthrough counts the final iteration after the loop.
  const updates = backEdgeUpdates(loop.body);
  const tailWrites = stateWrites(loop.body.actions.slice(backEdge + 1));

  deepStrictEqual(
    tailWrites.map((action) => action.op.slot),
    loop.carried.map((cell) => cell.channel)
  );

  for (const [index, write] of tailWrites.entries()) {
    if (write.op.slot.kind === "instructionCount") {
      const countUpdate = block.values.node(updates[index]!);

      ok(countUpdate.kind === "binary" && countUpdate.operator === "add", "continue count advances by one");
      strictEqual(countUpdate.a, write.op.value);
      strictEqual(block.values.constValue(countUpdate.b), 1);
      continue;
    }

    strictEqual(write.op.value, updates[index]);
  }
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

test("the zero-trip arm counts the rep as one instruction at nextEip", () => {
  const block = repMovsBlock();
  const writes = stateWrites(block.body.actions);
  const countWrite = writes.find((action) => action.op.slot.kind === "instructionCount");
  const finish = block.body.actions.at(-1);

  ok(countWrite !== undefined, "fallthrough writes instruction count");
  ok(finish?.kind === "finish" && finish.finish.kind === "dispatch", "fallthrough dispatches");

  const countNode = block.values.node(countWrite.op.value);

  strictEqual(block.values.constValue(finish.finish.targetEip), repNextEip);
  ok(countNode.kind === "binary" && countNode.operator === "add", "fallthrough advances the count");
  strictEqual(block.values.constValue(countNode.b), 1);
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
    [gprChannel("ecx"), gprChannel("esi"), gprChannel("al"), instructionCountChannel]
  );

  const backEdge = backEdgeIndex(loop.body);
  const iterationWrites = stateWrites(loop.body.actions.slice(0, backEdge + 1));

  deepStrictEqual(iterationWrites, []);
  strictEqual(writeFor(faultArmWrites(loop.body), gprChannel("al")).op.value, loop.carried[2]!.loopInput);
});

test("repe cmps carries the lazy flag cells and updates them per unit", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(repeCmpsSemantic(8), [siOperand(), diOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);

  deepStrictEqual(
    loop.carried.map((cell) => cell.channel),
    [
      gprChannel("ecx"),
      gprChannel("esi"),
      gprChannel("edi"),
      instructionCountChannel,
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

// A loop body may only write channels the loop carries; the write sites assert
// at the point of the write, not by scanning pending state afterward.
test("a loop body writing an uncarried register asserts at the write", () => {
  const builder = createIrBlockBuilder();

  throws(
    () =>
      builder.addInstruction(
        (s) => {
          s.loop({
            stateRegs: ["ecx"],
            enter: s.const32(1),
            body: (b) => {
              b.set(b.reg("eax"), b.const32(0));
              return b.const32(0);
            }
          });
        },
        [],
        loc(repEip, repNextEip)
      ),
    /uncarried state channel/
  );
});

test("a loop body writing status flags it does not carry asserts", () => {
  const builder = createIrBlockBuilder();

  throws(
    () =>
      builder.addInstruction(
        (s) => {
          s.loop({
            stateRegs: ["ecx"],
            enter: s.const32(1),
            body: (b) => {
              b.writeStatusFlagsSource(
                subFlagSource({ width: 32, left: b.const32(0), right: b.const32(0), result: b.const32(0) })
              );
              return b.const32(0);
            }
          });
        },
        [],
        loc(repEip, repNextEip)
      ),
    /does not carry them/
  );
});
