import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import { immBinding, memBinding, regBinding, staticMemSegment } from "#core/instruction/bindings.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { Action, IfAction, LoopAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
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
import { validateIrBlock } from "#ir/validate.js";
import {
  stateWrite,
  stateWriteValue,
  isStateRead,
  isStateWrite,
  readsStateChannel,
  writesStateChannel,
  type StateReadAction,
  type StateWriteAction
} from "./state-actions.js";

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
  const builder = createLegacyInstructionBlock();

  builder.add(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
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
      case "call":
      case "returnCall":
      case "loopContinue":
      case "finish":
      case "return":
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
  return actions.filter(isStateWrite);
}

function faultArmWrites(body: Body): StateWriteAction[] {
  const guardArm = body.actions.find(
    (action): action is IfAction => action.kind === "if" && action.thenBody.actions[0]?.kind !== "loopContinue"
  );

  ok(guardArm !== undefined, "loop body has a guard fault arm");
  return stateWrites(guardArm.thenBody.actions);
}

function writeFor(
  block: IrBlock,
  writes: readonly StateWriteAction[],
  channel: InstructionStateChannel
): StateWriteAction {
  const write = writes.find((action) =>
    writesStateChannel(block.values, action, channel)
  );

  ok(write !== undefined, `state write for ${channel.kind} exists`);
  return write;
}

function readFor(
  block: IrBlock,
  actions: readonly Action[],
  channel: InstructionStateChannel
): StateReadAction | undefined {
  return actions.find((action): action is StateReadAction =>
    readsStateChannel(block.values, action, channel)
  );
}

function carriedCellFor(
  block: IrBlock,
  loop: LoopAction,
  channel: InstructionStateChannel
): LoopAction["carried"][number] | undefined {
  const backEdge = backEdgeIndex(loop.body);
  const commits = stateWrites(loop.body.actions.slice(backEdge + 1));
  const index = commits.findIndex((write) =>
    writesStateChannel(block.values, write, channel)
  );

  return index < 0 ? undefined : loop.carried[index];
}

function assertCarriedChannels(
  block: IrBlock,
  loop: LoopAction,
  channels: readonly InstructionStateChannel[]
): void {
  strictEqual(loop.carried.length, channels.length, "carried channel count");
  const backEdge = backEdgeIndex(loop.body);
  const updates = backEdgeUpdates(loop.body);
  const commits = stateWrites(loop.body.actions.slice(backEdge + 1));

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

function stateTraffic(actions: readonly Action[]): Action[] {
  return actions.filter((action) =>
    isStateRead(action) || isStateWrite(action)
  );
}

function preLoopActions(block: IrBlock, loop: LoopAction): readonly Action[] {
  const actions = actionsBeforeLoop(block.body.actions, loop);

  ok(actions !== undefined, "loop belongs to the block");
  return actions;
}

function actionsBeforeLoop(
  actions: readonly Action[],
  target: LoopAction
): readonly Action[] | undefined {
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;

    if (action === target) {
      return actions.slice(0, index);
    }

    const nestedBodies: readonly Body[] = action.kind === "if"
      ? [action.thenBody, ...(action.elseBody === undefined ? [] : [action.elseBody])]
      : action.kind === "switch"
        ? [...action.cases.map((entry) => entry.body), action.defaultBody]
        : action.kind === "loop"
          ? [action.body]
          : [];

    for (const body of nestedBodies) {
      const nested = actionsBeforeLoop(body.actions, target);

      if (nested !== undefined) {
        return [...actions.slice(0, index), ...nested];
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
    const read = readFor(block, preLoopActions(block, loop), channel);

    ok(read !== undefined && read.output === cell.seed, `${channel.kind} seed comes from a pre-loop read`);
  }
});

test("the iteration path has no state ops; carried commits sit in the exit tail", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const backEdge = backEdgeIndex(loop.body);
  const iterationPath = loop.body.actions.slice(0, backEdge + 1);

  // Carried state lives in cells: nothing on the per-iteration path reads
  // or writes state directly (fault arms are nested, not on the path).
  deepStrictEqual(stateTraffic(iterationPath), []);

  // The exit tail commits each carried channel once, and the back edge
  // carries exactly the values the exit tail commits.
  const updates = backEdgeUpdates(loop.body);
  const tailWrites = stateWrites(loop.body.actions.slice(backEdge + 1));

  const channels = [gprChannel("esi"), gprChannel("edi"), gprChannel("ecx")];

  strictEqual(tailWrites.length, channels.length);
  for (let index = 0; index < channels.length; index += 1) {
    ok(writesStateChannel(block.values, tailWrites[index]!, channels[index]!));
  }
  deepStrictEqual(tailWrites.map(stateWriteValue), updates);
});

