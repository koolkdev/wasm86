import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  createIrBlockBuilder,
  externalInstructionLocation,
  staticInstructionLocation as loc
} from "#ir/builder.js";
import {
  dynamicMemSegment,
  immBinding,
  immExternalBinding,
  memBinding,
  memDynamicBinding,
  memStaticBinding,
  regBinding,
  regDynamicBinding,
  segmentBinding,
  staticMemSegment
} from "#ir/operands.js";
import {
  eipChannel,
  gprChannel,
  instructionCountChannel,
  lazyFlagsKindChannel,
  segmentBaseChannel,
  type SegmentDynamicSlot
} from "#ir/slots.js";
import type {
  Action,
  Finish,
  IfAction,
  StateWriteAction,
  SwitchAction
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { ValueNode, ValueTable } from "#compiler/ir/values/table.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  invalidOpcode,
  PageFaultErrorCode,
  pageFault,
  type CpuException
} from "#core/exceptions.js";
import type { X86Flag, X86StatusFlag } from "#core/flags/definitions.js";
import type { SemanticOps, SemanticTemplate } from "#core/semantics/builder.js";
import type { ValueInput } from "#core/semantics/refs.js";
import type {
  MemoryAccess,
  MemoryDataAccessIntent
} from "#memory/access.js";
import { x86EflagsBitOffset, x86Flags, x86StatusFlags } from "#core/flags/definitions.js";
import { aluSemantic, unaryAluSemantic } from "#core/semantics/alu.js";
import { cmpSemantic } from "#core/semantics/cmp.js";
import { callSemantic, jccSemantic, jecxzSemantic, jmpSemantic, loopSemantic } from "#core/semantics/control.js";
import { leaSemantic } from "#core/semantics/lea.js";
import { memoryAccessException } from "#core/semantics/memory.js";
import { int3Semantic, intoSemantic, intSemantic } from "#core/semantics/misc.js";
import { movSemantic, movsxSemantic, movToSregSemantic, movzxSemantic } from "#core/semantics/mov.js";
import { setccSemantic } from "#core/semantics/setcc.js";
import { shiftSemantic } from "#core/semantics/shift.js";
import { popfdSemantic, popfSemantic, popSemantic, pushfdSemantic, pushfSemantic } from "#core/semantics/stack.js";
import { testSemantic as testInstructionSemantic } from "#core/semantics/test.js";
import { xchgSemantic } from "#core/semantics/xchg.js";
import { defaultSegmentForBase, segmentRegisterIndex } from "#core/segments.js";
import type { EffectiveAddress, OperandWidth } from "#core/types.js";
import {
  buildException,
  buildSegmentLoad,
  buildTrap
} from "#cpu/exit.js";
import { assertLazyRecord } from "./lazy-flags.js";
import {
  isMemoryRead,
  isMemoryWrite,
  isStateRead,
  isStateWrite,
  isStatusFlagCall,
  memoryRead,
  memoryWrite,
  resolvedStatusFlag,
  stateRead,
  stateWrite
} from "#ir/tests/storage-op-helpers.js";
import type {
  MemoryReadAction,
  MemoryWriteAction,
  StateReadAction,
  StatusFlagCallAction
} from "#ir/tests/storage-op-helpers.js";

function mem(
  address: Readonly<{
    segment?: EffectiveAddress["segment"];
    base?: EffectiveAddress["base"];
    index?: EffectiveAddress["index"];
    scale: EffectiveAddress["scale"];
    disp: number;
  }>
): ReturnType<typeof memBinding> {
  const segment = address.segment ?? defaultSegmentForBase(address.base);

  return memBinding({
    base: address.base,
    index: address.index,
    scale: address.scale,
    disp: address.disp
  }, staticMemSegment(segment));
}

function resolveDsMemory<TIntent extends MemoryDataAccessIntent>(
  s: SemanticOps,
  address: ValueInput,
  byteLength: ValueInput,
  intent: TIntent
): MemoryAccess<TIntent> {
  const access = s.memoryResolve(s.mem("ds", address), byteLength, intent);

  s.if(
    access.invalid,
    (failure) => failure.cpuException(memoryAccessException(access)),
    "unlikely"
  );
  return access;
}

function writeDsMemory(
  s: SemanticOps,
  v: ValueBuilder,
  address: ValueInput,
  value: ValueInput,
  width: OperandWidth
): void {
  const access = resolveDsMemory(s, address, v.const(width / 8), "write");

  s.memoryWrite(access, v.const(0), value, width);
}

// Every instruction advances the count channel; the dedicated tests at the
// end cover that bookkeeping, the shape tests assert around it.
function isInstructionCountAction(action: Action): boolean {
  return (isStateRead(action) || isStateWrite(action)) && action.op.slot.kind === "instructionCount";
}

function entryActions(block: IrBlock): readonly Action[] {
  return rawEntryActions(block).filter((action) => !isInstructionCountAction(action));
}

function rawEntryActions(block: IrBlock): readonly Action[] {
  return block.body.actions;
}

type TerminatingBodyView = Readonly<{
  actions: readonly Action[];
  flushes: readonly StateWriteAction[];
  terminator: Finish;
}>;

function nestedActionBodies(block: IrBlock): readonly Body[] {
  const bodies: Body[] = [];

  function collect(body: Body): void {
    for (const action of body.actions) {
      switch (action.kind) {
        case "if":
          bodies.push(action.thenBody);
          collect(action.thenBody);

          if (action.elseBody !== undefined) {
            bodies.push(action.elseBody);
            collect(action.elseBody);
          }
          break;
        case "op":
        case "finish":
          break;
      }
    }
  }

  collect(block.body);
  return bodies;
}

function nestedBodyView(block: IrBlock, index: number): TerminatingBodyView {
  const body = nestedActionBodies(block)[index - 1];

  ok(body !== undefined, `nested body ${index} exists`);

  const terminator = body.actions[body.actions.length - 1];

  ok(terminator !== undefined && terminator.kind === "finish", `nested body ${index} ends with a finish`);
  return {
    actions: body.actions,
    flushes: body.actions.slice(0, -1).filter(
      (action): action is StateWriteAction => isStateWrite(action)
    ),
    terminator: terminator.finish
  };
}

function nestedBodyFlushes(block: IrBlock, index: number): StateWriteAction[] {
  return nestedBodyView(block, index).flushes.filter((flush) => !isInstructionCountAction(flush));
}

function nestedBodyWriteFlushes(block: IrBlock, index: number): StateWriteAction[] {
  return nestedBodyFlushes(block, index).filter(
    (flush): flush is StateWriteAction => isStateWrite(flush)
  );
}

function memoryGuard(
  block: IrBlock,
  faultBodyIndex: number,
  _address: ValueId,
  _byteLength: number,
  _access: MemoryDataAccessIntent
): readonly [IfAction] {
  const thenBody = nestedActionBodies(block)[faultBodyIndex - 1];

  ok(thenBody !== undefined, `fault body ${faultBodyIndex} exists`);

  const faultIf = entryActions(block).find(
    (action): action is IfAction => action.kind === "if" && action.thenBody === thenBody
  );

  ok(faultIf !== undefined, `fault if ${faultBodyIndex} exists`);

  return [{ kind: "if", condition: faultIf.condition, hint: "unlikely", thenBody }];
}

function finishDispatch(targetEip: ValueId): Action {
  return { kind: "finish", finish: { kind: "dispatch", targetEip } };
}

function finishTrap(values: ValueTable, vector: ValueId): Action {
  return { kind: "finish", finish: trapExit(values, vector) };
}

function trapExit(values: ValueTable, vector: ValueId): Finish {
  return { kind: "exit", result: buildTrap(values, vector) };
}

function finishSegmentLoad(
  values: ValueTable,
  segment: ValueId,
  selector: ValueId
): Action {
  return {
    kind: "finish",
    finish: {
      kind: "exit",
      result: buildSegmentLoad(values, segment, selector)
    }
  };
}

function exceptionExit(
  values: ValueTable,
  exception: CpuException<ValueId>
): Finish {
  return { kind: "exit", result: buildException(values, exception) };
}

function finishException(
  values: ValueTable,
  exception: CpuException<ValueId>
): Action {
  return { kind: "finish", finish: exceptionExit(values, exception) };
}

function pageFaultStop(
  values: ValueTable,
  access: MemoryDataAccessIntent,
  payload: ValueId
): Finish {
  const errorCode = access === "write" ? PageFaultErrorCode.WRITE : 0;

  return exceptionExit(values, pageFault(payload, errorCode));
}

function stateWrites(block: IrBlock): StateWriteAction[] {
  return entryActions(block).filter(
    (action): action is StateWriteAction => isStateWrite(action)
  );
}

function ifAction(block: IrBlock): IfAction {
  const action = entryActions(block).find((entry): entry is IfAction => entry.kind === "if");

  ok(action !== undefined, "expected if action");
  return action;
}

function switchAction(block: IrBlock): SwitchAction {
  const action = entryActions(block).find((entry): entry is SwitchAction => entry.kind === "switch");

  ok(action !== undefined, "expected switch action");
  return action;
}

function nodeKinds(block: IrBlock): ValueNode["kind"][] {
  const kinds: ValueNode["kind"][] = [];

  for (let rawId = 0; rawId < block.values.size(); rawId += 1) {
    kinds.push(block.values.node(valueId(rawId)).kind);
  }

  return kinds;
}

function writtenFlags(block: IrBlock): X86Flag[] {
  return flagWriteEntries(block).map((write) => write.flag);
}

function flagWriteEntries(block: IrBlock): ReadonlyArray<Readonly<{ flag: X86Flag; value: ValueId }>> {
  return stateWrites(block).flatMap((write) =>
    write.op.slot.kind === "flag" ? [{ flag: write.op.slot.flag, value: write.op.value }] : []
  );
}

function flagWriteValue(block: IrBlock, flag: X86StatusFlag): ValueId {
  const writes = flagWriteEntries(block).filter((write) => write.flag === flag);

  strictEqual(writes.length, 1, `expected exactly one ${flag} write`);
  return writes[0]!.value;
}

function statusFlagCallAction(block: IrBlock, flag: X86StatusFlag): StatusFlagCallAction {
  const action = entryActions(block).find(
    (action): action is StatusFlagCallAction =>
      isStatusFlagCall(action) && resolvedStatusFlag(action) === flag
  );

  ok(action !== undefined, `expected ${flag} resolver call`);
  return action;
}

function assertResolvedStatusFlag(block: IrBlock, id: ValueId, flag: X86StatusFlag): void {
  strictEqual(statusFlagCallAction(block, flag).outputs[0], id);
  deepStrictEqual(block.values.node(id), { kind: "actionOutput", type: "i32" });
}

test("mov r32, imm32 flushes the register write and dispatches at the next eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const block = builder.finish();
  const v = block.values;

  strictEqual(nestedActionBodies(block).length, 0);

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x12345678)),
    finishDispatch(v.const(0x401005))
  ]);
  deepStrictEqual(v.node(v.const(0x12345678)), { kind: "const", value: 0x12345678 });
  // The instruction-start eip, immediate, next eip, and count advance.
  strictEqual(v.size(), 6);
});