test("a mid-body fault restores iteration-start carried values and the rep eip", () => {
  const block = repMovsBlock();
  const loop = findLoop(block);
  const writes = faultArmWrites(loop.body);

  const channels = [gprChannel("esi"), gprChannel("edi"), gprChannel("ecx")];

  for (let index = 0; index < loop.carried.length; index += 1) {
    strictEqual(
      stateWriteValue(writeFor(block, writes, channels[index]!)),
      loop.carried[index]!.loopInput
    );
  }

  const eipWrite = writes.find((action) =>
    writesStateChannel(block.values, action, coreStateFields.eip)
  );

  ok(eipWrite !== undefined, "fault arm flushes eip");
  strictEqual(block.values.constValue(stateWriteValue(eipWrite)), repEip);
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
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("ecx"), regBinding("ebx")], loc(repEip - 2, repEip));
  builder.add(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);
  const enterIf = loopEnterIf(block);

  ok(enterIf.elseBody !== undefined, "the loop entry if has a zero-trip arm");

  const elseWrites = stateWrites(enterIf.elseBody.actions);
  const ecxCell = carriedCellFor(block, loop, gprChannel("ecx"));

  ok(ecxCell !== undefined, "loop carries ecx");
  strictEqual(
    stateWriteValue(writeFor(block, elseWrites, gprChannel("ecx"))),
    ecxCell.seed
  );

  // Memory-backed carried channels already read back correctly when the loop
  // never runs; only dirty-at-entry channels commit here.
  for (const reg of ["esi", "edi"] as const) {
    ok(
      elseWrites.every((write) =>
        !writesStateChannel(block.values, write, gprChannel(reg))
      ),
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
  const exitEcxRead = readFor(block, rootAfterEntry, gprChannel("ecx"));
  const countRead = readFor(block, rootAfterEntry, instructionCountField);
  const finish = block.body.actions.at(-1);

  deepStrictEqual(stateTraffic(enteredAfterLoop), []);
  ok(exitEcxRead !== undefined, "the count settle re-reads ecx after the loop");
  ok(countRead !== undefined, "the count folds from a post-entry read");
  ok(finish?.kind === "finish" && finish.finish.kind === "dispatch", "fallthrough dispatches");
  strictEqual(v.constValue(finish.finish.targetEip), repNextEip);

  const ecxSeed = carriedCellFor(block, loop, gprChannel("ecx"))!.seed;
  const delta = v.binary("sub", v.binary("sub", ecxSeed, exitEcxRead.output), enterIf.condition);

  deepStrictEqual(
    stateWrites(rootAfterEntry).filter((action) =>
      writesStateChannel(v, action, instructionCountField)
    ),
    [stateWrite(
      v,
      instructionCountField,
      v.binary("add", v.binary("add", countRead.output, delta), v.const(1))
    )]
  );
});