test("pending writes overwrite per channel and consts deduplicate across instructions", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(7)], loc(0x1005, 0x100a));
  builder.addInstruction(mov, [regBinding("eax"), immBinding(9)], loc(0x100a, 0x100f));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), block.values.const(9)),
    stateWrite(gprChannel("ecx"), block.values.const(7)),
    finishDispatch(block.values.const(0x100f))
  ]);

  // 7, 9, the four eip constants, and the count read with its three folded
  // advances — both movs of 7 share one const.
  strictEqual(block.values.size(), 13);
});

test("mov r32, r32 records one state.read op and forwards its leaf", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), 1),
    finishDispatch(v.const(0x1002))
  ]);
  deepStrictEqual(v.node(valueId(1)), { kind: "actionOutput", type: "i32" });
  // The instruction-start eip, read leaf, next eip, and count advance.
  strictEqual(v.size(), 6);
});

test("repeated get of an unwritten channel returns the same leaf across instructions", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), 1),
    stateWrite(gprChannel("ecx"), 1),
    finishDispatch(block.values.const(0x1004))
  ]);
});

test("add eax, imm32 commits a lazy add record and writes the register", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const writes = stateWrites(block);

  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(writes.find((write) => write.op.slot === gprChannel("eax"))?.op.value, sum);
});

test("two adds in one block flush one lazy add record, second instruction wins", () => {
  const builder = createIrBlockBuilder();
  const add = aluSemantic("add", 32);

  builder.addInstruction(add, [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(add, [regBinding("eax"), immBinding(7)], loc(0x1003, 0x1006));

  const block = builder.finish();
  const actions = entryActions(block);
  const writes = stateWrites(block);
  const v = block.values;

  // One read feeds both adds; the final add source is the only lazy flag image
  // flushed, plus eax. Dispatch owns the target eip commit.
  strictEqual(actions.filter((action) => isStateRead(action)).length, 1);
  strictEqual(writes.length, 4);
  strictEqual(new Set(writes.map((write) => write.op.slot)).size, 4);
  strictEqual(writes.filter((write) => write.op.slot.kind === "flag").length, 0);

  const eax = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const sum1 = v.binary("add", eax, v.const(5));
  const sum2 = v.binary("add", sum1, v.const(7));

  strictEqual(writes.find((write) => write.op.slot === gprChannel("eax"))?.op.value, sum2);
  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: sum1, right: v.const(7) });
});

test("inc flushes a full explicit image with CF preserved through a resolver call", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(unaryAluSemantic("inc", 32), [regBinding("eax")], loc(0x1000, 0x1001));

  const block = builder.finish();

  deepStrictEqual(
    entryActions(block).flatMap((action) =>
      isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
    ),
    x86StatusFlags
  );
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  assertResolvedStatusFlag(block, flagWriteValue(block, "CF"), "CF");
  strictEqual(stateWrites(block).find((write) => write.op.slot === lazyFlagsKindChannel)?.op.value, block.values.const(0));
});

test("cmp commits a lazy sub record but no register or explicit flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const writes = stateWrites(block);
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );

  assertLazyRecord(writes, block.values, { kind: "SUB", width: 32, left: reads[0]!.output, right: reads[1]!.output });
  strictEqual(writes.some((write) => write.op.slot.kind === "gpr"), false);
  strictEqual(writes.filter((write) => write.op.slot === eipChannel).length, 0);
  deepStrictEqual(entryActions(block).at(-1), finishDispatch(block.values.const(0x1002)));
});

test("zero-count shift writes neither the destination nor flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(shiftSemantic("shr", 32, "imm8"), [regBinding("eax"), immBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const writes = stateWrites(block);

  deepStrictEqual(writes, []);
});

// A template writing only ZF; omitted status flags are preserved by resolving
// their live input backing into the full explicit image.
const directZfTemplate: SemanticTemplate = (s, v) => {
  s.writeFlag("ZF", v.const(1));
};

test("writeFlag flushes a full explicit image with omitted flags preserved through resolver calls", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(directZfTemplate, [], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  strictEqual(flagWriteValue(block, "ZF"), block.values.const(1));

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    assertResolvedStatusFlag(block, flagWriteValue(block, flag), flag);
  }
  deepStrictEqual(
    entryActions(block).flatMap((action) =>
      isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
    ),
    x86StatusFlags
  );

  strictEqual(stateWrites(block).find((write) => write.op.slot === lazyFlagsKindChannel)?.op.value, block.values.const(0));
});

test("an omitted direct flag write preserves the previous instruction's pending flag", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(directZfTemplate, [], loc(0x1003, 0x1005));

  const block = builder.finish();

  // The second instruction does not touch AF, so the add's AF expression
  // survives and flushes.
  const v = block.values;
  const a = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const b = v.const(5);
  const result = v.binary("add", a, b);
  const carryChain = v.binary("xor", v.binary("xor", a, b), result);
  const af = v.binary("and", v.binary("shr_u", carryChain, v.const(4)), v.const(1));

  strictEqual(flagWriteValue(block, "AF"), af);

  // The second instruction's constant ZF write wins over the add's expression.
  strictEqual(flagWriteValue(block, "ZF"), v.const(1));
});

test("xchg eax, ebx swaps pendings through two reads with no temporaries", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("eax")),
    stateRead(2, gprChannel("ebx")),
    stateWrite(gprChannel("ebx"), 1),
    stateWrite(gprChannel("eax"), 2),
    finishDispatch(block.values.const(0x1002))
  ]);

  // The instruction-start eip, two read leaves, next eip, and count advance — no
  // temporaries were created.
  strictEqual(block.values.size(), 7);
});

test("mov r8, r8 reads and writes byte channels with no bit algebra", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("ah")),
    stateWrite(gprChannel("bl"), 1),
    finishDispatch(block.values.const(0x1002))
  ]);
  // The instruction-start eip, read leaf, next eip, and count advance — no
  // masks or shifts were created.
  strictEqual(block.values.size(), 6);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("al"), v.const(0x12)),
    stateRead(6, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), 6),
    finishDispatch(v.const(0x1004))
  ]);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("al")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x12345678)),
    stateRead(6, gprChannel("al")),
    stateWrite(gprChannel("bl"), 6),
    finishDispatch(v.const(0x1007))
  ]);
});

test("write al then write eax drops the byte pending with no flush", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1002, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x12345678)),
    finishDispatch(v.const(0x1007))
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const actions = entryActions(block);

  strictEqual(isStateWrite(actions[0]!), true);
  deepStrictEqual(actions[1], stateRead(6, gprChannel("ah")));
});

test("ax and al pendings mix without touching flag pendings", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(8), [regBinding("ah"), immBinding(0x12)], loc(0x1002, 0x1004));
  builder.addInstruction(movSemantic(16), [regBinding("cx"), regBinding("ax")], loc(0x1004, 0x1007));

  const block = builder.finish();
  const actions = entryActions(block);
  const indexOf = (predicate: (action: (typeof actions)[number]) => boolean) =>
    actions.findIndex(predicate);

  // al and ah are disjoint, so both stay pending until the ax read flushes
  // them; the lazy flag record rides through it all and flushes once at the end.
  const alFlush = indexOf((a) => isStateWrite(a) && a.op.slot === gprChannel("al"));
  const ahFlush = indexOf((a) => isStateWrite(a) && a.op.slot === gprChannel("ah"));
  const axRead = indexOf((a) => isStateRead(a) && a.op.slot === gprChannel("ax"));
  const lazyKindFlush = indexOf((a) => isStateWrite(a) && a.op.slot === lazyFlagsKindChannel);

  ok(alFlush !== -1 && ahFlush !== -1 && axRead !== -1, "expected al/ah flushes and an ax read");
  ok(alFlush < axRead && ahFlush < axRead, "the ax read must flush al and ah first");
  ok(axRead < lazyKindFlush, "lazy flag flush stays at the end of the block");
  deepStrictEqual([...writtenFlags(block)], []);

  // The flushed al carries the add's truncated result.
  const v = block.values;
  const reads = actions.filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const sum = v.truncate(8, v.binary("add", reads[0]!.output, reads[1]!.output));

  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value, sum);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 8, left: reads[0]!.output, right: reads[1]!.output });
});

test("movzx r32, r8 forwards the unsigned byte read unmasked", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("al")),
    stateWrite(gprChannel("ebx"), 1),
    finishDispatch(block.values.const(0x1003))
  ]);
  strictEqual(block.values.size(), 6);
});

test("movsx r32, r8 marks the read for a sign-extending load", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    stateRead(1, gprChannel("al"), true),
    stateWrite(gprChannel("ebx"), 1),
    finishDispatch(block.values.const(0x1003))
  ]);
  strictEqual(block.values.size(), 6);
});

test("narrow signed compares sign-extend both operands", () => {
  const cmp8: SemanticTemplate = (s, v) => {
    s.set(s.operand(0), v.compare(8, "lt_s", s.get(s.operand(0), 32), s.get(s.operand(1), 32)), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmp8, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const compare = v.compare(32,
    "lt_s",
    v.extend(8, reads[0]!.output, true),
    v.extend(8, reads[1]!.output, true)
  );

  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, compare);
});

test("an 8-bit unsigned compare of covered operands creates no truncations", () => {
  const cmpAl: SemanticTemplate = (s, v) => {
    s.set(s.operand(0), v.compare(8, "lt_u", s.get(s.operand(0), 8), s.get(s.operand(1), 8)), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpAl, [regBinding("al"), immBinding(5)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  // The al read fits unsigned 8 and the constant fits by value, so the
  // compare uses the raw operands.
  const al = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("al")
  )!.output;

  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    v.compare(32, "lt_u", al, v.const(5))
  );
  ok(!nodeKinds(block).includes("truncate"), "no truncations expected");
});

test("an 8-bit equality on an unproven value keeps its mask", () => {
  const cmpSum: SemanticTemplate = (s, v) => {
    const sum = v.binary("add", s.get(s.operand(0), 8), s.get(s.operand(1), 8));

    s.set(s.operand(0), v.compare(8, "eq", sum, v.const(0)), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSum, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const sum = v.binary("add", reads[0]!.output, reads[1]!.output);

  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    v.compare(32, "eq", v.truncate(8, sum), v.const(0))
  );
});

test("a signed byte get feeds a signed compare with no extra extends", () => {
  const cmpSigned: SemanticTemplate = (s, v) => {
    const a = s.get(s.operand(0), 8, { signed: true });
    const b = s.get(s.operand(1), 8, { signed: true });

    s.set(s.operand(0), v.compare(8, "lt_s", a, b), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSigned, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const actions = entryActions(block);
  const reads = actions.filter(
    (action): action is StateReadAction => isStateRead(action)
  );

  deepStrictEqual(actions[0], stateRead(reads[0]!.output, gprChannel("al"), true));
  deepStrictEqual(actions[1], stateRead(reads[1]!.output, gprChannel("bl"), true));
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    block.values.compare(32, "lt_s", reads[0]!.output, reads[1]!.output)
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("value methods build through the builder", () => {
  const abs: SemanticTemplate = (s, v) => {
    const value = s.get(s.operand(0), 32);
    const zero = v.const(0);
    const negative = v.compare(32, "lt_s", value, zero);

    s.set(s.operand(0), v.select(negative, v.binary("sub", zero, value), value), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(abs, [regBinding("eax")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!;
  const zero = block.values.const(0);
  const compare = block.values.compare(32, "lt_s", read.output, zero);
  const negated = block.values.binary("sub", zero, read.output);
  const selected = block.values.select(compare, negated, read.output);

  deepStrictEqual(entryActions(block), [
    stateRead(read.output, gprChannel("eax")),
    stateWrite(gprChannel("eax"), selected),
    finishDispatch(block.values.const(0x1003))
  ]);
  deepStrictEqual(block.values.node(compare), { kind: "compare", type: "i32", operator: "lt_s", a: read.output, b: zero });
  deepStrictEqual(block.values.node(negated), { kind: "binary", type: "i32", operator: "sub", a: zero, b: read.output });
  deepStrictEqual(block.values.node(selected), { kind: "select", condition: compare, whenTrue: negated, whenFalse: read.output });
});

test("jmp dispatches at the target", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(entryActions(block), [
    finishDispatch(block.values.const(0x2000))
  ]);
});

test("16-bit jmp truncates the target before dispatch", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jmpSemantic(16), [immBinding(0x1234_2000)], loc(0x1000, 0x1004));

  const block = builder.finish();
  const target = block.values.const(0x2000);

  deepStrictEqual(entryActions(block), [
    finishDispatch(target)
  ]);
});

test("16-bit call pushes a word return address and dispatches to a word target", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(callSemantic(16), [regBinding("ax")], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const ax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ax")
  )!.output;
  const nextEsp = v.binary("sub", esp, v.const(2));

  deepStrictEqual(entryActions(block), [
    stateRead(ax, gprChannel("ax")),
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, nextEsp, 2, "write"),
    memoryWrite(nextEsp, v.const(0x1004), 16),
    stateWrite(gprChannel("esp"), nextEsp),
    finishDispatch(ax)
  ]);
});

test("a jump flushes earlier pendings and dispatches at the target eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x77)),
    finishDispatch(v.const(0x2000))
  ]);
});

test("a block ended by a jump rejects further instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1005, 0x100a)),
    /after a block terminator/
  );
});

test("a root CPU exception exits at the faulting instruction", () => {
  const exception = invalidOpcode();
  const fault: SemanticTemplate = (s) => {
    s.cpuException(exception);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(fault, [], loc(0x1005, 0x1006));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x77)),
    stateWrite(eipChannel, v.const(0x1005)),
    finishException(v, exception)
  ]);
  strictEqual(stateWrites(block).some((write) => write.op.slot === instructionCountChannel), false);
});

test("a terminal finish stops the remaining semantic body", () => {
  const trapThenSet: SemanticTemplate = (s, v) => {
    s.hostTrap(v.const(3));
    writeDsMemory(s, v, v.const(0x2000), v.const(1), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(trapThenSet, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryActions(block).some((action) => isMemoryWrite(action)), false);
  deepStrictEqual(
    entryActions(block).at(-1),
    finishTrap(block.values, block.values.const(3))
  );
});

test("a dispatch stops a later terminator in the same semantic body", () => {
  const jumpThenTrap: SemanticTemplate = (s, v) => {
    s.jump(v.const(0x2000));
    s.hostTrap(v.const(3));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(jumpThenTrap, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  deepStrictEqual(entryActions(block), [finishDispatch(block.values.const(0x2000))]);
});

test("a semantic if body terminates only its taken arm", () => {
  const jumpInIf: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (then) => {
      then.jump(v.const(0x2000));
    });
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(jumpInIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(nestedActionBodies(block).length, 1);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  deepStrictEqual(rawEntryActions(block)[rawEntryActions(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a constant-false semantic if is not emitted or built", () => {
  const skippedIf: SemanticTemplate = (s, v) => {
    s.if(v.const(0), () => {
      throw new Error("constant-false if body should not be built");
    });
    s.set(s.reg("eax"), v.const(7));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(skippedIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(entryActions(block).some((action) => action.kind === "if"), false);
  strictEqual(nestedActionBodies(block).length, 0);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value,
    block.values.const(7)
  );
});

test("a constant-false semantic if builds only its else arm in the containing scope", () => {
  const selectElse: SemanticTemplate = (s, v) => {
    s.ifElse(v.const(0), () => {
      throw new Error("constant-false then body should not be built");
    }, (otherwise) => otherwise.set(otherwise.reg("eax"), v.const(7)));
    s.set(s.reg("ebx"), s.get(s.reg("eax")));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(selectElse, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryActions(block).some((action) => action.kind === "if"), false);
  strictEqual(nestedActionBodies(block).length, 0);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value,
    block.values.const(7)
  );
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    block.values.const(7)
  );
});

test("a dynamic semantic ifElse emits both arms", () => {
  const selectRegister: SemanticTemplate = (s, v) => {
    s.ifElse(s.get(s.reg("eax")), (then) => {
      then.set(then.reg("ebx"), v.const(1));
    }, (otherwise) => otherwise.set(otherwise.reg("ebx"), v.const(2)), "likely");
    s.set(s.reg("ecx"), s.get(s.reg("ebx")));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(selectRegister, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifAction(block);
  const ebxAfterJoin = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  );

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  strictEqual(branch.hint, "likely");
  deepStrictEqual(branch.thenBody.actions, [stateWrite(gprChannel("ebx"), block.values.const(1))]);
  deepStrictEqual(branch.elseBody.actions, [stateWrite(gprChannel("ebx"), block.values.const(2))]);
  ok(ebxAfterJoin !== undefined, "joined ebx is read after the branch");
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ecx"))?.op.value,
    ebxAfterJoin.output
  );
});

test("ifElse arms reconcile sibling writes with dirty parent state", () => {
  const reconcileParent: SemanticTemplate = (s, v) => {
    s.set(s.reg("eax"), v.const(10));
    s.set(s.reg("ebx"), v.const(20));
    s.ifElse(s.get(s.reg("ecx")), (then) => {
      then.set(then.reg("eax"), v.const(1));
    }, (otherwise) => otherwise.set(otherwise.reg("ebx"), v.const(2)));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(reconcileParent, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifAction(block);

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  deepStrictEqual(branch.thenBody.actions, [
    stateWrite(gprChannel("eax"), block.values.const(1)),
    stateWrite(gprChannel("ebx"), block.values.const(20))
  ]);
  deepStrictEqual(branch.elseBody.actions, [
    stateWrite(gprChannel("ebx"), block.values.const(2)),
    stateWrite(gprChannel("eax"), block.values.const(10))
  ]);
});

test("a sibling exception is isolated from a continuing memory-write arm", () => {
  const storeOrFault: SemanticTemplate = (s, v) => {
    const access = s.memoryResolve(s.mem("ds", v.const(0x2000)), v.const(4), "write");

    s.ifElse(s.get(s.reg("eax")), (then) => {
      then.memoryWrite(access, v.const(0), v.const(1), 32);
    }, (otherwise) => otherwise.cpuException(invalidOpcode()));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(storeOrFault, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifAction(block);

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  strictEqual(branch.thenBody.actions.some((action) => isMemoryWrite(action)), true);
  strictEqual(branch.elseBody.actions.some((action) => isMemoryWrite(action)), false);
  deepStrictEqual(
    nestedBodyView(block, 2).terminator,
    exceptionExit(block.values, invalidOpcode())
  );
  strictEqual(entryActions(block).some((action) => isMemoryWrite(action)), false);
  deepStrictEqual(entryActions(block).at(-1), finishDispatch(block.values.const(0x1005)));
});

test("an ifElse with two completing arms completes the root semantic path", () => {
  const trapEitherWay: SemanticTemplate = (s, v) => {
    s.ifElse(
      s.get(s.reg("eax")),
      (then) => then.hostTrap(v.const(1)),
      (otherwise) => otherwise.hostTrap(v.const(2))
    );
    s.set(s.reg("ebx"), v.const(7));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(trapEitherWay, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifAction(block);

  validateIrBlock(block);
  strictEqual(builder.isTerminated(), true);
  ok(branch.elseBody !== undefined, "completing branch has an else body");
  deepStrictEqual(
    branch.thenBody.actions.at(-1),
    finishTrap(block.values, block.values.const(1))
  );
  deepStrictEqual(
    branch.elseBody.actions.at(-1),
    finishTrap(block.values, block.values.const(2))
  );
  strictEqual(
    stateWrites(block).some((write) => write.op.slot === gprChannel("ebx")),
    false
  );
  strictEqual(rawEntryActions(block).at(-1), branch);
});

test("a completing nested ifElse stops only its containing arm", () => {
  const nestedDispatch: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (outer) => {
      outer.ifElse(
        outer.get(outer.reg("ebx")),
        (then) => then.jump(v.const(0x2000)),
        (otherwise) => otherwise.jump(v.const(0x3000))
      );
      writeDsMemory(outer, v, v.const(0x4000), v.const(1), 32);
    });
    s.set(s.reg("ecx"), v.const(9));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(nestedDispatch, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryActions(block).some((action) => isMemoryWrite(action)), false);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ecx"))?.op.value,
    block.values.const(9)
  );
  deepStrictEqual(rawEntryActions(block).at(-1), finishDispatch(block.values.const(0x1005)));
});

test("a constant-true semantic if builds its arm in the containing scope", () => {
  const inlinedIf: SemanticTemplate = (s, v) => {
    const sourceAddress = v.const(0x2000);
    const armAddress = v.const(0x3000);
    const parentAddress = v.const(0x4000);
    const source = resolveDsMemory(s, sourceAddress, v.const(4), "read");
    const arm = resolveDsMemory(s, armAddress, v.const(4), "write");
    const parent = resolveDsMemory(s, parentAddress, v.const(4), "write");

    s.if(v.const(1), (then) => {
      then.set(then.reg("eax"), then.memoryRead(source, v.const(0), 32));
      then.memoryWrite(arm, v.const(0), v.const(1), 32);
    });
    s.memoryWrite(parent, v.const(0), s.get(s.reg("eax")), 32);
    s.set(s.reg("ebx"), s.get(s.reg("eax")));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(inlinedIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const load = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  );
  const stores = entryActions(block).filter(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  );

  validateIrBlock(block);
  ok(load !== undefined, "constant arm memory read exists");
  strictEqual(nestedActionBodies(block).length, 0);
  strictEqual(load.op.inputs[0]!.value, block.values.const(0x2000));
  deepStrictEqual(stores.map((store) => [store.op.inputs[0]!.value, store.op.inputs[1]!.value]), [
    [block.values.const(0x3000), block.values.const(1)],
    [block.values.const(0x4000), load.output]
  ]);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value,
    load.output
  );
  // The arm's write stays a parent pending: the read after the if sees it
  // without a join commit and re-read.
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    load.output
  );
});

test("a constant-true semantic if with a completing arm stops its containing flow", () => {
  const jumpThenStore: SemanticTemplate = (s, v) => {
    s.if(v.const(1), (then) => then.jump(v.const(0x2000)));
    writeDsMemory(s, v, v.const(0x3000), v.const(7), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(jumpThenStore, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(builder.isTerminated(), true);
  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(entryActions(block), [finishDispatch(block.values.const(0x2000))]);
});

test("a constant-true invalid-CS arm stops before building the segment-load tail", () => {
  const builder = createIrBlockBuilder({ segmentMode: "flat32" });

  builder.addInstruction(
    movToSregSemantic(),
    [segmentBinding("cs"), regBinding("ax")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(
    entryActions(block).some(
      (action) => isStateRead(action) && action.op.slot === gprChannel("ax")
    ),
    false
  );
  deepStrictEqual(
    entryActions(block).at(-1),
    finishException(block.values, invalidOpcode())
  );
});

test("a constant-true completing if stops only its containing dynamic arm", () => {
  const nestedJump: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (then) => {
      then.if(v.const(1), (inner) => inner.jump(v.const(0x2000)));
      writeDsMemory(then, v, v.const(0x3000), v.const(7), 32);
    });
    s.set(s.reg("ebx"), v.const(9));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(nestedJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(nestedActionBodies(block).length, 1);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  strictEqual(entryActions(block).some((action) => isMemoryWrite(action)), false);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    block.values.const(9)
  );
  deepStrictEqual(rawEntryActions(block)[rawEntryActions(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a nested semantic if terminator does not terminate the containing arm", () => {
  const nestedJump: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (then) => {
      then.if(then.get(then.reg("ebx")), (inner) => {
        inner.jump(v.const(0x2000));
      });
      then.jump(v.const(0x3000));
    });
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(nestedJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(nestedActionBodies(block).length, 2);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x3000) });
  deepStrictEqual(nestedBodyView(block, 2).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  deepStrictEqual(rawEntryActions(block)[rawEntryActions(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a dynamic if arm cannot leak an operand address into its parent scope", () => {
  const resolveAddressInArm: SemanticTemplate = (s) => {
    const operand = s.operand(0);

    s.if(s.get(s.reg("ecx")), (then) => {
      then.address(operand);
    });
    s.set(s.reg("ebx"), s.address(operand));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    resolveAddressInArm,
    [mem({ base: "eax", scale: 1, disp: 0 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const parentRead = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  );
  const armRead = nestedActionBodies(block)[0]?.actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  );

  validateIrBlock(block);
  ok(parentRead !== undefined, "parent address read exists");
  ok(armRead !== undefined, "arm address read exists");
  ok(parentRead.output !== armRead.output, "parent recomputes the arm-local address");
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    parentRead.output
  );
});

test("a loop-local operand address cannot escape into the parent scope", () => {
  const resolveAddressInLoop: SemanticTemplate = (s) => {
    const operand = s.operand(0);

    s.loop((loop, loopValues) => {
      loop.address(operand);
      loop.set(loop.reg("eax"), loopValues.binary("add", loop.get(loop.reg("eax")), loopValues.const(1)));
      return loopValues.const(0);
    });
    s.set(s.reg("ebx"), s.address(operand));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    resolveAddressInLoop,
    [mem({ base: "eax", scale: 1, disp: 0 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const eaxReads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  );

  validateIrBlock(block);
  strictEqual(eaxReads.length, 2);
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    eaxReads[1]?.output
  );
});

test("a segment load inside a loop body fails loudly", () => {
  const segmentLoadInLoop: SemanticTemplate = (s, _v) => {
    s.loop((loop, lv) => {
      loop.set(loop.operand(0), lv.const(1), 16);
      return lv.const(0);
    });
  };

  throws(
    () => createIrBlockBuilder().addInstruction(segmentLoadInLoop, [segmentBinding("ds")], loc(0x1000, 0x1005)),
    /segment load inside a loop body/
  );
});

test("jcc after cmp source uses the source-derived condition as a side exit", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const eax = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const branch = ifAction(block);

  strictEqual(nestedActionBodies(block).length, 1);
  deepStrictEqual(branch, {
    kind: "if",
    condition: v.compare(32, "eq", eax, v.const(5)),
    thenBody: nestedActionBodies(block)[0]
  });

  // The taken side exit observes the completed jcc; the root path falls
  // through and flushes the same lazy record only at block end.
  const taken = nestedBodyFlushes(block, 1);

  strictEqual(taken.length, 3);
  assertLazyRecord(taken, v, { kind: "SUB", width: 32, left: eax, right: v.const(5) });
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: v.const(0x2000) });

  assertLazyRecord(stateWrites(block), v, { kind: "SUB", width: 32, left: eax, right: v.const(5) });
  strictEqual(stateWrites(block).find((write) => write.op.slot === eipChannel), undefined);
  deepStrictEqual(actions[actions.length - 1], finishDispatch(v.const(0x1005)));
});

test("jcc side exit consumes eip in a terminating state scope and preserves fallthrough state", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const takenFlushes = nestedBodyView(block, 1).flushes;
  const advancedCount = v.binary("add", instructionCountRead(block).output, v.const(2));

  strictEqual(takenFlushes.find((write) => write.op.slot === eipChannel), undefined);
  strictEqual(
    takenFlushes.find((write) => write.op.slot === gprChannel("eax"))?.op.value,
    v.const(0x77)
  );
  strictEqual(
    takenFlushes.find((write) => write.op.slot === instructionCountChannel)?.op.value,
    advancedCount
  );
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value,
    v.const(0x77)
  );
  deepStrictEqual(rawEntryActions(block)[rawEntryActions(block).length - 1], finishDispatch(v.const(0x1007)));
});

test("jcc after test source uses the source-derived condition with no flag byte reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(testInstructionSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const result = v.binary("and", reads[0]!.output, reads[1]!.output);

  strictEqual(ifAction(block).condition, v.compare(32, "eq", result, v.const(0)));
  strictEqual(
    entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "flag"),
    false
  );

  for (const flushes of [nestedBodyWriteFlushes(block, 1), stateWrites(block)]) {
    assertLazyRecord(flushes.filter((flush) => flush.op.slot.kind === "lazyFlags"), v, {
      kind: "LOGIC_RESULT",
      width: 32,
      result
    });
  }
});

const subSourceThenJccTemplate: SemanticTemplate = (s, v) => {
  const left = s.get(s.reg("eax"), 32);
  const right = s.get(s.reg("ebx"), 32);
  const result = v.binary("sub", left, right);

  s.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  s.if(s.condition("E"), (then) => then.jump(v.const(0x2000)));
};

test("jcc after a sub flag source uses the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(subSourceThenJccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );

  strictEqual(ifAction(block).condition, block.values.compare(32, "eq", reads[0]!.output, reads[1]!.output));
});

test("jcc after 16-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(16), [regBinding("ax"), regBinding("bx")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("L"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const condition = v.compare(32,
    "lt_s",
    v.extend(16, reads[0]!.output, true),
    v.extend(16, reads[1]!.output, true)
  );

  strictEqual(ifAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "flag"),
    false
  );
});

test("jcc after 8-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("GE"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const condition = v.compare(32,
    "ge_s",
    v.extend(8, reads[0]!.output, true),
    v.extend(8, reads[1]!.output, true)
  );

  strictEqual(ifAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "flag"),
    false
  );
});

test("jcc after 16-bit cmp immediate source sign-extends immediates for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(16), [regBinding("ax"), immBinding(0x8000)], loc(0x1000, 0x1004));
  builder.addInstruction(jccSemantic("LE"), [immBinding(0x2000)], loc(0x1004, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const ax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ax")
  )!.output;
  const condition = v.compare(32,
    "le_s",
    v.extend(16, ax, true),
    v.const(-0x8000)
  );

  strictEqual(ifAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "flag"),
    false
  );
});

test("int flushes pending state with the resume eip before a host trap exit", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(intSemantic(), [immBinding(0x21)], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(0x77)),
    stateWrite(eipChannel, v.const(0x1007)),
    finishTrap(v, v.const(0x21))
  ]);
});

test("int3 flushes the constant breakpoint vector as a host trap", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(int3Semantic(), [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(eipChannel, v.const(0x1001)),
    finishTrap(v, v.const(3))
  ]);
});

test("into emits a completed-path conditional host trap and fallthrough state", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(intoSemantic(), [], loc(0x1005, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const ofRead = statusFlagCallAction(block, "OF").outputs[0]!;

  deepStrictEqual(ifAction(block), {
    kind: "if",
    condition: ofRead,
    hint: "unlikely",
    thenBody: nestedActionBodies(block)[0]
  });
  deepStrictEqual(nestedBodyWriteFlushes(block, 1).map((write) => write.op), [
    stateWrite(gprChannel("eax"), v.const(0x77)).op,
    stateWrite(eipChannel, v.const(0x1006)).op
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    trapExit(v, v.const(4))
  );
  deepStrictEqual(stateWrites(block).map((write) => write.op), [
    stateWrite(gprChannel("eax"), v.const(0x77)).op
  ]);
});

test("jecxz and loop branches dispatch through ecx-derived conditions without flag writes", () => {
  const jecxzBuilder = createIrBlockBuilder();
  const loopBuilder = createIrBlockBuilder();

  jecxzBuilder.addInstruction(jecxzSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1002));
  loopBuilder.addInstruction(loopSemantic("none"), [immBinding(0x2000)], loc(0x1000, 0x1002));

  const jecxz = jecxzBuilder.finish();
  const loop = loopBuilder.finish();
  const jecxzEcx = entryActions(jecxz).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ecx")
  )!.output;
  const loopEcx = entryActions(loop).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ecx")
  )!.output;
  const decremented = loop.values.binary("sub", loopEcx, loop.values.const(1));

  strictEqual(ifAction(jecxz).condition, jecxz.values.compare(32, "eq", jecxzEcx, jecxz.values.const(0)));
  strictEqual(ifAction(loop).condition, loop.values.compare(32, "ne", decremented, loop.values.const(0)));
  for (const branch of [nestedBodyWriteFlushes(loop, 1), stateWrites(loop)]) {
    strictEqual(branch.find((write) => write.op.slot === gprChannel("ecx"))?.op.value, decremented);
  }
  strictEqual(
    [
      ...entryActions(jecxz),
      ...entryActions(loop),
      ...nestedBodyWriteFlushes(jecxz, 1),
      ...nestedBodyWriteFlushes(loop, 1),
      ...stateWrites(jecxz),
      ...stateWrites(loop)
    ].some(
      (action) => isStateWrite(action) && action.op.slot.kind === "flag"
    ),
    false
  );
});

test("flat32 segment set exits through the fault path without segment writes", () => {
  const builder = createIrBlockBuilder({ segmentMode: "flat32" });

  builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(movToSregSemantic(), [segmentBinding("ds"), regBinding("ax")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const ax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ax")
  )?.output;

  ok(ax !== undefined, "expected selector source read");
  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(entryActions(block), [
    stateRead(ax, gprChannel("ax")),
    stateWrite(gprChannel("ecx"), v.const(0x77)),
    stateWrite(eipChannel, v.const(0x1005)),
    finishSegmentLoad(v, v.const(segmentRegisterIndex("ds")), ax)
  ]);
  strictEqual(stateWrites(block).some((write) => write.op.slot.kind === "segment"), false);
});

test("a block ended by a host trap rejects further instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(intSemantic(), [immBinding(3)], loc(0x1000, 0x1002));

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1002, 0x1007)),
    /after a block terminator/
  );
});