test("instructions after the loop rebase the count from state", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(repMovsSemantic(32), [siOperand(), diOperand()], loc(repEip, repNextEip));
  builder.add(movSemantic(32), [regBinding("ebx"), immBinding(7)], loc(repNextEip, repNextEip + 5));

  const block = builder.finish();
  const loopIndex = block.body.actions.findIndex(
    (action) => action.kind === "if" && action.thenBody.actions.some((nested) => nested.kind === "loop")
  );

  ok(loopIndex >= 0, "loop entry if exists");

  const countReads = block.body.actions
    .slice(loopIndex + 1)
    .filter((action) => readsStateChannel(block.values, action, instructionCountField));

  strictEqual(countReads.length, 1, "the post-loop count folds from a fresh read");
});

test("rep lods carries its accumulator instead of writing it through each iteration", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(repLodsSemantic(8), [siOperand()], loc(repEip, repNextEip));

  const block = builder.finish();
  const loop = findLoop(block);

  assertCarriedChannels(
    block,
    loop,
    [gprChannel("al"), gprChannel("esi"), gprChannel("ecx")]
  );

  const backEdge = backEdgeIndex(loop.body);
  const iterationWrites = stateWrites(loop.body.actions.slice(0, backEdge + 1));

  deepStrictEqual(iterationWrites, []);
  strictEqual(
    stateWriteValue(writeFor(block, faultArmWrites(loop.body), gprChannel("al"))),
    loop.carried[0]!.loopInput
  );
});

test("repe cmps carries the lazy flag cells and updates them per unit", () => {
  const builder = createLegacyInstructionBlock();

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

  // A first-unit fault must report the pre-rep flags: the lazy cells seed
  // from state and restore through their loop inputs like any carried cell.
  const writes = faultArmWrites(loop.body);

  for (let index = 0; index < loop.carried.length; index += 1) {
    strictEqual(
      stateWriteValue(writeFor(block, writes, channels[index]!)),
      loop.carried[index]!.loopInput
    );
  }

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
    const builder = createLegacyInstructionBlock();

    builder.add(entry.template, entry.bindings, loc(repEip, repNextEip));

    const block = builder.finish();

    assertCarriedChannels(block, findLoop(block), entry.channels);
  }
});

test("loop analysis preserves captured outer value identities", () => {
  const builder = createLegacyInstructionBlock();

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
  doesNotThrow(() => validateIrBlock(block));
});

test("independent loop analysis and final bodies can access an enclosing-arm cell", () => {
  const builder = createLegacyInstructionBlock();

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

    validateIrBlock(builder.finish());
  });
});

test("loop analysis does not force its control shape onto final construction", () => {
  const builder = createLegacyInstructionBlock();

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
  const constantStructuredArm = loop.body.actions.find(
    (action): action is IfAction => (
      action.kind === "if" && block.values.constValue(action.condition) === 1
    )
  );
  const finalNestedArm = loop.body.actions.find(
    (action): action is IfAction => (
      action.kind === "if" && action.thenBody.actions[0]?.kind !== "loopContinue"
    )
  );

  strictEqual(constantStructuredArm, undefined, "final loop does not replay discovery control");
  ok(finalNestedArm !== undefined, "selected final arm still builds its nested control");
  doesNotThrow(() => validateIrBlock(block));
});

test("loop analysis conservatively includes writes from an unknown scratch arm", () => {
  const builder = createLegacyInstructionBlock();

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
    loop.body.actions.filter((action) => action.kind === "if").length,
    1,
    "only the loop back edge remains in final construction"
  );
  doesNotThrow(() => validateIrBlock(block));
});

test("a loop body register write is derived as a carried channel", () => {
  const builder = createLegacyInstructionBlock();

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
  const builder = createLegacyInstructionBlock();

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
  const builder = createLegacyInstructionBlock();

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
  const builder = createLegacyInstructionBlock();

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
  const actions = block.body.actions;
  const loopIndex = actions.findIndex((action) => action === loop);
  const readIndex = actions.findIndex(
    (action) => action.kind === "op" && action.op.kind === "cell.read"
  );

  ok(loopIndex >= 0, "the block holds the var-driven loop");
  ok(readIndex > loopIndex, "the post-loop cell read sits after the loop");
});