test("setcc after cmp source consumes the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(setccSemantic("B"), [regBinding("al")], loc(0x1003, 0x1006));

  const block = builder.finish();
  const v = block.values;
  // B is derived directly from the cmp source; no flag byte is read.
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const condition = v.compare(32, "lt_u", ebx, v.const(5));

  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(entryActions(block).filter((action) => isStateRead(action)).length, 1);
});

const logicSourceThenSetccTemplate: SemanticTemplate = (s, v) => {
  const left = s.get(s.reg("eax"), 32);
  const right = s.get(s.reg("ebx"), 32);
  const result = v.binary("and", left, right);

  s.writeStatusFlagsSource({ kind: "logic", width: 32, result });
  s.set(s.reg("al"), v.select(s.condition("NE"), v.const(1), v.const(0)), 8);
};

test("setcc after a logic flag source uses the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(logicSourceThenSetccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const result = v.binary("and", reads[0]!.output, reads[1]!.output);
  const condition = v.compare(32, "ne", result, v.const(0));

  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(
    entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "flag"),
    false
  );
});

test("setcc with no pending flag value builds a lazy condition switch", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(setccSemantic("A"), [regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const conditionSwitch = switchAction(block);

  deepStrictEqual(
    entryActions(block).flatMap((action) =>
      isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
    ),
    ["CF", "ZF"]
  );
  strictEqual(entryActions(block).some((action) => isStatusFlagCall(action)), false);

  const zero = v.const(0);
  const write = stateWrites(block).find((write) => write.op.slot === gprChannel("al"));

  ok(write !== undefined, "expected setcc to write al");
  const select = v.node(write.op.value);

  ok(select.kind === "select", "expected setcc to write a select value");
  strictEqual(select.whenTrue, v.const(1));
  strictEqual(select.whenFalse, zero);
  strictEqual(select.condition, conditionSwitch.output);
  strictEqual(conditionSwitch.cases.length, 3);
  strictEqual(
    conditionSwitch.cases.some((switchCase) =>
      switchCase.body.actions.some((action) => isStatusFlagCall(action))
    ),
    false
  );

  const defaultCalls = conditionSwitch.defaultBody.actions.filter(isStatusFlagCall);

  deepStrictEqual(defaultCalls.map(resolvedStatusFlag), ["CF", "ZF"]);
});

test("setcc after an intervening add uses the latest source-expanded flag expression", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(aluSemantic("add", 32), [regBinding("ecx"), immBinding(1)], loc(0x1003, 0x1006));
  builder.addInstruction(setccSemantic("E"), [regBinding("al")], loc(0x1006, 0x1009));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // E rebuilds from the add's source-expanded ZF expression; no flag byte load.
  strictEqual(
    actions.filter((action) => isStateRead(action) && action.op.slot.kind === "flag").length,
    0
  );

  const ecxRead = actions.filter(
    (action): action is StateReadAction => isStateRead(action)
  )[1]!.output;
  const sum = v.binary("add", ecxRead, v.const(1));
  const zf = v.compare(32, "eq", sum, v.const(0));

  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("al"))?.op.value,
    v.select(zf, v.const(1), v.const(0))
  );
});

test("pushfd reuses pending arithmetic flags and reads non-arithmetic flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1003));
  builder.addInstruction(pushfdSemantic(), [], loc(0x1003, 0x1004));

  const block = builder.finish();
  const flagReads = entryActions(block).flatMap((action) =>
    isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
  );

  deepStrictEqual(flagReads, ["TF", "DF", "NT", "AC", "ID"]);
  deepStrictEqual([...writtenFlags(block)], []);

  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;

  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(1) });
});

test("pushf reuses pending arithmetic flags and reads only low non-arithmetic flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1003));
  builder.addInstruction(pushfSemantic(), [], loc(0x1003, 0x1005));

  const block = builder.finish();
  const flagReads = entryActions(block).flatMap((action) =>
    isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
  );
  const stackWrite = entryActions(block).find(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  );

  deepStrictEqual(flagReads, ["TF", "DF", "NT"]);
  deepStrictEqual([...writtenFlags(block)], []);
  ok(stackWrite !== undefined, "expected pushf to write stack memory");
  strictEqual(stackWrite.op.width, 16);

  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;

  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(1) });
});

test("popfd writes every stored flag from the popped image", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popfdSemantic(), [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const espRead = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  );
  const popRead = actions.find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  );

  ok(espRead !== undefined, "expected popfd to read esp");
  ok(popRead !== undefined, "expected popfd to read stack memory");
  deepStrictEqual(
    actions.flatMap((action) =>
      isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
    ),
    x86StatusFlags
  );

  const writes = stateWrites(block);
  const flagWrites = flagWriteEntries(block);

  strictEqual(writes[0]?.op.slot, gprChannel("esp"));
  strictEqual(writes[0].op.value, v.binary("add", espRead.output, v.const(4)));
  deepStrictEqual(flagWrites.map((write) => write.flag).sort(), [...x86Flags].sort());
  strictEqual(new Set(flagWrites.map((write) => write.flag)).size, x86Flags.length);

  for (const write of flagWrites) {
    const offset = x86EflagsBitOffset[write.flag];
    const shifted: ValueId = offset === 0
      ? popRead.output
      : v.binary("shr_u", popRead.output, v.const(offset));

    strictEqual(write.value, v.binary("and", shifted, v.const(1)), write.flag);
  }
});

test("popf writes only stored low-16 modeled flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popfSemantic(), [], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const espRead = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  );
  const popRead = actions.find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  );

  ok(espRead !== undefined, "expected popf to read esp");
  ok(popRead !== undefined, "expected popf to read stack memory");
  strictEqual(popRead.op.width, 16);
  deepStrictEqual(
    actions.flatMap((action) =>
      isStateRead(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
    ),
    x86StatusFlags
  );

  const writes = stateWrites(block);
  const flagWrites = flagWriteEntries(block);
  const low16Flags = x86Flags.filter((flag) => x86EflagsBitOffset[flag] < 16);

  strictEqual(writes[0]?.op.slot, gprChannel("esp"));
  strictEqual(writes[0].op.value, v.binary("add", espRead.output, v.const(2)));
  deepStrictEqual(flagWrites.map((write) => write.flag).sort(), [...low16Flags].sort());
  strictEqual(new Set(flagWrites.map((write) => write.flag)).size, low16Flags.length);

  for (const write of flagWrites) {
    const offset = x86EflagsBitOffset[write.flag];
    const shifted: ValueId = offset === 0
      ? popRead.output
      : v.binary("shr_u", popRead.output, v.const(offset));

    strictEqual(write.value, v.binary("and", shifted, v.const(1)), write.flag);
  }
});

test("set to an imm operand binding fails loudly", () => {
  const setImm: SemanticTemplate = (s, v) => {
    s.set(s.operand(0), v.const(1), 32);
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(setImm, [immBinding(0)], loc(0x1000, 0x1006)),
    /not supported by IR block builder yet/
  );
});

test("a template width that disagrees with its register binding fails loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(
        movSemantic(8),
        [regBinding("eax"), immBinding(1)],
        loc(0x1000, 0x1002)
      ),
    /8-bit set to a 32-bit register channel/
  );
});

test("a failed instruction poisons the builder, discarding its partial pendings", () => {
  const builder = createIrBlockBuilder();
  const setThenFail: Parameters<typeof builder.addInstruction>[0] = (s, v) => {
    s.set(s.operand(0), v.const(1), 32);
    s.set(s.operand(1), v.const(2), 32);
  };

  throws(
    () =>
      builder.addInstruction(setThenFail, [regBinding("eax"), immBinding(0)], loc(0x1000, 0x1002)),
    /not supported by IR block builder yet/
  );
  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1002, 0x1007)),
    /incomplete instruction/
  );
  throws(() => builder.finish(), /incomplete instruction/);
});

test("a builder with no instructions cannot finish", () => {
  throws(() => createIrBlockBuilder().finish(), /no instructions were added/);
});

test("missing operand bindings fail loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(movSemantic(32), [regBinding("eax")], loc(0x1000, 0x1005)),
    /missing operand binding for operand 1/
  );
});

test("a finished builder rejects further use", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1005));
  builder.finish();

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1005, 0x100a)),
    /finished IR block builder/
  );
  throws(() => builder.finish(), /already finished/);
});

test("mov [ebx+8], eax guards before the store and flushes eip into the fault edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!;
  const address = v.binary("add", ebx.output, v.const(8));

  strictEqual(nestedActionBodies(block).length, 1);
  deepStrictEqual(entryActions(block), [
    stateRead(eax.output, gprChannel("eax")),
    stateRead(ebx.output, gprChannel("ebx")),
    ...memoryGuard(block, 1, address, 4, "write"),
    memoryWrite(address, eax.output, 32),
    finishDispatch(v.const(0x1003))
  ]);

  const edge = nestedBodyView(block, 1);

  deepStrictEqual(edge.flushes, [
    stateWrite(eipChannel, v.const(0x1000))
  ]);
  deepStrictEqual(edge.terminator, pageFaultStop(v, "write", address));
});

test("add [ebx], r32 resolves once with a WRITE fault before its read and write", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("ecx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // One WRITE resolution supplies the access used by both RMW phases (scale 1
  // and disp 0 add no terms).
  const address = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  const readIndex = actions.findIndex((action) => isMemoryRead(action));
  const writeIndex = actions.findIndex((action) => isMemoryWrite(action));
  const lastGuardIndex = actions.findIndex((action) => action.kind === "if");

  ok(
    lastGuardIndex >= 0 && lastGuardIndex < readIndex && readIndex < writeIndex,
    "guards, then the load, then the store"
  );

  // The store carries the sum of the loaded value and the ecx read.
  const loaded = (actions[readIndex] as MemoryReadAction).output;
  const ecx = actions.filter(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ecx")
  )[0]!.output;

  deepStrictEqual(actions[writeIndex], memoryWrite(address, v.binary("add", loaded, ecx), 32));

  // The WRITE validity branch owns the only edge and reports a write PF.
  const eipFlushes = [stateWrite(eipChannel, v.const(0x1000))];

  deepStrictEqual(nestedBodyView(block, 1).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "write", address));
});

test("a later guard's edge flushes earlier pendings with the faulting eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1003, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const ebxRead = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!;
  const address = v.binary("add", ebxRead.output, v.const(8));

  strictEqual(nestedActionBodies(block).length, 1);

  // The edge snapshots everything dirty at the guard: the add's lazy flag
  // record, eax sum, and the faulting instruction's eip.
  const flushes = nestedBodyFlushes(block, 1);

  strictEqual(flushes.length, 5);
  deepStrictEqual(flushes.flatMap((flush) => flush.op.slot.kind === "flag" ? [flush.op.slot.flag] : []), []);
  assertLazyRecord(flushes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(nestedBodyWriteFlushes(block, 1).find((write) => write.op.slot === gprChannel("eax"))?.op.value, sum);
  strictEqual(nestedBodyWriteFlushes(block, 1).find((write) => write.op.slot === eipChannel)?.op.value, v.const(0x1003));
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "write", address));

  // The edge flush leaves the main-path map untouched: the entry still
  // stores the sum and the store's value is the pending sum, not a reload.
  const mainWrites = stateWrites(block);

  strictEqual(mainWrites.find((write) => write.op.slot === gprChannel("eax"))?.op.value, sum);
  strictEqual(mainWrites.find((write) => write.op.slot === eipChannel), undefined);
  deepStrictEqual(entryActions(block).at(-1), finishDispatch(v.const(0x1006)));

  const store = entryActions(block).find(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  )!;

  strictEqual(store.op.inputs[1]!.value, sum);
});

test("lea builds general modrm addresses from channel reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    leaSemantic(32),
    [regBinding("eax"), mem({ base: "ebx", index: "esi", scale: 4, disp: 0x10 })],
    loc(0x1000, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;
  // base + (index << 2) + disp, with no guard and no memory access.
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const esi = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esi")
  )!.output;
  const scaled = v.binary("shl", esi, v.const(2));
  const address = v.binary("add", v.binary("add", ebx, scaled), v.const(0x10));

  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(entryActions(block), [
    stateRead(ebx, gprChannel("ebx")),
    stateRead(esi, gprChannel("esi")),
    stateWrite(gprChannel("eax"), address),
    finishDispatch(v.const(0x1007))
  ]);
});

test("lea uses the effective offset without adding segment bases", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    leaSemantic(32),
    [regBinding("eax"), mem({ segment: "fs", base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1004)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(entryActions(block), [
    stateRead(ebx, gprChannel("ebx")),
    stateWrite(gprChannel("eax"), ebx),
    finishDispatch(v.const(0x1004))
  ]);
});

test("flat segment memory operands use the effective offset directly", () => {
  for (const segment of ["cs", "ds", "es", "ss"] as const) {
    const builder = createIrBlockBuilder();

    builder.addInstruction(
      movSemantic(32),
      [regBinding("eax"), mem({ segment, base: "ebx", scale: 1, disp: 0 })],
      loc(0x1000, 0x1003)
    );

    const block = builder.finish();
    const ebx = entryActions(block).find(
      (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
    )!.output;
    const read = entryActions(block).find(
      (action): action is MemoryReadAction => isMemoryRead(action)
    )!;

    strictEqual(read.op.inputs[0]!.value, ebx, segment);
    strictEqual(
      entryActions(block).some((action) => isStateRead(action) && action.op.slot.kind === "segment"),
      false,
      segment
    );
  }
});

test("fs and gs memory operands add the segment base to the effective offset", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), mem({ segment: "fs", base: "ebx", scale: 1, disp: 8 })],
    loc(0x1000, 0x1004)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const fsBase = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === segmentBaseChannel("fs")
  )!.output;
  const offset = v.binary("add", ebx, v.const(8));
  const address = v.binary("add", fsBase, offset);
  const read = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;

  deepStrictEqual(entryActions(block), [
    stateRead(ebx, gprChannel("ebx")),
    stateRead(fsBase, segmentBaseChannel("fs")),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryRead(read.output, address, 32),
    stateWrite(gprChannel("eax"), read.output),
    finishDispatch(v.const(0x1004))
  ]);
});

test("an absolute address is just its displacement constant", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), mem({ scale: 1, disp: 0x2000 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);
  const read = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;

  deepStrictEqual(entryActions(block), [
    read,
    stateWrite(gprChannel("eax"), read.output),
    finishDispatch(v.const(0x1005))
  ]);
  strictEqual(read.op.inputs[0]!.value, address);
  strictEqual(nestedActionBodies(block).length, 0);
});

test("movzx r32, byte [mem] forwards the unsigned load unmasked", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movzxSemantic(8, 32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;
  const address = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(read, memoryRead(read.output, address, 8));
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, read.output);
  ok(!nodeKinds(block).includes("truncate"), "no truncations expected");
});

test("movsx r32, byte [mem] marks the load signed with no extra extend", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movsxSemantic(8, 32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;
  const address = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(read, memoryRead(read.output, address, 8, true));
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, read.output);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("xchg [ebx], ebx stores through the original address, not the new ebx", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    xchgSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("ebx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const load = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;

  // The effective address is computed once, before the instruction writes
  // ebx: the store address and value are the original ebx read, and the
  // register flush carries the loaded value.
  deepStrictEqual(entryActions(block), [
    stateRead(ebx, gprChannel("ebx")),
    ...memoryGuard(block, 1, ebx, 4, "write"),
    memoryRead(load, ebx, 32),
    memoryWrite(ebx, ebx, 32),
    stateWrite(gprChannel("ebx"), load),
    finishDispatch(v.const(0x1002))
  ]);
});

test("a validated DS WRITE access lowers read and write actions at its address", () => {
  const incMem: SemanticTemplate = (s, v) => {
    const address = v.const(0x2000);
    const target = resolveDsMemory(s, address, v.const(4), "write");

    s.memoryWrite(
      target,
      v.const(0),
      v.binary("add", s.memoryRead(target, v.const(0), 32), v.const(1)),
      32
    );
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(incMem, [], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);
  const read = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;
  const write = entryActions(block).find(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  )!;

  deepStrictEqual(entryActions(block), [
    read,
    write,
    finishDispatch(v.const(0x1006))
  ]);
  strictEqual(nestedActionBodies(block).length, 0);
  strictEqual(read.op.inputs[0]!.value, address);
  strictEqual(write.op.inputs[0]!.value, address);
  strictEqual(write.op.inputs[1]!.value, v.binary("add", read.output, v.const(1)));
});

test("a folded byte length selects the static flat guard path", () => {
  let foldedByteLength!: ValueId;
  const foldedGuard: SemanticTemplate = (s, v) => {
    const address = v.const(0x2000);
    const byteLength = v.binary("shl", v.const(1), v.const(2));

    foldedByteLength = byteLength;
    resolveDsMemory(s, address, byteLength, "read");
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(foldedGuard, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  strictEqual(block.values.constValue(foldedByteLength), 4);
  strictEqual(entryActions(block).filter((action) => action.kind === "if").length, 0);
});

test("memory resolution is nonterminal and access metadata adds no IR actions", () => {
  const template: SemanticTemplate = (s, v) => {
    const access = s.memoryResolve(s.mem("ds", v.const(0x2000)), v.const(4), "read");

    access.invalid;
    s.set(s.reg("eax"), v.const(7));
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(template, [], loc(0x1000, 0x1001));
  const block = builder.finish();
  const actions = entryActions(block);

  strictEqual(actions.filter((action) => isMemoryRead(action) || isMemoryWrite(action)).length, 0);
  strictEqual(actions.some((action) => action.kind === "if"), false);
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, block.values.const(7));
});

test("the IR builder does not impose semantic memory-validation policy", () => {
  const uncheckedRead: SemanticTemplate = (s, v) => {
    const access = s.memoryResolve(s.mem("ds", v.const(0x2000)), v.const(4), "read");

    s.memoryRead(access, v.const(0), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(uncheckedRead, [], loc(0x1000, 0x1001));

  const actions = entryActions(builder.finish());

  strictEqual(actions.filter((action) => isMemoryRead(action)).length, 1);
  strictEqual(actions.some((action) => action.kind === "if"), false);
});

test("constant memory access offsets must fit their resolved range", () => {
  const outOfRange: SemanticTemplate = (s, v) => {
    const access = resolveDsMemory(s, v.const(0x2000), v.const(4), "read");

    s.memoryRead(access, v.const(1), 32);
  };

  throws(
    () => createIrBlockBuilder().addInstruction(outOfRange, [], loc(0x1000, 0x1001)),
    /exceeds 4-byte resolution/
  );
});

test("constant relative offsets become memory immediates at the upper boundary", () => {
  const boundaryAccess: SemanticTemplate = (s, v) => {
    const access = resolveDsMemory(s, v.const(0x2000), v.const(8), "write");
    const value = s.memoryRead(access, v.const(4), 32);

    s.memoryWrite(access, v.const(4), value, 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(boundaryAccess, [], loc(0x1000, 0x1001));
  const actions = entryActions(builder.finish());
  const read = actions.find((action): action is MemoryReadAction => isMemoryRead(action));
  const write = actions.find((action): action is MemoryWriteAction => isMemoryWrite(action));

  ok(read !== undefined);
  ok(write !== undefined);
  strictEqual(read.op.displacement, 4);
  strictEqual(write.op.displacement, 4);
  strictEqual(read.op.inputs[0]!.value, write.op.inputs[0]!.value);
});

test("READ and WRITE resolutions retain their exact fault metadata", () => {
  let address!: ValueId;
  const bothIntents: SemanticTemplate = (s, v) => {
    address = s.get(s.reg("eax"));
    const memory = s.mem("ds", address);
    const read = s.memoryResolve(memory, v.const(4), "read");
    const write = s.memoryResolve(memory, v.const(4), "write");

    s.if(read.invalid, (failure) => {
      failure.cpuException(memoryAccessException(read));
    }, "unlikely");
    s.if(write.invalid, (failure) => {
      failure.cpuException(memoryAccessException(write));
    }, "unlikely");
    const value = s.memoryRead(read, v.const(0), 32);

    s.memoryWrite(write, v.const(0), value, 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(bothIntents, [], loc(0x1000, 0x1001));
  const block = builder.finish();

  strictEqual(nestedActionBodies(block).length, 2);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(block.values, "read", address)
  );
  deepStrictEqual(
    nestedBodyView(block, 2).terminator,
    pageFaultStop(block.values, "write", address)
  );
});

test("address of a non-mem operand binding fails loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(
        leaSemantic(32),
        [regBinding("eax"), regBinding("ebx")],
        loc(0x1000, 0x1002)
      ),
    /address of a reg operand binding/
  );
});

// Writes a register, then guards — the pop r/m32 shape, where the
// destination EA depends on the already-updated register.
const setRegThenStore: SemanticTemplate = (s, v) => {
  const address = s.get(s.reg("ebx"));

  s.set(s.operand(0), v.const(0x222), 32);
  writeDsMemory(s, v, address, s.get(s.operand(0), 32), 32);
};

test("a guard after a register write restores the pre-instruction value in its edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x111)], loc(0x1000, 0x1005));
  builder.addInstruction(setRegThenStore, [regBinding("eax")], loc(0x1005, 0x100b));

  const block = builder.finish();
  const v = block.values;
  const address = entryActions(block).find(
    (action): action is StateReadAction =>
      isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  // The edge flushes eax's value as of instruction start — never the 0x222
  // this instruction wrote before guarding.
  deepStrictEqual(nestedBodyFlushes(block, 1), [
    stateWrite(gprChannel("eax"), v.const(0x111)),
    stateWrite(eipChannel, v.const(0x1005))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", address)
  );

  // The main path keeps the new value: the store and the flush carry 0x222.
  const store = entryActions(block).find(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  )!;

  strictEqual(store.op.inputs[1]!.value, v.const(0x222));
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, v.const(0x222));
});

test("a guard after writing a previously-clean register omits the channel from its edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(setRegThenStore, [regBinding("eax")], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = entryActions(block).find(
    (action): action is StateReadAction =>
      isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  // eax had no pending at instruction start: cpu state memory already holds the
  // right bytes, so the edge writes only the eip.
  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(eipChannel, v.const(0x1000))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", address)
  );
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, v.const(0x222));
});

test("pop [ebx] guards the stack read first and omits boundary-absent esp from its write edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [mem({ base: "ebx", scale: 1, disp: 0 })], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  strictEqual(nestedActionBodies(block).length, 2);
  deepStrictEqual(entryActions(block), [
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryRead(popValue, esp, 32),
    stateRead(ebx, gprChannel("ebx")),
    ...memoryGuard(block, 2, ebx, 4, "write"),
    memoryWrite(ebx, popValue, 32),
    stateWrite(gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1002))
  ]);

  // esp was boundary-absent, so neither edge writes it — not even the write
  // guard's, where esp is already pending with the incremented value.
  const eipFlushes = [stateWrite(eipChannel, v.const(0x1000))];

  deepStrictEqual(nestedBodyView(block, 1).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", esp));
  deepStrictEqual(nestedBodyView(block, 2).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", ebx));
});

test("pop fs:[ebx] writes to the linear destination address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [mem({ segment: "fs", base: "ebx", scale: 1, disp: 0 })], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const ebx = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;
  const fsBase = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === segmentBaseChannel("fs")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));
  const address = v.binary("add", fsBase, ebx);

  deepStrictEqual(entryActions(block), [
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryRead(popValue, esp, 32),
    stateRead(ebx, gprChannel("ebx")),
    stateRead(fsBase, segmentBaseChannel("fs")),
    ...memoryGuard(block, 2, address, 4, "write"),
    memoryWrite(address, popValue, 32),
    stateWrite(gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1002))
  ]);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", address));
});

test("pop [ebx] write edge restores a previous instruction's pending esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("esp"), immBinding(0x30)], loc(0x1000, 0x1005));
  builder.addInstruction(popSemantic(), [mem({ base: "ebx", scale: 1, disp: 0 })], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const ebxRead = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!;

  // The edge restores the boundary esp — the mov's 0x30, not the pop's
  // incremented value.
  deepStrictEqual(nestedBodyFlushes(block, 1), [
    stateWrite(gprChannel("esp"), v.const(0x30)),
    stateWrite(eipChannel, v.const(0x1005))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", ebxRead.output)
  );
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("esp"))?.op.value,
    v.binary("add", v.const(0x30), v.const(4))
  );
});

test("pop [esp] builds the destination address from the incremented esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [mem({ base: "esp", scale: 1, disp: 0 })], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  deepStrictEqual(entryActions(block), [
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryRead(popValue, esp, 32),
    ...memoryGuard(block, 2, nextEsp, 4, "write"),
    memoryWrite(nextEsp, popValue, 32),
    stateWrite(gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1003))
  ]);
});

test("pop [esp+k] adds the displacement to the incremented esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [mem({ base: "esp", scale: 1, disp: 8 })], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const address = v.binary("add", v.binary("add", esp, v.const(4)), v.const(8));
  const store = entryActions(block).find(
    (action): action is MemoryWriteAction => isMemoryWrite(action)
  )!;

  strictEqual(store.op.effect.resource.id, "memory.guest");
  strictEqual(store.op.inputs[0]!.value, address);
});

test("a fault branch after a memory write in the same instruction fails loudly", () => {
  const storeThenFault: SemanticTemplate = (s, v) => {
    const firstAddress = v.const(0x2000);
    const access = resolveDsMemory(s, firstAddress, v.const(4), "write");

    s.memoryWrite(access, v.const(0), v.const(1), 32);
    resolveDsMemory(s, s.get(s.reg("eax")), v.const(4), "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(storeThenFault, [], loc(0x1000, 0x1006)),
    /CPU exception cannot follow a memory write/
  );
});

test("memory resolution itself may follow a memory write", () => {
  const storeThenResolve: SemanticTemplate = (s, v) => {
    const access = resolveDsMemory(s, v.const(0x2000), v.const(4), "write");

    s.memoryWrite(access, v.const(0), v.const(1), 32);
    s.memoryResolve(s.mem("ds", v.const(0x3000)), v.const(4), "read");
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(storeThenResolve, [], loc(0x1000, 0x1006));

  strictEqual(entryActions(builder.finish()).filter(isMemoryWrite).length, 1);
});

test("a continuing dynamic arm carries its memory write into the parent scope", () => {
  const armStoreThenException: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (then) => {
      writeDsMemory(then, v, v.const(0x2000), v.const(1), 32);
    });
    s.cpuException(invalidOpcode());
  };

  throws(
    () => createIrBlockBuilder().addInstruction(armStoreThenException, [], loc(0x1000, 0x1005)),
    /CPU exception cannot follow a memory write/
  );
});

test("a loop carries its memory write into the parent scope", () => {
  const loopStoreThenException: SemanticTemplate = (s) => {
    s.loop((loop, loopValues) => {
      writeDsMemory(loop, loopValues, loopValues.const(0x2000), loopValues.const(1), 32);
      return loopValues.const(0);
    });
    s.cpuException(invalidOpcode());
  };

  throws(
    () => createIrBlockBuilder().addInstruction(loopStoreThenException, [], loc(0x1000, 0x1005)),
    /CPU exception cannot follow a memory write/
  );
});

test("a terminating dynamic arm does not carry its memory write into the skipped path", () => {
  const armStoreThenJump: SemanticTemplate = (s, v) => {
    s.if(s.get(s.reg("eax")), (then) => {
      writeDsMemory(then, v, v.const(0x2000), v.const(1), 32);
      then.jump(v.const(0x3000));
    });
    s.cpuException(invalidOpcode());
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(armStoreThenJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(
    nestedActionBodies(block)[0]?.actions.some((action) => isMemoryWrite(action)),
    true
  );
  strictEqual(entryActions(block).some((action) => isMemoryWrite(action)), false);
  deepStrictEqual(
    entryActions(block).at(-1),
    finishException(block.values, invalidOpcode())
  );
});

test("a guard after flushing a channel first written this instruction fails loudly", () => {
  const flushThenGuard: SemanticTemplate = (s, v) => {
    s.set(s.operand(0), v.const(1), 8);
    s.get(s.operand(1), 16);
    resolveDsMemory(s, s.get(s.reg("ebx")), v.const(4), "read");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(flushThenGuard, [regBinding("al"), regBinding("ax")], loc(0x1000, 0x1003)),
    /unrestorable/
  );
});

test("add r/m32, r32 with both operands dynamic reads, then writes, in one block", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const dst = v.external(0);
  const src = v.external(1);
  const actions = entryActions(block);
  const reads = actions.filter(
    (action): action is StateReadAction => isStateRead(action)
  );
  const sum = v.binary("add", reads[0]!.output, reads[1]!.output);

  strictEqual(nestedActionBodies(block).length, 0);
  deepStrictEqual(block.values.node(dst), { kind: "external", external: 0 });
  deepStrictEqual(actions[0], stateRead(reads[0]!.output, { kind: "gprDynamic", index: dst, byteLength: 4 }));
  deepStrictEqual(actions[1], stateRead(reads[1]!.output, { kind: "gprDynamic", index: src, byteLength: 4 }));
  deepStrictEqual(actions[2], stateWrite({ kind: "gprDynamic", index: dst, byteLength: 4 }, sum));

  // Lazy flags commit from the dynamic reads exactly as from static ones.
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: reads[0]!.output, right: reads[1]!.output });
});

test("a static register read keeps its order across a dynamic write", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const read = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!;

  deepStrictEqual(entryActions(block), [
    stateRead(read.output, gprChannel("ebx")),
    stateWrite({ kind: "gprDynamic", index: v.external(0), byteLength: 4 }, read.output),
    finishDispatch(v.const(0x1002))
  ]);
});

test("dirty GPR pendings flush before dynamic access; flags and eip ride through", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ecx")], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const actions = entryActions(block);
  const eaxFlush = actions.findIndex((a) => isStateWrite(a) && a.op.slot === gprChannel("eax"));
  const dynamicWrite = actions.findIndex((a) => isStateWrite(a) && a.op.slot.kind === "gprDynamic");
  const lazyKindFlush = actions.findIndex((a) => isStateWrite(a) && a.op.slot === lazyFlagsKindChannel);

  ok(eaxFlush !== -1 && dynamicWrite !== -1, "expected an eax flush and a dynamic write");
  ok(eaxFlush < dynamicWrite, "the dirty eax pending must flush before the dynamic write");
  ok(dynamicWrite < lazyKindFlush, "lazy flags ride through and flush at the end");
  strictEqual(stateWrites(block).filter((write) => write.op.slot === gprChannel("eax")).length, 1);
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, sum);
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });

  strictEqual(stateWrites(block).filter((write) => write.op.slot === eipChannel).length, 0);
});

test("a dynamic write invalidates static GPR pendings for later instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), immBinding(5)], loc(0x1005, 0x100b));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const actions = entryActions(block);
  const eaxReads = actions.filter(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("eax")
  );
  const dynamicWrite = actions.findIndex(
    (action) => isStateWrite(action) && action.op.slot.kind === "gprDynamic"
  );

  // The dynamic write may have hit eax's word, so the third mov reloads it.
  strictEqual(eaxReads.length, 1);
  ok(actions.indexOf(eaxReads[0]!) > dynamicWrite, "the eax reload must follow the dynamic write");
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ebx"))?.op.value,
    eaxReads[0]!.output
  );
});

test("a dynamic read leaves flushed pendings serving later static reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regDynamicBinding(0)], loc(0x1005, 0x100b));
  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // The dynamic read flushed eax once and left it clean: the third mov is
  // served from the pending with no reload and no second store.
  strictEqual(stateWrites(block).filter((write) => write.op.slot === gprChannel("eax")).length, 1);
  strictEqual(
    actions.filter((action) => isStateRead(action) && action.op.slot === gprChannel("eax")).length,
    0
  );
  strictEqual(
    stateWrites(block).find((write) => write.op.slot === gprChannel("ecx"))?.op.value,
    v.const(0x77)
  );
});

test("pop r/mDyn flushes the incremented esp before the dynamic store, after the guard", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  // Values-first: the guard (and its snapshot) precedes the esp flush the
  // dynamic store forces, so the unrestorable store happens after the last
  // fault edge.
  strictEqual(nestedActionBodies(block).length, 1);
  deepStrictEqual(entryActions(block), [
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryRead(popValue, esp, 32),
    stateWrite(gprChannel("esp"), nextEsp),
    stateWrite({ kind: "gprDynamic", index: v.external(0), byteLength: 4 }, popValue),
    finishDispatch(v.const(0x1002))
  ]);
});

test("an 8-bit template width lowers a one-byte dynamic slot", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateRead(2, { kind: "gprDynamic", index: v.external(0), byteLength: 1 }),
    stateWrite(gprChannel("bl"), 2),
    finishDispatch(v.const(0x1002))
  ]);
});

test("a 16-bit set through a dynamic register stores a two-byte slot", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(16), [regDynamicBinding(0), immBinding(0x1234)], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], stateWrite({ kind: "gprDynamic", index: v.external(0), byteLength: 2 }, v.const(0x1234)));
});

test("movsx r32, r8 from a dynamic register marks the read signed with no extra extend", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), regDynamicBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], stateRead(2, { kind: "gprDynamic", index: v.external(0), byteLength: 1 }, true));
  strictEqual(stateWrites(block).find((write) => write.op.slot === gprChannel("eax"))?.op.value, 2);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("a guard after a dynamic flush of an instruction-written register fails loudly", () => {
  const setThenDynamicRead: SemanticTemplate = (s, v) => {
    s.set(s.reg("ebx"), v.const(0x111), 32);
    s.get(s.operand(0), 32);
    resolveDsMemory(s, s.get(s.reg("ecx")), v.const(4), "read");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(setThenDynamicRead, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("a guard after a dynamic write fails loudly", () => {
  const dynamicWriteThenGuard: SemanticTemplate = (s, v) => {
    s.set(s.operand(0), v.const(0x222), 32);
    resolveDsMemory(s, s.get(s.reg("ebx")), v.const(4), "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(dynamicWriteThenGuard, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("an external location flushes eip as the nextEip external", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), immBinding(5)],
    externalInstructionLocation(0, 1)
  );

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    stateWrite(gprChannel("eax"), v.const(5)),
    finishDispatch(v.external(1))
  ]);
});

test("a fault edge restores an external eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    externalInstructionLocation(4, 5)
  );

  const block = builder.finish();
  const v = block.values;
  const address = entryActions(block).find(
    (action): action is StateReadAction =>
      isStateRead(action) && action.op.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(eipChannel, v.external(4))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "read", address)
  );
  strictEqual(stateWrites(block).find((write) => write.op.slot === eipChannel), undefined);
  deepStrictEqual(entryActions(block).at(-1), finishDispatch(v.external(5)));
});

// The memDynamic address: the in-block base register read plus the
// pre-summed offset external.
function dynamicAddress(block: IrBlock, baseRead: StateReadAction): ValueId {
  const v = block.values;

  return v.binary("add", baseRead.output, v.external(1));
}

function dynamicBaseRead(block: IrBlock): StateReadAction {
  const read = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot.kind === "gprDynamic"
  );

  ok(read !== undefined, "expected a dynamic base register read");
  return read;
}

function dynamicSegmentBaseRead(block: IrBlock): StateReadAction & { slot: SegmentDynamicSlot } {
  const read = entryActions(block).find(
    (action): action is StateReadAction & { slot: SegmentDynamicSlot } =>
      isStateRead(action) && action.op.slot.kind === "segmentDynamic" && action.op.slot.field === "base"
  );

  ok(read !== undefined, "expected a dynamic segment base read");
  return read;
}

test("a memStatic operand guards and accesses the external address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memStaticBinding(7, staticMemSegment("ds"))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.external(7);
  const load = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;

  deepStrictEqual(entryActions(block), [
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryRead(load.output, address, 32),
    stateWrite(gprChannel("eax"), load.output),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("a segmented memStatic operand adds the selected segment base", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memStaticBinding(7, dynamicMemSegment(8))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const segmentBase = dynamicSegmentBaseRead(block);
  const address = v.binary("add", segmentBase.output, v.external(7));
  const load = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;

  deepStrictEqual(segmentBase.op.slot, { kind: "segmentDynamic", index: v.external(8), field: "base" });
  deepStrictEqual(entryActions(block), [
    stateRead(segmentBase.output, segmentBase.op.slot),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryRead(load.output, address, 32),
    stateWrite(gprChannel("eax"), load.output),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("a memDynamic operand reads the base register inside the block", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memDynamicBinding(0, 1, staticMemSegment("ds"))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);
  const load = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!;

  deepStrictEqual(entryActions(block), [
    stateRead(baseRead.output, { kind: "gprDynamic", index: v.external(0), byteLength: 4 }),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryRead(load.output, address, 32),
    stateWrite(gprChannel("eax"), load.output),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("fs memDynamic operands add the segment base to the dynamic effective address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, staticMemSegment("fs")), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const actions = entryActions(block);
  const baseRead = dynamicBaseRead(block);
  const fsBase = actions.find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === segmentBaseChannel("fs")
  )!;
  const offset = dynamicAddress(block, baseRead);
  const address = block.values.binary("add", fsBase.output, offset);
  const load = actions.find((action): action is MemoryReadAction => isMemoryRead(action))!;
  const store = actions.find((action): action is MemoryWriteAction => isMemoryWrite(action))!;

  strictEqual(actions.filter((action) => isStateRead(action) && action.op.slot.kind === "gprDynamic").length, 1);
  strictEqual(
    actions.filter((action) => isStateRead(action) && action.op.slot === segmentBaseChannel("fs")).length,
    1
  );
  strictEqual(load.op.effect.resource, store.op.effect.resource);
  strictEqual(load.op.inputs[0]!.value, address);
  strictEqual(store.op.inputs[0]!.value, address);
});

test("dynamic memDynamic segments read the selected segment base", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, dynamicMemSegment(2)), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const baseRead = dynamicBaseRead(block);
  const segmentBase = dynamicSegmentBaseRead(block);
  const offset = dynamicAddress(block, baseRead);
  const address = v.binary("add", segmentBase.output, offset);
  const load = actions.find((action): action is MemoryReadAction => isMemoryRead(action))!;
  const store = actions.find((action): action is MemoryWriteAction => isMemoryWrite(action))!;

  deepStrictEqual(segmentBase.op.slot, { kind: "segmentDynamic", index: v.external(2), field: "base" });
  strictEqual(
    actions.filter((action) => isStateRead(action) && action.op.slot.kind === "segmentDynamic").length,
    1
  );
  strictEqual(actions.filter((action) => isStateRead(action) && action.op.slot.kind === "segment").length, 0);
  strictEqual(load.op.effect.resource, store.op.effect.resource);
  strictEqual(load.op.inputs[0]!.value, address);
  strictEqual(store.op.inputs[0]!.value, address);
});

test("lea with memDynamic uses the dynamic effective address without segment bases", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    leaSemantic(32),
    [regBinding("eax"), memDynamicBinding(0, 1, staticMemSegment("fs"))],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);

  deepStrictEqual(entryActions(block), [
    stateRead(baseRead.output, baseRead.op.slot),
    stateWrite(gprChannel("eax"), address),
    finishDispatch(v.const(0x1003))
  ]);
});

test("a read+write memDynamic operand reads the base once and reuses the address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, staticMemSegment("ds")), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const actions = entryActions(block);
  const baseReads = actions.filter(
    (action) => isStateRead(action) && action.op.slot.kind === "gprDynamic"
  );
  const load = actions.find((action): action is MemoryReadAction => isMemoryRead(action))!;
  const store = actions.find((action): action is MemoryWriteAction => isMemoryWrite(action))!;

  strictEqual(baseReads.length, 1);
  strictEqual(load.op.inputs[0]!.value, dynamicAddress(block, dynamicBaseRead(block)));
  strictEqual(store.op.inputs[0]!.value, load.op.inputs[0]!.value);
});

test("pop [memDynamic] flushes esp before the base read and restores it on the write edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    popSemantic(),
    [memDynamicBinding(0, 1, staticMemSegment("ds"))],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is StateReadAction => isStateRead(action) && action.op.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is MemoryReadAction => isMemoryRead(action)
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);

  // The main path stores the incremented esp before the base read, so an
  // esp-based destination follows the SDM; the value comes from the
  // pre-increment esp read.
  strictEqual(nestedActionBodies(block).length, 2);
  deepStrictEqual(entryActions(block), [
    stateRead(esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryRead(popValue, esp, 32),
    stateWrite(gprChannel("esp"), nextEsp),
    stateRead(baseRead.output, baseRead.op.slot),
    ...memoryGuard(block, 2, address, 4, "write"),
    memoryWrite(address, popValue, 32),
    finishDispatch(v.const(0x1003))
  ]);

  // The read guard predates the flush: its edge omits esp (cpu state memory
  // still holds it on that path). The write guard's edge restores the
  // pre-instruction esp read the flush destroyed.
  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(eipChannel, v.const(0x1000))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", esp));
  deepStrictEqual(nestedBodyFlushes(block, 2), [
    stateWrite(gprChannel("esp"), esp),
    stateWrite(eipChannel, v.const(0x1000))
  ]);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", address));
});

test("a guard after a memDynamic flush of a never-read register fails loudly", () => {
  const blindWriteThenDynamicAddress: SemanticTemplate = (s, v) => {
    s.set(s.reg("ebx"), v.const(0x111), 32);
    resolveDsMemory(s, s.address(s.operand(0)), v.const(4), "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(
        blindWriteThenDynamicAddress,
        [memDynamicBinding(0, 1, staticMemSegment("ds"))],
        loc(0x1000, 0x1002)
      ),
    /unrestorable/
  );
});

test("a narrow immExternal get truncates to the access width", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), immExternalBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.op.slot === gprChannel("bl"));

  deepStrictEqual(v.node(write!.op.value), {
    kind: "truncate",
    inputType: "i32",
    width: 8,
    value: v.external(0)
  });
});

test("a signed immExternal get sign-extends instead of masking", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), immExternalBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.op.slot === gprChannel("eax"));

  deepStrictEqual(v.node(write!.op.value), {
    kind: "extend",
    resultType: "i32",
    width: 8,
    value: v.external(0),
    signed: true
  });
});

function instructionCountRead(block: IrBlock): StateReadAction {
  const read = rawEntryActions(block).find(
    (action): action is StateReadAction =>
      isStateRead(action) && action.op.slot === instructionCountChannel
  );

  ok(read !== undefined, "expected an instruction-count read");
  return read;
}

test("every instruction advances the count channel once, flushed once", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(9)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryActions(block).filter(
    (action): action is StateWriteAction =>
      isStateWrite(action) && action.op.slot === instructionCountChannel
  );

  // Both advances fold onto the block's one count read.
  deepStrictEqual(writes, [
    stateWrite(instructionCountChannel, v.binary("add", instructionCountRead(block).output, v.const(2)))
  ]);
});

test("conditional jump side exit and fallthrough flush the advanced count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const taken = nestedBodyView(block, 1);
  const takenRead = taken.actions.find(
    (action): action is StateReadAction =>
      isStateRead(action) && action.op.slot === instructionCountChannel
  );
  const fallthroughRead = instructionCountRead(block);

  ok(takenRead !== undefined, "expected taken count read");
  strictEqual(
    taken.flushes.find(
      (flush): flush is StateWriteAction =>
        isStateWrite(flush) && flush.op.slot === instructionCountChannel
    )?.op.value,
    v.binary("add", takenRead.output, v.const(1))
  );
  strictEqual(
    rawEntryActions(block).find(
      (action): action is StateWriteAction =>
        isStateWrite(action) && action.op.slot === instructionCountChannel
    )?.op.value,
    v.binary("add", fallthroughRead.output, v.const(1))
  );
});

test("a fault edge restores the boundary count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("eax")],
    loc(0x1005, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;

  // The faulting store's own advance never reaches the edge: it restores the
  // first instruction's count.
  strictEqual(
    nestedBodyView(block, 1).flushes.find(
      (flush): flush is StateWriteAction =>
        isStateWrite(flush) && flush.op.slot === instructionCountChannel
    )?.op.value,
    v.binary("add", instructionCountRead(block).output, v.const(1))
  );
});

test("a host trap flushes the advanced count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(intSemantic(), [immBinding(0x21)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryActions(block).filter(
    (action): action is StateWriteAction =>
      isStateWrite(action) && action.op.slot === instructionCountChannel
  );

  deepStrictEqual(writes, [
    stateWrite(instructionCountChannel, v.binary("add", instructionCountRead(block).output, v.const(1)))
  ]);
});
