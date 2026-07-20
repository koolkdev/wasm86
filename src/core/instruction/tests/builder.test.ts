import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  externalInstructionLocation,
  staticInstructionLocation as loc
} from "#core/instruction/builder.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
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
  segmentDynamicBinding,
  staticMemSegment
} from "#core/instruction/bindings.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "../state/channels.js";
import {
  gprChannel,
  segmentBaseChannel,
} from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import {
  finishControl,
  ifControl,
  type Finish,
  type IfControl,
  type SwitchControl
} from "#compiler/ir/controls/index.js";
import type { BodyNode, Body, IrBlock } from "#ir/block.js";
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
import { int3Semantic, intoSemantic, intSemantic } from "#core/semantics/misc.js";
import { movSemantic, movsxSemantic, movToSregSemantic, movzxSemantic } from "#core/semantics/mov.js";
import { setccSemantic } from "#core/semantics/setcc.js";
import { shiftSemantic } from "#core/semantics/shift.js";
import { popfdSemantic, popfSemantic, popSemantic, pushfdSemantic, pushfSemantic } from "#core/semantics/stack.js";
import { testSemantic as testInstructionSemantic } from "#core/semantics/test.js";
import { xchgSemantic } from "#core/semantics/xchg.js";
import { defaultSegmentForBase, segmentRegisterIndex } from "#core/segments.js";
import type { EffectiveAddress, OperandWidth } from "#core/types.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  exceptionExit as coreExceptionExit,
  segmentExit,
  trapExit as coreTrapExit
} from "#core/exits.js";
import { assertLazyRecord } from "./lazy-flags.js";
import {
  isMemoryRead,
  isMemoryWrite,
  isStatusFlagCall,
  memoryReadOperation,
  memoryWriteOperation,
  resolvedStatusFlag
} from "#ir/tests/storage-op-helpers.js";
import type {
  MemoryReadOperation,
  MemoryWriteOperation,
  StatusFlagCallOperation
} from "#ir/tests/storage-op-helpers.js";
import {
  dynamicGprRead,
  dynamicGprWrite,
  dynamicSegmentRead,
  stateRead,
  stateWrite,
  stateWriteValue,
  isStateRead,
  isStateWrite,
  readsDynamicGpr,
  readsDynamicSegment,
  readsStateChannel,
  writesDynamicGpr,
  writesStateChannel,
  type StateReadOperation,
  type StateWriteOperation
} from "./state-operations.js";

function outputOf(node: BodyNode): ValueId {
  const output = node.outputs[0];

  ok(output !== undefined, `${node.kind} node has no output`);
  return output;
}

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

function guardDsMemory<TIntent extends MemoryDataAccessIntent>(
  s: SemanticOps,
  address: ValueInput,
  byteLength: ValueInput,
  intent: TIntent
): MemoryAccess<TIntent> {
  return s.memory.guard({
    reference: s.memory.reference("ds", address),
    byteLength,
    intent
  });
}

function writeDsMemory(
  s: SemanticOps,
  v: ValueBuilder,
  address: ValueInput,
  value: ValueInput,
  width: OperandWidth
): void {
  const access = guardDsMemory(s, address, v.const(width / 8), "write");

  s.memory.store(access, { byteOffset: v.const(0), value, width });
}

// Every instruction advances the instruction-count field; the dedicated tests at the
// end cover that bookkeeping, the shape tests assert around it.
function isInstructionCountNode(values: ValueTable, node: BodyNode): boolean {
  return readsStateChannel(values, node, instructionCountField) ||
    writesStateChannel(values, node, instructionCountField);
}

function entryNodes(block: IrBlock): readonly BodyNode[] {
  const final = block.body.nodes.at(-1);
  const dispatchTarget = final?.kind === "finish" && final.finish.kind === "dispatch"
    ? final.finish.targetEip
    : undefined;

  return rawEntryNodes(block).filter((node) =>
    !isInstructionCountNode(block.values, node) &&
    !(dispatchTarget !== undefined &&
      writesStateChannel(block.values, node, coreStateFields.eip) &&
      stateWriteValue(node) === dispatchTarget)
  );
}

function rawEntryNodes(block: IrBlock): readonly BodyNode[] {
  return block.body.nodes;
}

type TerminatingBodyView = Readonly<{
  nodes: readonly BodyNode[];
  flushes: readonly StateWriteOperation[];
  terminator: Finish;
}>;

function nestedBodies(block: IrBlock): readonly Body[] {
  const bodies: Body[] = [];

  function collect(body: Body): void {
    for (const node of body.nodes) {
      for (const nested of node.nestedBodies) {
        bodies.push(nested.body);
        collect(nested.body);
      }
    }
  }

  collect(block.body);
  return bodies;
}

function nestedBodyView(block: IrBlock, index: number): TerminatingBodyView {
  const body = nestedBodies(block).filter(
    (nested) => nested.nodes.at(-1)?.kind === "finish"
  )[index - 1];

  ok(body !== undefined, `nested body ${index} exists`);

  const terminator = body.nodes[body.nodes.length - 1];

  ok(terminator !== undefined && terminator.kind === "finish", `nested body ${index} ends with a finish`);
  return {
    nodes: body.nodes,
    flushes: body.nodes.slice(0, -1).filter(
      isStateWrite
    ),
    terminator: terminator.finish
  };
}

function nestedBodyFlushes(block: IrBlock, index: number): StateWriteOperation[] {
  return nestedBodyView(block, index).flushes.filter(
    (flush) => !isInstructionCountNode(block.values, flush)
  );
}

function nestedBodyWriteFlushes(block: IrBlock, index: number): StateWriteOperation[] {
  return nestedBodyFlushes(block, index);
}

function memoryGuard(
  block: IrBlock,
  faultBodyIndex: number,
  _address: ValueId,
  _byteLength: number,
  _access: MemoryDataAccessIntent
): readonly [IfControl] {
  const thenBody = nestedBodies(block)[faultBodyIndex - 1];

  ok(thenBody !== undefined, `fault body ${faultBodyIndex} exists`);

  const faultIf = entryNodes(block).find(
    (node): node is IfControl => node.kind === "if" && node.thenBody === thenBody
  );

  ok(faultIf !== undefined, `fault if ${faultBodyIndex} exists`);

  return [ifControl.create({
    condition: faultIf.condition,
    hint: "unlikely",
    thenBody
  })];
}

function finishDispatch(targetEip: ValueId): BodyNode {
  return finishControl.create({
    finish: { kind: "dispatch", targetEip }
  });
}

function finishTrap(values: ValueTable, vector: ValueId): BodyNode {
  return finishControl.create({ finish: trapExit(values, vector) });
}

function trapExit(values: ValueTable, vector: ValueId): Finish {
  return {
    kind: "exit",
    result: buildExit(values, coreTrapExit(vector))
  };
}

function finishSegmentLoad(
  values: ValueTable,
  segment: ValueId,
  selector: ValueId
): BodyNode {
  return finishControl.create({
    finish: {
      kind: "exit",
      result: buildExit(values, segmentExit(segment, selector))
    }
  });
}

function exceptionExit(
  values: ValueTable,
  exception: CpuException<ValueId>
): Finish {
  return {
    kind: "exit",
    result: buildExit(
      values,
      coreExceptionExit(exception)
    )
  };
}

function finishException(
  values: ValueTable,
  exception: CpuException<ValueId>
): BodyNode {
  return finishControl.create({ finish: exceptionExit(values, exception) });
}

function pageFaultStop(
  values: ValueTable,
  access: MemoryDataAccessIntent,
  payload: ValueId
): Finish {
  const errorCode = values.const(
    access === "write" ? PageFaultErrorCode.WRITE : 0
  );

  return exceptionExit(values, pageFault(payload, errorCode));
}

function stateWrites(block: IrBlock): StateWriteOperation[] {
  return entryNodes(block).filter(isStateWrite);
}

function stateReads(nodes: readonly BodyNode[]): StateReadOperation[] {
  return nodes.filter(isStateRead);
}

function stateReadFor(
  block: IrBlock,
  nodes: readonly BodyNode[],
  channel: InstructionStateChannel
): StateReadOperation | undefined {
  return nodes.find((node): node is StateReadOperation =>
    readsStateChannel(block.values, node, channel)
  );
}

function stateWriteFor(
  block: IrBlock,
  writes: readonly StateWriteOperation[],
  channel: InstructionStateChannel
): StateWriteOperation | undefined {
  return writes.find((write) =>
    writesStateChannel(block.values, write, channel)
  );
}

function stateReadFlag(
  values: ValueTable,
  node: BodyNode
): X86Flag | undefined {
  return x86Flags.find((flag) =>
    readsStateChannel(values, node, flagStateFields.concrete[flag])
  );
}

function stateWriteFlag(
  values: ValueTable,
  node: BodyNode
): X86Flag | undefined {
  return x86Flags.find((flag) =>
    writesStateChannel(values, node, flagStateFields.concrete[flag])
  );
}

function ifNode(block: IrBlock): IfControl {
  const node = entryNodes(block).find((entry): entry is IfControl => entry.kind === "if");

  ok(node !== undefined, "expected if control");
  return node;
}

function switchNode(block: IrBlock): SwitchControl {
  const node = entryNodes(block).find((entry): entry is SwitchControl => entry.kind === "switch");

  ok(node !== undefined, "expected switch control");
  return node;
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
  return stateWrites(block).flatMap((write) => {
    const flag = stateWriteFlag(block.values, write);

    return flag === undefined
      ? []
      : [{ flag, value: stateWriteValue(write) }];
  });
}

function flagWriteValue(block: IrBlock, flag: X86StatusFlag): ValueId {
  const writes = flagWriteEntries(block).filter((write) => write.flag === flag);

  strictEqual(writes.length, 1, `expected exactly one ${flag} write`);
  return writes[0]!.value;
}

function statusFlagCallFor(block: IrBlock, flag: X86StatusFlag): StatusFlagCallOperation {
  const operation = entryNodes(block).find(
    (node): node is StatusFlagCallOperation =>
      isStatusFlagCall(node) && resolvedStatusFlag(node) === flag
  );

  ok(operation !== undefined, `expected ${flag} resolver call`);
  return operation;
}

function resolvedStatusFlags(nodes: readonly BodyNode[]): readonly X86StatusFlag[] {
  return nodes.filter(isStatusFlagCall).map(resolvedStatusFlag);
}

function assertResolvedStatusFlag(block: IrBlock, id: ValueId, flag: X86StatusFlag): void {
  strictEqual(outputOf(statusFlagCallFor(block, flag)), id);
  deepStrictEqual(block.values.node(id), { kind: "nodeOutput", type: "i32" });
}

test("mov r32, imm32 flushes the register write and dispatches at the next eip", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const block = builder.finish();
  const v = block.values;

  strictEqual(nestedBodies(block).length, 0);

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x12345678)),
    finishDispatch(v.const(0x401005))
  ]);
  deepStrictEqual(v.node(v.const(0x12345678)), { kind: "const", value: 0x12345678 });
  // The instruction-start eip, immediate, next eip, and count advance.
  strictEqual(v.size(), 7);
});

test("pending writes overwrite per channel and consts deduplicate across instructions", () => {
  const builder = createLegacyInstructionBlock();
  const mov = movSemantic(32);

  builder.add(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.add(mov, [regBinding("ecx"), immBinding(7)], loc(0x1005, 0x100a));
  builder.add(mov, [regBinding("eax"), immBinding(9)], loc(0x100a, 0x100f));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateWrite(block.values, gprChannel("eax"), block.values.const(9)),
    stateWrite(block.values, gprChannel("ecx"), block.values.const(7)),
    finishDispatch(block.values.const(0x100f))
  ]);

  // 7, 9, the four eip constants, and the count read with its three folded
  // advances — both movs of 7 share one const.
  strictEqual(block.values.size(), 14);
});

test("mov r32, r32 records one execution-state resource read and forwards its leaf", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateRead(v, 2, gprChannel("eax")),
    stateWrite(v, gprChannel("ebx"), 2),
    finishDispatch(v.const(0x1002))
  ]);
  deepStrictEqual(v.node(valueId(2)), { kind: "nodeOutput", type: "i32" });
  // The instruction-start eip, read leaf, next eip, and count advance.
  strictEqual(v.size(), 7);
});

test("repeated get of an unwritten channel returns the same leaf across instructions", () => {
  const builder = createLegacyInstructionBlock();
  const mov = movSemantic(32);

  builder.add(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.add(mov, [regBinding("ecx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, 2, gprChannel("eax")),
    stateWrite(block.values, gprChannel("ebx"), 2),
    stateWrite(block.values, gprChannel("ecx"), 2),
    finishDispatch(block.values.const(0x1004))
  ]);
});

test("add eax, imm32 commits a lazy add record and writes the register", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const eax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);
  const sum = v.binary("add", eax, v.const(5));
  const writes = stateWrites(block);

  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(
    stateWriteValue(stateWriteFor(block, writes, gprChannel("eax"))!),
    sum
  );
});

test("two adds in one block flush one lazy add record, second instruction wins", () => {
  const builder = createLegacyInstructionBlock();
  const add = aluSemantic("add", 32);

  builder.add(add, [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(add, [regBinding("eax"), immBinding(7)], loc(0x1003, 0x1006));

  const block = builder.finish();
  const nodes = entryNodes(block);
  const writes = stateWrites(block);
  const v = block.values;

  // One read feeds both adds; the final add source is the only lazy flag image
  // flushed, plus eax and the completed EIP.
  strictEqual(stateReads(nodes).length, 1);
  strictEqual(writes.length, 4);
  strictEqual(writes.filter((write) => stateWriteFlag(v, write) !== undefined).length, 0);

  const eax = outputOf(stateReadFor(block, nodes, gprChannel("eax"))!);
  const sum1 = v.binary("add", eax, v.const(5));
  const sum2 = v.binary("add", sum1, v.const(7));

  strictEqual(
    stateWriteValue(stateWriteFor(block, writes, gprChannel("eax"))!),
    sum2
  );
  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: sum1, right: v.const(7) });
});

test("inc flushes a full explicit image with CF preserved through a resolver call", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(unaryAluSemantic("inc", 32), [regBinding("eax")], loc(0x1000, 0x1001));

  const block = builder.finish();

  deepStrictEqual(
    resolvedStatusFlags(entryNodes(block)),
    x86StatusFlags
  );
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  assertResolvedStatusFlag(block, flagWriteValue(block, "CF"), "CF");
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), flagStateFields.lazyKind)!),
    block.values.const(0)
  );
});

test("cmp commits a lazy sub record but no register or explicit flags", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const writes = stateWrites(block);
  const reads = stateReads(entryNodes(block));

  assertLazyRecord(writes, block.values, { kind: "SUB", width: 32, left: outputOf(reads[0]!), right: outputOf(reads[1]!) });
  strictEqual(writes.length, 3);
  strictEqual(stateWriteFor(block, writes, coreStateFields.eip), undefined);
  deepStrictEqual(entryNodes(block).at(-1), finishDispatch(block.values.const(0x1002)));
});

test("zero-count shift writes neither the destination nor flags", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(shiftSemantic("shr", 32, "imm8"), [regBinding("eax"), immBinding(0)], loc(0x1000, 0x1003));

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
  const builder = createLegacyInstructionBlock();

  builder.add(directZfTemplate, [], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  strictEqual(flagWriteValue(block, "ZF"), block.values.const(1));

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    assertResolvedStatusFlag(block, flagWriteValue(block, flag), flag);
  }
  deepStrictEqual(
    resolvedStatusFlags(entryNodes(block)),
    x86StatusFlags
  );

  strictEqual(
    stateWriteValue(
      stateWriteFor(block, stateWrites(block), flagStateFields.lazyKind)!
    ),
    block.values.const(0)
  );
});

test("an omitted direct flag write preserves the previous instruction's pending flag", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(directZfTemplate, [], loc(0x1003, 0x1005));

  const block = builder.finish();

  // The second instruction does not touch AF, so the add's AF expression
  // survives and flushes.
  const v = block.values;
  const a = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);
  const b = v.const(5);
  const result = v.binary("add", a, b);
  const carryChain = v.binary("xor", v.binary("xor", a, b), result);
  const af = v.binary("and", v.binary("shr_u", carryChain, v.const(4)), v.const(1));

  strictEqual(flagWriteValue(block, "AF"), af);

  // The second instruction's constant ZF write wins over the add's expression.
  strictEqual(flagWriteValue(block, "ZF"), v.const(1));
});

test("xchg eax, ebx swaps pendings through two reads with no temporaries", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, 2, gprChannel("eax")),
    stateRead(block.values, 3, gprChannel("ebx")),
    stateWrite(block.values, gprChannel("ebx"), 2),
    stateWrite(block.values, gprChannel("eax"), 3),
    finishDispatch(block.values.const(0x1002))
  ]);

  // The instruction-start eip, two read leaves, next eip, and count advance — no
  // temporaries were created.
  strictEqual(block.values.size(), 8);
});

test("mov r8, r8 reads and writes byte channels with no bit algebra", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, 2, gprChannel("ah")),
    stateWrite(block.values, gprChannel("bl"), 2),
    finishDispatch(block.values.const(0x1002))
  ]);
  // The instruction-start eip, read leaf, next eip, and count advance — no
  // masks or shifts were created.
  strictEqual(block.values.size(), 7);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("al"), v.const(0x12)),
    stateRead(v, 7, gprChannel("eax")),
    stateWrite(v, gprChannel("ebx"), 7),
    finishDispatch(v.const(0x1004))
  ]);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.add(movSemantic(8), [regBinding("bl"), regBinding("al")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x12345678)),
    stateRead(v, 7, gprChannel("al")),
    stateWrite(v, gprChannel("bl"), 7),
    finishDispatch(v.const(0x1007))
  ]);
});

test("write al then write eax drops the byte pending with no flush", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1002, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x12345678)),
    finishDispatch(v.const(0x1007))
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.add(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const nodes = entryNodes(block);

  strictEqual(isStateWrite(nodes[0]!), true);
  deepStrictEqual(nodes[1], stateRead(block.values, 7, gprChannel("ah")));
});

test("ax and al pendings mix without touching flag pendings", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.add(movSemantic(8), [regBinding("ah"), immBinding(0x12)], loc(0x1002, 0x1004));
  builder.add(movSemantic(16), [regBinding("cx"), regBinding("ax")], loc(0x1004, 0x1007));

  const block = builder.finish();
  const nodes = entryNodes(block);
  const indexOf = (predicate: (node: (typeof nodes)[number]) => boolean) =>
    nodes.findIndex(predicate);

  // al and ah are disjoint, so both stay pending until the ax read flushes
  // them; the lazy flag record rides through it all and flushes once at the end.
  const alFlush = indexOf((a) => writesStateChannel(block.values, a, gprChannel("al")));
  const ahFlush = indexOf((a) => writesStateChannel(block.values, a, gprChannel("ah")));
  const axRead = indexOf((a) => readsStateChannel(block.values, a, gprChannel("ax")));
  const lazyKindFlush = indexOf((a) =>
    writesStateChannel(block.values, a, flagStateFields.lazyKind)
  );

  ok(alFlush !== -1 && ahFlush !== -1 && axRead !== -1, "expected al/ah flushes and an ax read");
  ok(alFlush < axRead && ahFlush < axRead, "the ax read must flush al and ah first");
  ok(axRead < lazyKindFlush, "lazy flag flush stays at the end of the block");
  deepStrictEqual([...writtenFlags(block)], []);

  // The flushed al carries the add's truncated result.
  const v = block.values;
  const reads = stateReads(nodes);
  const sum = v.truncate(8, v.binary("add", outputOf(reads[0]!), outputOf(reads[1]!)));

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    sum
  );
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 8, left: outputOf(reads[0]!), right: outputOf(reads[1]!) });
});

test("movzx r32, r8 forwards the unsigned byte read unmasked", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, 2, gprChannel("al")),
    stateWrite(block.values, gprChannel("ebx"), 2),
    finishDispatch(block.values.const(0x1003))
  ]);
  strictEqual(block.values.size(), 7);
});

test("movsx r32, r8 marks the read for a sign-extending load", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, 2, gprChannel("al"), true),
    stateWrite(block.values, gprChannel("ebx"), 2),
    finishDispatch(block.values.const(0x1003))
  ]);
  strictEqual(block.values.size(), 7);
});

test("narrow signed compares sign-extend both operands", () => {
  const cmp8: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.compare(8, "lt_s", s.read(s.operand(0), { width: 32 }), s.read(s.operand(1), { width: 32 })), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(cmp8, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const compare = v.compare(32,
    "lt_s",
    v.extend(8, outputOf(reads[0]!), true),
    v.extend(8, outputOf(reads[1]!), true)
  );

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    compare
  );
});

test("an 8-bit unsigned compare of covered operands creates no truncations", () => {
  const cmpAl: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.compare(8, "lt_u", s.read(s.operand(0), { width: 8 }), s.read(s.operand(1), { width: 8 })), { width: 8 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(cmpAl, [regBinding("al"), immBinding(5)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  // The al read fits unsigned 8 and the constant fits by value, so the
  // compare uses the raw operands.
  const al = outputOf(stateReadFor(block, entryNodes(block), gprChannel("al"))!);

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    v.compare(32, "lt_u", al, v.const(5))
  );
  ok(!nodeKinds(block).includes("truncate"), "no truncations expected");
});

test("an 8-bit equality on an unproven value keeps its mask", () => {
  const cmpSum: SemanticTemplate = (s, v) => {
    const sum = v.binary("add", s.read(s.operand(0), { width: 8 }), s.read(s.operand(1), { width: 8 }));

    s.write(s.operand(0), v.compare(8, "eq", sum, v.const(0)), { width: 8 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSum, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const sum = v.binary("add", outputOf(reads[0]!), outputOf(reads[1]!));

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    v.compare(32, "eq", v.truncate(8, sum), v.const(0))
  );
});

test("a signed byte get feeds a signed compare with no extra extends", () => {
  const cmpSigned: SemanticTemplate = (s, v) => {
    const a = s.read(s.operand(0), { width: 8, signed: true });
    const b = s.read(s.operand(1), { width: 8, signed: true });

    s.write(s.operand(0), v.compare(8, "lt_s", a, b), { width: 8 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSigned, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const nodes = entryNodes(block);
  const reads = stateReads(nodes);

  deepStrictEqual(nodes[0], stateRead(block.values, outputOf(reads[0]!), gprChannel("al"), true));
  deepStrictEqual(nodes[1], stateRead(block.values, outputOf(reads[1]!), gprChannel("bl"), true));
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    block.values.compare(32, "lt_s", outputOf(reads[0]!), outputOf(reads[1]!))
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("value methods build through the builder", () => {
  const abs: SemanticTemplate = (s, v) => {
    const value = s.read(s.operand(0), { width: 32 });
    const zero = v.const(0);
    const negative = v.compare(32, "lt_s", value, zero);

    s.write(s.operand(0), v.select(negative, v.binary("sub", zero, value), value), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(abs, [regBinding("eax")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const read = stateReadFor(block, entryNodes(block), gprChannel("eax"))!;
  const zero = block.values.const(0);
  const compare = block.values.compare(32, "lt_s", outputOf(read), zero);
  const negated = block.values.binary("sub", zero, outputOf(read));
  const selected = block.values.select(compare, negated, outputOf(read));

  deepStrictEqual(entryNodes(block), [
    stateRead(block.values, outputOf(read), gprChannel("eax")),
    stateWrite(block.values, gprChannel("eax"), selected),
    finishDispatch(block.values.const(0x1003))
  ]);
  deepStrictEqual(block.values.node(compare), { kind: "compare", type: "i32", operator: "lt_s", a: outputOf(read), b: zero });
  deepStrictEqual(block.values.node(negated), { kind: "binary", type: "i32", operator: "sub", a: zero, b: outputOf(read) });
  deepStrictEqual(block.values.node(selected), { kind: "select", condition: compare, whenTrue: negated, whenFalse: outputOf(read) });
});

test("jmp dispatches at the target", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [
    finishDispatch(block.values.const(0x2000))
  ]);
});

test("16-bit jmp truncates the target before dispatch", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(jmpSemantic(16), [immBinding(0x1234_2000)], loc(0x1000, 0x1004));

  const block = builder.finish();
  const target = block.values.const(0x2000);

  deepStrictEqual(entryNodes(block), [
    finishDispatch(target)
  ]);
});

test("16-bit call pushes a word return address and dispatches to a word target", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(callSemantic(16), [regBinding("ax")], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const ax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ax"))!);
  const nextEsp = v.binary("sub", esp, v.const(2));

  deepStrictEqual(entryNodes(block), [
    stateRead(v, ax, gprChannel("ax")),
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, nextEsp, 2, "write"),
    memoryWriteOperation(nextEsp, v.const(0x1004), 16),
    stateWrite(v, gprChannel("esp"), nextEsp),
    finishDispatch(ax)
  ]);
});

test("a jump flushes earlier pendings and dispatches at the target eip", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(jmpSemantic(), [immBinding(0x2000)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x77)),
    finishDispatch(v.const(0x2000))
  ]);
});

test("a block ended by a jump rejects further instructions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  throws(
    () =>
      builder.add(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1005, 0x100a)),
    /after a block terminator/
  );
});

test("a root CPU exception exits at the faulting instruction", () => {
  const exception = invalidOpcode();
  const fault: SemanticTemplate = (s) => {
    s.cpuException(exception);
  };
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(fault, [], loc(0x1005, 0x1006));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x77)),
    stateWrite(v, coreStateFields.eip, v.const(0x1005)),
    finishException(v, exception)
  ]);
  strictEqual(stateWriteFor(block, stateWrites(block), instructionCountField), undefined);
});

test("a terminal finish stops the remaining semantic body", () => {
  const trapThenSet: SemanticTemplate = (s, v) => {
    s.hostTrap(v.const(3));
    writeDsMemory(s, v, v.const(0x2000), v.const(1), 32);
  };
  const builder = createLegacyInstructionBlock();

  builder.add(trapThenSet, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryNodes(block).some((node) => isMemoryWrite(node)), false);
  deepStrictEqual(
    entryNodes(block).at(-1),
    finishTrap(block.values, block.values.const(3))
  );
});

test("a dispatch stops a later terminator in the same semantic body", () => {
  const jumpThenTrap: SemanticTemplate = (s, v) => {
    s.jump(v.const(0x2000));
    s.hostTrap(v.const(3));
  };
  const builder = createLegacyInstructionBlock();

  builder.add(jumpThenTrap, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  deepStrictEqual(entryNodes(block), [finishDispatch(block.values.const(0x2000))]);
});

test("a semantic if body terminates only its taken arm", () => {
  const jumpInIf: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (then) => {
      then.jump(v.const(0x2000));
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(jumpInIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  deepStrictEqual(rawEntryNodes(block)[rawEntryNodes(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a constant-false semantic if is not emitted or built", () => {
  const skippedIf: SemanticTemplate = (s, v) => {
    s.if(v.const(0), () => {
      throw new Error("constant-false if body should not be built");
    });
    s.write(s.reg("eax"), v.const(7), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(skippedIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(entryNodes(block).some((node) => node.kind === "if"), false);
  strictEqual(nestedBodies(block).length, 0);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    block.values.const(7)
  );
});

test("a constant-false semantic if builds only its else arm in the containing scope", () => {
  const selectElse: SemanticTemplate = (s, v) => {
    s.ifElse(v.const(0), () => {
      throw new Error("constant-false then body should not be built");
    }, (otherwise) => otherwise.write(otherwise.reg("eax"), v.const(7), { width: 32 }));
    s.write(s.reg("ebx"), s.read(s.reg("eax"), { width: 32 }), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(selectElse, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryNodes(block).some((node) => node.kind === "if"), false);
  strictEqual(nestedBodies(block).length, 0);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    block.values.const(7)
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    block.values.const(7)
  );
});

test("a dynamic semantic ifElse emits both arms", () => {
  const selectRegister: SemanticTemplate = (s, v) => {
    s.ifElse(s.read(s.reg("eax"), { width: 32 }), (then) => {
      then.write(then.reg("ebx"), v.const(1), { width: 32 });
    }, (otherwise) => otherwise.write(otherwise.reg("ebx"), v.const(2), { width: 32 }), "likely");
    s.write(s.reg("ecx"), s.read(s.reg("ebx"), { width: 32 }), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(selectRegister, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifNode(block);
  const ebxAfterJoin = stateReadFor(block, entryNodes(block), gprChannel("ebx"));

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  strictEqual(branch.hint, "likely");
  deepStrictEqual(branch.thenBody.nodes, [
    stateWrite(block.values, gprChannel("ebx"), block.values.const(1))
  ]);
  deepStrictEqual(branch.elseBody.nodes, [
    stateWrite(block.values, gprChannel("ebx"), block.values.const(2))
  ]);
  ok(ebxAfterJoin !== undefined, "joined ebx is read after the branch");
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ecx"))!),
    outputOf(ebxAfterJoin)
  );
});

test("ifElse arms reconcile sibling writes with dirty parent state", () => {
  const reconcileParent: SemanticTemplate = (s, v) => {
    s.write(s.reg("eax"), v.const(10), { width: 32 });
    s.write(s.reg("ebx"), v.const(20), { width: 32 });
    s.ifElse(s.read(s.reg("ecx"), { width: 32 }), (then) => {
      then.write(then.reg("eax"), v.const(1), { width: 32 });
    }, (otherwise) => otherwise.write(otherwise.reg("ebx"), v.const(2), { width: 32 }));
  };
  const builder = createLegacyInstructionBlock();

  builder.add(reconcileParent, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifNode(block);

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  deepStrictEqual(branch.thenBody.nodes, [
    stateWrite(block.values, gprChannel("eax"), block.values.const(1)),
    stateWrite(block.values, gprChannel("ebx"), block.values.const(20))
  ]);
  deepStrictEqual(branch.elseBody.nodes, [
    stateWrite(block.values, gprChannel("ebx"), block.values.const(2)),
    stateWrite(block.values, gprChannel("eax"), block.values.const(10))
  ]);
});

test("a sibling exception is isolated from a continuing memory-write arm", () => {
  const storeOrFault: SemanticTemplate = (s, v) => {
    const access = guardDsMemory(s, v.const(0x2000), v.const(4), "write");

    s.ifElse(s.read(s.reg("eax"), { width: 32 }), (then) => {
      then.memory.store(access, {
        byteOffset: v.const(0),
        value: v.const(1),
        width: 32
      });
    }, (otherwise) => otherwise.cpuException(invalidOpcode()));
  };
  const builder = createLegacyInstructionBlock();

  builder.add(storeOrFault, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifNode(block);

  validateIrBlock(block);
  ok(branch.elseBody !== undefined, "dynamic branch has an explicit else body");
  strictEqual(branch.thenBody.nodes.some((node) => isMemoryWrite(node)), true);
  strictEqual(branch.elseBody.nodes.some((node) => isMemoryWrite(node)), false);
  const exceptionTerminator = branch.elseBody.nodes.at(-1);

  ok(exceptionTerminator?.kind === "finish", "exception arm ends with a finish");
  deepStrictEqual(
    exceptionTerminator.finish,
    exceptionExit(block.values, invalidOpcode())
  );
  strictEqual(entryNodes(block).some((node) => isMemoryWrite(node)), false);
  deepStrictEqual(entryNodes(block).at(-1), finishDispatch(block.values.const(0x1005)));
});

test("an ifElse with two completing arms completes the root semantic path", () => {
  const trapEitherWay: SemanticTemplate = (s, v) => {
    s.ifElse(
      s.read(s.reg("eax"), { width: 32 }),
      (then) => then.hostTrap(v.const(1)),
      (otherwise) => otherwise.hostTrap(v.const(2))
    );
    s.write(s.reg("ebx"), v.const(7), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  const continues = builder.add(trapEitherWay, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const branch = ifNode(block);

  validateIrBlock(block);
  strictEqual(continues, false);
  ok(branch.elseBody !== undefined, "completing branch has an else body");
  deepStrictEqual(
    branch.thenBody.nodes.at(-1),
    finishTrap(block.values, block.values.const(1))
  );
  deepStrictEqual(
    branch.elseBody.nodes.at(-1),
    finishTrap(block.values, block.values.const(2))
  );
  strictEqual(
    stateWriteFor(block, stateWrites(block), gprChannel("ebx")) !== undefined,
    false
  );
  strictEqual(rawEntryNodes(block).at(-1), branch);
});

test("a completing nested ifElse stops only its containing arm", () => {
  const nestedDispatch: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (outer) => {
      outer.ifElse(
        outer.read(outer.reg("ebx"), { width: 32 }),
        (then) => then.jump(v.const(0x2000)),
        (otherwise) => otherwise.jump(v.const(0x3000))
      );
      writeDsMemory(outer, v, v.const(0x4000), v.const(1), 32);
    });
    s.write(s.reg("ecx"), v.const(9), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(nestedDispatch, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(entryNodes(block).some((node) => isMemoryWrite(node)), false);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ecx"))!),
    block.values.const(9)
  );
  deepStrictEqual(rawEntryNodes(block).at(-1), finishDispatch(block.values.const(0x1005)));
});

test("a constant-true semantic if builds its arm in the containing scope", () => {
  const inlinedIf: SemanticTemplate = (s, v) => {
    const sourceAddress = v.const(0x2000);
    const armAddress = v.const(0x3000);
    const parentAddress = v.const(0x4000);
    const source = guardDsMemory(s, sourceAddress, v.const(4), "read");
    const arm = guardDsMemory(s, armAddress, v.const(4), "write");
    const parent = guardDsMemory(s, parentAddress, v.const(4), "write");

    s.if(v.const(1), (then) => {
      then.write(
        then.reg("eax"),
        then.memory.load(source, { byteOffset: v.const(0), width: 32 }),
        { width: 32 }
      );
      then.memory.store(arm, {
        byteOffset: v.const(0),
        value: v.const(1),
        width: 32
      });
    });
    s.memory.store(parent, {
      byteOffset: v.const(0),
      value: s.read(s.reg("eax"), { width: 32 }),
      width: 32
    });
    s.write(s.reg("ebx"), s.read(s.reg("eax"), { width: 32 }), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(inlinedIf, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const load = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  );
  const stores = entryNodes(block).filter(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  );

  validateIrBlock(block);
  ok(load !== undefined, "constant arm memory read exists");
  strictEqual(nestedBodies(block).length, 0);
  strictEqual(load.inputs[0]!.value, block.values.const(0x2000));
  deepStrictEqual(stores.map((store) => [store.inputs[0]!.value, store.inputs[1]!.value]), [
    [block.values.const(0x3000), block.values.const(1)],
    [block.values.const(0x4000), outputOf(load)]
  ]);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    outputOf(load)
  );
  // The arm's write stays a parent pending: the read after the if sees it
  // without a join commit and re-read.
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    outputOf(load)
  );
});

test("a constant-true semantic if with a completing arm stops its containing flow", () => {
  const jumpThenStore: SemanticTemplate = (s, v) => {
    s.if(v.const(1), (then) => then.jump(v.const(0x2000)));
    writeDsMemory(s, v, v.const(0x3000), v.const(7), 32);
  };
  const builder = createLegacyInstructionBlock();

  const continues = builder.add(jumpThenStore, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(continues, false);
  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [finishDispatch(block.values.const(0x2000))]);
});

test("a generic CS operand write requests a segment load without imposing MOV validation", () => {
  const writeSegment: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.const(0x1234), { width: 16 });
  };
  const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

  builder.add(
    writeSegment,
    [segmentBinding("cs")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [
    stateWrite(
      block.values,
      coreStateFields.eip,
      block.values.const(0x1000)
    ),
    finishSegmentLoad(
      block.values,
      block.values.const(segmentRegisterIndex("cs")),
      block.values.const(0x1234)
    )
  ]);
});

test("a constant-true invalid-CS arm stops before building the segment-load tail", () => {
  const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

  builder.add(
    movToSregSemantic(),
    [segmentBinding("cs"), regBinding("ax")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(
    entryNodes(block).some(
      (node) => readsStateChannel(block.values, node, gprChannel("ax"))
    ),
    false
  );
  deepStrictEqual(
    entryNodes(block).at(-1),
    finishException(block.values, invalidOpcode())
  );
});

test("a dynamic MOV-to-segment guards CS before reading its source", () => {
  const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

  builder.add(
    movToSregSemantic(),
    [segmentDynamicBinding(0), regBinding("ax")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);
  const guard = ifNode(block);
  const source = stateReadFor(block, nodes, gprChannel("ax"));

  validateIrBlock(block);
  ok(source !== undefined, "the non-CS path reads the selector source");
  deepStrictEqual(guard, ifControl.create({
    condition: v.compare(
      32,
      "eq",
      v.external(0),
      v.const(segmentRegisterIndex("cs"))
    ),
    hint: "unlikely",
    thenBody: guard.thenBody
  }));
  deepStrictEqual(nestedBodyView(block, 1).terminator, exceptionExit(v, invalidOpcode()));
  deepStrictEqual(nodes, [
    guard,
    stateRead(v, outputOf(source), gprChannel("ax")),
    stateWrite(v, coreStateFields.eip, v.const(0x1000)),
    finishSegmentLoad(v, v.external(0), outputOf(source))
  ]);
});

test("a constant-true completing if stops only its containing dynamic arm", () => {
  const nestedJump: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (then) => {
      then.if(v.const(1), (inner) => inner.jump(v.const(0x2000)));
      writeDsMemory(then, v, v.const(0x3000), v.const(7), 32);
    });
    s.write(s.reg("ebx"), v.const(9), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(nestedJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  strictEqual(entryNodes(block).some((node) => isMemoryWrite(node)), false);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    block.values.const(9)
  );
  deepStrictEqual(rawEntryNodes(block)[rawEntryNodes(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a nested semantic if terminator does not terminate the containing arm", () => {
  const nestedJump: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (then) => {
      then.if(then.read(then.reg("ebx"), { width: 32 }), (inner) => {
        inner.jump(v.const(0x2000));
      });
      then.jump(v.const(0x3000));
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(nestedJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(nestedBodies(block).length, 2);
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: block.values.const(0x3000) });
  deepStrictEqual(nestedBodyView(block, 2).terminator, { kind: "dispatch", targetEip: block.values.const(0x2000) });
  deepStrictEqual(rawEntryNodes(block)[rawEntryNodes(block).length - 1], finishDispatch(block.values.const(0x1005)));
});

test("a dynamic if arm cannot leak an operand address into its parent scope", () => {
  const resolveAddressInArm: SemanticTemplate = (s) => {
    const operand = s.operand(0);

    s.if(s.read(s.reg("ecx"), { width: 32 }), (then) => {
      then.address(operand);
    });
    s.write(s.reg("ebx"), s.address(operand), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(
    resolveAddressInArm,
    [mem({ base: "eax", scale: 1, disp: 0 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const parentRead = stateReadFor(block, entryNodes(block), gprChannel("eax"));
  const armRead = stateReadFor(
    block,
    nestedBodies(block)[0]?.nodes ?? [],
    gprChannel("eax")
  );

  validateIrBlock(block);
  ok(parentRead !== undefined, "parent address read exists");
  ok(armRead !== undefined, "arm address read exists");
  ok(outputOf(parentRead) !== outputOf(armRead), "parent recomputes the arm-local address");
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    outputOf(parentRead)
  );
});

test("a loop-local operand address cannot escape into the parent scope", () => {
  const resolveAddressInLoop: SemanticTemplate = (s) => {
    const operand = s.operand(0);

    s.loop((loop, loopValues) => {
      loop.address(operand);
      loop.write(loop.reg("eax"), loopValues.binary("add", loop.read(loop.reg("eax"), { width: 32 }), loopValues.const(1)), { width: 32 });
      return loopValues.const(0);
    });
    s.write(s.reg("ebx"), s.address(operand), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(
    resolveAddressInLoop,
    [mem({ base: "eax", scale: 1, disp: 0 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const eaxReads = entryNodes(block).filter(
    (node): node is StateReadOperation =>
      readsStateChannel(block.values, node, gprChannel("eax"))
  );

  validateIrBlock(block);
  strictEqual(eaxReads.length, 2);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    eaxReads[1] === undefined ? undefined : outputOf(eaxReads[1])
  );
});

test("a segment load inside a loop body fails loudly", () => {
  const segmentLoadInLoop: SemanticTemplate = (s, _v) => {
    s.loop((loop, lv) => {
      loop.write(loop.operand(0), lv.const(1), { width: 16 });
      return lv.const(0);
    });
  };

  throws(
    () => createLegacyInstructionBlock().add(segmentLoadInLoop, [segmentBinding("ds")], loc(0x1000, 0x1005)),
    /segment load inside a loop body/
  );
});

test("a segment update captured outside a loop binds its loop consumer", () => {
  const segmentLoadInLoop: SemanticTemplate = (s, _v) => {
    const destination = s.update(s.operand(0), { width: 16 });

    s.loop((loop, lv) => {
      destination.write(loop, lv.const(1));
      return lv.const(0);
    });
  };

  throws(
    () => createLegacyInstructionBlock().add(
      segmentLoadInLoop,
      [segmentBinding("ds")],
      loc(0x1000, 0x1005)
    ),
    /segment load inside a loop body/
  );
});

test("jcc after cmp source uses the source-derived condition as a side exit", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(jccSemantic("E"), [immBinding(0x2000)], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);
  const eax = outputOf(stateReadFor(block, nodes, gprChannel("eax"))!);
  const branch = ifNode(block);

  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(branch, ifControl.create({
    condition: v.compare(32, "eq", eax, v.const(5)),
    thenBody: branch.thenBody
  }));

  // The taken side exit observes the completed jcc; the root path falls
  // through and flushes the same lazy record only at block end.
  const taken = nestedBodyFlushes(block, 1);

  strictEqual(taken.length, 4);
  assertLazyRecord(taken, v, { kind: "SUB", width: 32, left: eax, right: v.const(5) });
  strictEqual(
    stateWriteValue(stateWriteFor(block, taken, coreStateFields.eip)!),
    v.const(0x2000)
  );
  deepStrictEqual(nestedBodyView(block, 1).terminator, { kind: "dispatch", targetEip: v.const(0x2000) });

  assertLazyRecord(stateWrites(block), v, { kind: "SUB", width: 32, left: eax, right: v.const(5) });
  strictEqual(stateWriteFor(block, stateWrites(block), coreStateFields.eip), undefined);
  deepStrictEqual(nodes[nodes.length - 1], finishDispatch(v.const(0x1005)));
});

test("jcc side exit consumes eip in a terminating state scope and preserves fallthrough state", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(jccSemantic("E"), [immBinding(0x2000)], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const takenFlushes = nestedBodyView(block, 1).flushes;
  const advancedCount = v.binary("add", outputOf(instructionCountRead(block)), v.const(2));

  strictEqual(
    stateWriteValue(stateWriteFor(block, takenFlushes, coreStateFields.eip)!),
    v.const(0x2000)
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, takenFlushes, gprChannel("eax"))!),
    v.const(0x77)
  );
  strictEqual(
    stateWriteValue(
      stateWriteFor(block, takenFlushes, instructionCountField)!
    ),
    advancedCount
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    v.const(0x77)
  );
  deepStrictEqual(rawEntryNodes(block)[rawEntryNodes(block).length - 1], finishDispatch(v.const(0x1007)));
});

test("jcc after test source uses the source-derived condition with no flag byte reads", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(testInstructionSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));
  builder.add(jccSemantic("E"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const result = v.binary("and", outputOf(reads[0]!), outputOf(reads[1]!));

  strictEqual(ifNode(block).condition, v.compare(32, "eq", result, v.const(0)));
  strictEqual(
    entryNodes(block).some((node) => stateReadFlag(v, node) !== undefined),
    false
  );

  for (const flushes of [nestedBodyWriteFlushes(block, 1), stateWrites(block)]) {
    assertLazyRecord(flushes, v, {
      kind: "LOGIC_RESULT",
      width: 32,
      result
    });
  }
});

const subSourceThenJccTemplate: SemanticTemplate = (s, v) => {
  const left = s.read(s.reg("eax"), { width: 32 });
  const right = s.read(s.reg("ebx"), { width: 32 });
  const result = v.binary("sub", left, right);

  s.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  s.if(s.condition("E"), (then) => then.jump(v.const(0x2000)));
};

test("jcc after a sub flag source uses the source-derived condition", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(subSourceThenJccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const reads = stateReads(entryNodes(block));

  strictEqual(ifNode(block).condition, block.values.compare(32, "eq", outputOf(reads[0]!), outputOf(reads[1]!)));
});

test("jcc after 16-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(16), [regBinding("ax"), regBinding("bx")], loc(0x1000, 0x1002));
  builder.add(jccSemantic("L"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const condition = v.compare(32,
    "lt_s",
    v.extend(16, outputOf(reads[0]!), true),
    v.extend(16, outputOf(reads[1]!), true)
  );

  strictEqual(ifNode(block).condition, condition);
  strictEqual(
    entryNodes(block).some((node) => stateReadFlag(v, node) !== undefined),
    false
  );
});

test("jcc after 8-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.add(jccSemantic("GE"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const condition = v.compare(32,
    "ge_s",
    v.extend(8, outputOf(reads[0]!), true),
    v.extend(8, outputOf(reads[1]!), true)
  );

  strictEqual(ifNode(block).condition, condition);
  strictEqual(
    entryNodes(block).some((node) => stateReadFlag(v, node) !== undefined),
    false
  );
});

test("jcc after 16-bit cmp immediate source sign-extends immediates for signed direct conditions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(16), [regBinding("ax"), immBinding(0x8000)], loc(0x1000, 0x1004));
  builder.add(jccSemantic("LE"), [immBinding(0x2000)], loc(0x1004, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const ax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ax"))!);
  const condition = v.compare(32,
    "le_s",
    v.extend(16, ax, true),
    v.const(-0x8000)
  );

  strictEqual(ifNode(block).condition, condition);
  strictEqual(
    entryNodes(block).some((node) => stateReadFlag(v, node) !== undefined),
    false
  );
});

test("int flushes pending state with the resume eip before a host trap exit", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(intSemantic(), [immBinding(0x21)], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x77)),
    stateWrite(v, coreStateFields.eip, v.const(0x1007)),
    finishTrap(v, v.const(0x21))
  ]);
});

test("int3 flushes the constant breakpoint vector as a host trap", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(int3Semantic(), [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, coreStateFields.eip, v.const(0x1001)),
    finishTrap(v, v.const(3))
  ]);
});

test("into emits a completed-path conditional host trap and fallthrough state", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(intoSemantic(), [], loc(0x1005, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const ofRead = outputOf(statusFlagCallFor(block, "OF"));
  const trapIf = ifNode(block);

  deepStrictEqual(trapIf, ifControl.create({
    condition: ofRead,
    hint: "unlikely",
    thenBody: trapIf.thenBody
  }));
  deepStrictEqual(nestedBodyWriteFlushes(block, 1), [
    stateWrite(v, gprChannel("eax"), v.const(0x77)),
    stateWrite(v, coreStateFields.eip, v.const(0x1006))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    trapExit(v, v.const(4))
  );
  deepStrictEqual(stateWrites(block), [
    stateWrite(v, gprChannel("eax"), v.const(0x77))
  ]);
});

test("jecxz and loop branches dispatch through ecx-derived conditions without flag writes", () => {
  const jecxzBuilder = createLegacyInstructionBlock();
  const loopBuilder = createLegacyInstructionBlock();

  jecxzBuilder.add(jecxzSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1002));
  loopBuilder.add(loopSemantic("none"), [immBinding(0x2000)], loc(0x1000, 0x1002));

  const jecxz = jecxzBuilder.finish();
  const loop = loopBuilder.finish();
  const jecxzEcx = outputOf(stateReadFor(jecxz, entryNodes(jecxz), gprChannel("ecx"))!);
  const loopEcx = outputOf(stateReadFor(loop, entryNodes(loop), gprChannel("ecx"))!);
  const decremented = loop.values.binary("sub", loopEcx, loop.values.const(1));

  strictEqual(ifNode(jecxz).condition, jecxz.values.compare(32, "eq", jecxzEcx, jecxz.values.const(0)));
  strictEqual(ifNode(loop).condition, loop.values.compare(32, "ne", decremented, loop.values.const(0)));
  for (const branch of [nestedBodyWriteFlushes(loop, 1), stateWrites(loop)]) {
    strictEqual(
      stateWriteValue(stateWriteFor(loop, branch, gprChannel("ecx"))!),
      decremented
    );
  }
  strictEqual(
    [
      ...entryNodes(jecxz),
      ...entryNodes(loop),
      ...nestedBodyWriteFlushes(jecxz, 1),
      ...nestedBodyWriteFlushes(loop, 1),
      ...stateWrites(jecxz),
      ...stateWrites(loop)
    ].some(
      (node) => stateWriteFlag(loop.values, node) !== undefined ||
        stateWriteFlag(jecxz.values, node) !== undefined
    ),
    false
  );
});

test("flat32 segment set exits through the fault path without segment writes", () => {
  const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

  builder.add(movSemantic(32), [regBinding("ecx"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(movToSregSemantic(), [segmentBinding("ds"), regBinding("ax")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const axRead = stateReadFor(block, entryNodes(block), gprChannel("ax"));
  const ax = axRead === undefined ? undefined : outputOf(axRead);

  ok(ax !== undefined, "expected selector source read");
  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, ax, gprChannel("ax")),
    stateWrite(v, gprChannel("ecx"), v.const(0x77)),
    stateWrite(v, coreStateFields.eip, v.const(0x1005)),
    finishSegmentLoad(v, v.const(segmentRegisterIndex("ds")), ax)
  ]);
  strictEqual(stateWrites(block).length, 2);
});

test("a block ended by a host trap rejects further instructions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(intSemantic(), [immBinding(3)], loc(0x1000, 0x1002));

  throws(
    () =>
      builder.add(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1002, 0x1007)),
    /after a block terminator/
  );
});

test("setcc after cmp source consumes the source-derived condition", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(setccSemantic("B"), [regBinding("al")], loc(0x1003, 0x1006));

  const block = builder.finish();
  const v = block.values;
  // B is derived directly from the cmp source; no flag byte is read.
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const condition = v.compare(32, "lt_u", ebx, v.const(5));

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(stateReads(entryNodes(block)).length, 1);
});

const logicSourceThenSetccTemplate: SemanticTemplate = (s, v) => {
  const left = s.read(s.reg("eax"), { width: 32 });
  const right = s.read(s.reg("ebx"), { width: 32 });
  const result = v.binary("and", left, right);

  s.writeStatusFlagsSource({ kind: "logic", width: 32, result });
  s.write(s.reg("al"), v.select(s.condition("NE"), v.const(1), v.const(0)), { width: 8 });
};

test("setcc after a logic flag source uses the source-derived condition", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(logicSourceThenSetccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const reads = stateReads(entryNodes(block));
  const result = v.binary("and", outputOf(reads[0]!), outputOf(reads[1]!));
  const condition = v.compare(32, "ne", result, v.const(0));

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(
    entryNodes(block).some((node) => stateReadFlag(v, node) !== undefined),
    false
  );
});

test("setcc with no pending flag value builds a lazy condition switch", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(setccSemantic("A"), [regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const conditionSwitch = switchNode(block);

  deepStrictEqual(
    entryNodes(block).flatMap((node) =>
      stateReadFlag(v, node) ?? []
    ),
    []
  );
  strictEqual(entryNodes(block).some((node) => isStatusFlagCall(node)), false);

  const zero = v.const(0);
  const write = stateWriteFor(block, stateWrites(block), gprChannel("al"));

  ok(write !== undefined, "expected setcc to write al");
  const select = v.node(stateWriteValue(write));

  ok(select.kind === "select", "expected setcc to write a select value");
  strictEqual(select.whenTrue, v.const(1));
  strictEqual(select.whenFalse, zero);
  strictEqual(select.condition, outputOf(conditionSwitch));
  strictEqual(conditionSwitch.cases.length, 3);
  strictEqual(
    conditionSwitch.cases.some((switchCase) =>
      switchCase.body.nodes.some((node) => isStatusFlagCall(node))
    ),
    false
  );

  const defaultCalls = conditionSwitch.defaultBody.nodes.filter(isStatusFlagCall);

  deepStrictEqual(defaultCalls.map(resolvedStatusFlag), ["CF", "ZF"]);
});

test("setcc after an intervening add uses the latest source-expanded flag expression", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(aluSemantic("add", 32), [regBinding("ecx"), immBinding(1)], loc(0x1003, 0x1006));
  builder.add(setccSemantic("E"), [regBinding("al")], loc(0x1006, 0x1009));

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);

  // E rebuilds from the add's source-expanded ZF expression; no flag byte load.
  strictEqual(
    nodes.filter((node) => stateReadFlag(v, node) !== undefined).length,
    0
  );

  const ecxRead = outputOf(stateReads(nodes)[1]!);
  const sum = v.binary("add", ecxRead, v.const(1));
  const zf = v.compare(32, "eq", sum, v.const(0));

  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("al"))!),
    v.select(zf, v.const(1), v.const(0))
  );
});

test("pushfd reuses pending arithmetic flags and reads non-arithmetic flags", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1003));
  builder.add(pushfdSemantic(), [], loc(0x1003, 0x1004));

  const block = builder.finish();
  const flagReads = entryNodes(block).flatMap((node) =>
    stateReadFlag(block.values, node) ?? []
  );

  deepStrictEqual(flagReads, ["TF", "DF", "NT", "AC", "ID"]);
  deepStrictEqual([...writtenFlags(block)], []);

  const v = block.values;
  const eax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);

  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(1) });
});

test("pushf reuses pending arithmetic flags and reads only low non-arithmetic flags", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1003));
  builder.add(pushfSemantic(), [], loc(0x1003, 0x1005));

  const block = builder.finish();
  const flagReads = entryNodes(block).flatMap((node) =>
    stateReadFlag(block.values, node) ?? []
  );
  const stackWrite = entryNodes(block).find(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  );

  deepStrictEqual(flagReads, ["TF", "DF", "NT"]);
  deepStrictEqual([...writtenFlags(block)], []);
  ok(stackWrite !== undefined, "expected pushf to write stack memory");
  strictEqual(stackWrite.width, 16);

  const v = block.values;
  const eax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);

  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(1) });
});

test("popfd writes every stored flag from the popped image", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popfdSemantic(), [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);
  const espRead = stateReadFor(block, nodes, gprChannel("esp"));
  const popRead = nodes.find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  );

  ok(espRead !== undefined, "expected popfd to read esp");
  ok(popRead !== undefined, "expected popfd to read stack memory");
  deepStrictEqual(
    resolvedStatusFlags(nodes),
    x86StatusFlags
  );

  const writes = stateWrites(block);
  const flagWrites = flagWriteEntries(block);

  ok(
    writes[0] !== undefined &&
      writesStateChannel(v, writes[0], gprChannel("esp"))
  );
  strictEqual(
    stateWriteValue(writes[0]),
    v.binary("add", outputOf(espRead), v.const(4))
  );
  deepStrictEqual(flagWrites.map((write) => write.flag).sort(), [...x86Flags].sort());
  strictEqual(new Set(flagWrites.map((write) => write.flag)).size, x86Flags.length);

  for (const write of flagWrites) {
    const offset = x86EflagsBitOffset[write.flag];
    const shifted: ValueId = offset === 0
      ? outputOf(popRead)
      : v.binary("shr_u", outputOf(popRead), v.const(offset));

    strictEqual(write.value, v.binary("and", shifted, v.const(1)), write.flag);
  }
});

test("popf writes only stored low-16 modeled flags", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popfSemantic(), [], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);
  const espRead = stateReadFor(block, nodes, gprChannel("esp"));
  const popRead = nodes.find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  );

  ok(espRead !== undefined, "expected popf to read esp");
  ok(popRead !== undefined, "expected popf to read stack memory");
  strictEqual(popRead.width, 16);
  deepStrictEqual(
    resolvedStatusFlags(nodes),
    x86StatusFlags
  );

  const writes = stateWrites(block);
  const flagWrites = flagWriteEntries(block);
  const low16Flags = x86Flags.filter((flag) => x86EflagsBitOffset[flag] < 16);

  ok(
    writes[0] !== undefined &&
      writesStateChannel(v, writes[0], gprChannel("esp"))
  );
  strictEqual(
    stateWriteValue(writes[0]),
    v.binary("add", outputOf(espRead), v.const(2))
  );
  deepStrictEqual(flagWrites.map((write) => write.flag).sort(), [...low16Flags].sort());
  strictEqual(new Set(flagWrites.map((write) => write.flag)).size, low16Flags.length);

  for (const write of flagWrites) {
    const offset = x86EflagsBitOffset[write.flag];
    const shifted: ValueId = offset === 0
      ? outputOf(popRead)
      : v.binary("shr_u", outputOf(popRead), v.const(offset));

    strictEqual(write.value, v.binary("and", shifted, v.const(1)), write.flag);
  }
});

test("writes to immediate operand bindings fail loudly", () => {
  const setImm: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.const(1), { width: 32 });
  };

  for (const binding of [immBinding(0), immExternalBinding(0)]) {
    throws(
      () =>
        createLegacyInstructionBlock().add(
          setImm,
          [binding],
          loc(0x1000, 0x1006)
        ),
      /immediate operand is not writable/
    );
  }
});

test("updates reject immediate operand bindings before returning a handle", () => {
  const updateImm: SemanticTemplate = (s) => {
    s.update(s.operand(0), { width: 32 });
  };

  for (const binding of [immBinding(0), immExternalBinding(0)]) {
    throws(
      () =>
        createLegacyInstructionBlock().add(
          updateImm,
          [binding],
          loc(0x1000, 0x1006)
        ),
      /immediate operand is not writable/
    );
  }
});

test("a template width that disagrees with its register binding fails loudly", () => {
  throws(
    () =>
      createLegacyInstructionBlock().add(
        movSemantic(8),
        [regBinding("eax"), immBinding(1)],
        loc(0x1000, 0x1002)
      ),
    /8-bit set to a 32-bit register channel/
  );
});

test("a failed instruction poisons the builder, discarding its partial pendings", () => {
  const builder = createLegacyInstructionBlock();
  const setThenFail: Parameters<typeof builder.add>[0] = (s, v) => {
    s.write(s.operand(0), v.const(1), { width: 32 });
    s.write(s.operand(1), v.const(2), { width: 32 });
  };

  throws(
    () =>
      builder.add(setThenFail, [regBinding("eax"), immBinding(0)], loc(0x1000, 0x1002)),
    /immediate operand is not writable/
  );
  throws(
    () =>
      builder.add(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1002, 0x1007)),
    /incomplete instruction/
  );
  throws(() => builder.finish(), /incomplete instruction/);
});

test("a builder with no instructions cannot finish", () => {
  throws(() => createLegacyInstructionBlock().finish(), /no instructions were added/);
});

test("missing operand bindings fail loudly", () => {
  throws(
    () =>
      createLegacyInstructionBlock().add(movSemantic(32), [regBinding("eax")], loc(0x1000, 0x1005)),
    /missing operand binding for operand 1/
  );
});

test("a finished builder rejects further use", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1005));
  builder.finish();

  throws(
    () =>
      builder.add(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1005, 0x100a)),
    /finished instruction builder/
  );
  throws(() => builder.finish(), /already finished/);
});

test("mov [ebx+8], eax guards before the store and flushes eip into the fault edge", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = stateReadFor(block, entryNodes(block), gprChannel("eax"))!;
  const ebx = stateReadFor(block, entryNodes(block), gprChannel("ebx"))!;
  const address = v.binary("add", outputOf(ebx), v.const(8));

  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, outputOf(eax), gprChannel("eax")),
    stateRead(v, outputOf(ebx), gprChannel("ebx")),
    ...memoryGuard(block, 1, address, 4, "write"),
    memoryWriteOperation(address, outputOf(eax), 32),
    finishDispatch(v.const(0x1003))
  ]);

  const edge = nestedBodyView(block, 1);

  deepStrictEqual(edge.flushes, [
    stateWrite(v, coreStateFields.eip, v.const(0x1000))
  ]);
  deepStrictEqual(edge.terminator, pageFaultStop(v, "write", address));
});

test("add [ebx], r32 resolves once with a WRITE fault before its read and write", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    aluSemantic("add", 32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("ecx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);

  // One WRITE resolution supplies the access used by both RMW phases (scale 1
  // and disp 0 add no terms).
  const address = outputOf(stateReadFor(block, nodes, gprChannel("ebx"))!);

  const readIndex = nodes.findIndex((node) => isMemoryRead(node));
  const writeIndex = nodes.findIndex((node) => isMemoryWrite(node));
  const lastGuardIndex = nodes.findIndex((node) => node.kind === "if");

  ok(
    lastGuardIndex >= 0 && lastGuardIndex < readIndex && readIndex < writeIndex,
    "guards, then the load, then the store"
  );

  // The store carries the sum of the loaded value and the ecx read.
  const read = nodes[readIndex];

  ok(read !== undefined && isMemoryRead(read), "expected memory read");
  const loaded = outputOf(read);
  const ecx = outputOf(stateReadFor(block, nodes, gprChannel("ecx"))!);

  deepStrictEqual(nodes[writeIndex], memoryWriteOperation(address, v.binary("add", loaded, ecx), 32));

  // The WRITE validity branch owns the only edge and reports a write PF.
  const eipFlushes = [stateWrite(v, coreStateFields.eip, v.const(0x1000))];

  deepStrictEqual(nestedBodyView(block, 1).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "write", address));
});

test("a later guard's edge flushes earlier pendings with the faulting eip", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1003, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);
  const sum = v.binary("add", eax, v.const(5));
  const ebxRead = stateReadFor(block, entryNodes(block), gprChannel("ebx"))!;
  const address = v.binary("add", outputOf(ebxRead), v.const(8));

  strictEqual(nestedBodies(block).length, 1);

  // The edge snapshots everything dirty at the guard: the add's lazy flag
  // record, eax sum, and the faulting instruction's eip.
  const flushes = nestedBodyFlushes(block, 1);

  strictEqual(flushes.length, 5);
  deepStrictEqual(flushes.flatMap((flush) => stateWriteFlag(v, flush) ?? []), []);
  assertLazyRecord(flushes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(
    stateWriteValue(
      stateWriteFor(block, nestedBodyWriteFlushes(block, 1), gprChannel("eax"))!
    ),
    sum
  );
  strictEqual(
    stateWriteValue(
      stateWriteFor(block, nestedBodyWriteFlushes(block, 1), coreStateFields.eip)!
    ),
    v.const(0x1003)
  );
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "write", address));

  // The edge flush leaves the main-path map untouched: the entry still
  // stores the sum and the store's value is the pending sum, not a reload.
  const mainWrites = stateWrites(block);

  strictEqual(
    stateWriteValue(stateWriteFor(block, mainWrites, gprChannel("eax"))!),
    sum
  );
  strictEqual(stateWriteFor(block, mainWrites, coreStateFields.eip), undefined);
  deepStrictEqual(entryNodes(block).at(-1), finishDispatch(v.const(0x1006)));

  const store = entryNodes(block).find(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  )!;

  strictEqual(store.inputs[1]!.value, sum);
});

test("lea builds general modrm addresses from channel reads", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    leaSemantic(32),
    [regBinding("eax"), mem({ base: "ebx", index: "esi", scale: 4, disp: 0x10 })],
    loc(0x1000, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;
  // base + (index << 2) + disp, with no guard and no memory access.
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const esi = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esi"))!);
  const scaled = v.binary("shl", esi, v.const(2));
  const address = v.binary("add", v.binary("add", ebx, scaled), v.const(0x10));

  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, ebx, gprChannel("ebx")),
    stateRead(v, esi, gprChannel("esi")),
    stateWrite(v, gprChannel("eax"), address),
    finishDispatch(v.const(0x1007))
  ]);
});

test("lea uses the effective offset without adding segment bases", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    leaSemantic(32),
    [regBinding("eax"), mem({ segment: "fs", base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1004)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  deepStrictEqual(entryNodes(block), [
    stateRead(v, ebx, gprChannel("ebx")),
    stateWrite(v, gprChannel("eax"), ebx),
    finishDispatch(v.const(0x1004))
  ]);
});

test("flat segment memory operands use the effective offset directly", () => {
  for (const segment of ["cs", "ds", "es", "ss"] as const) {
    const builder = createLegacyInstructionBlock();

    builder.add(
      movSemantic(32),
      [regBinding("eax"), mem({ segment, base: "ebx", scale: 1, disp: 0 })],
      loc(0x1000, 0x1003)
    );

    const block = builder.finish();
    const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
    const read = entryNodes(block).find(
      (node): node is MemoryReadOperation => isMemoryRead(node)
    )!;

    strictEqual(read.inputs[0]!.value, ebx, segment);
    strictEqual(
      entryNodes(block).some((node) =>
        readsStateChannel(block.values, node, segmentBaseChannel(segment))
      ),
      false,
      segment
    );
  }
});

test("fs and gs memory operands add the segment base to the effective offset", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), mem({ segment: "fs", base: "ebx", scale: 1, disp: 8 })],
    loc(0x1000, 0x1004)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const fsBase = outputOf(stateReadFor(block, entryNodes(block), segmentBaseChannel("fs"))!);
  const offset = v.binary("add", ebx, v.const(8));
  const address = v.binary("add", fsBase, offset);
  const read = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    stateRead(v, ebx, gprChannel("ebx")),
    stateRead(v, fsBase, segmentBaseChannel("fs")),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryReadOperation(outputOf(read), address, 32),
    stateWrite(v, gprChannel("eax"), outputOf(read)),
    finishDispatch(v.const(0x1004))
  ]);
});

test("an absolute address is just its displacement constant", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), mem({ scale: 1, disp: 0x2000 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);
  const read = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    read,
    stateWrite(v, gprChannel("eax"), outputOf(read)),
    finishDispatch(v.const(0x1005))
  ]);
  strictEqual(read.inputs[0]!.value, address);
  strictEqual(nestedBodies(block).length, 0);
});

test("movzx r32, byte [mem] forwards the unsigned load unmasked", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movzxSemantic(8, 32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;
  const address = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  deepStrictEqual(read, memoryReadOperation(outputOf(read), address, 8));
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    outputOf(read)
  );
  ok(!nodeKinds(block).includes("truncate"), "no truncations expected");
});

test("movsx r32, byte [mem] marks the load signed with no extra extend", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movsxSemantic(8, 32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;
  const address = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  deepStrictEqual(read, memoryReadOperation(outputOf(read), address, 8, true));
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    outputOf(read)
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("xchg [ebx], ebx stores through the original address, not the new ebx", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    xchgSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("ebx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const load = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);

  // The effective address is computed once, before the instruction writes
  // ebx: the store address and value are the original ebx read, and the
  // register flush carries the loaded value.
  deepStrictEqual(entryNodes(block), [
    stateRead(v, ebx, gprChannel("ebx")),
    ...memoryGuard(block, 1, ebx, 4, "write"),
    memoryReadOperation(load, ebx, 32),
    memoryWriteOperation(ebx, ebx, 32),
    stateWrite(v, gprChannel("ebx"), load),
    finishDispatch(v.const(0x1002))
  ]);
});

test("a validated DS WRITE access lowers read and write nodes at its address", () => {
  const incMem: SemanticTemplate = (s, v) => {
    const address = v.const(0x2000);
    const target = guardDsMemory(s, address, v.const(4), "write");

    s.memory.store(target, {
      byteOffset: v.const(0),
      value: v.binary(
        "add",
        s.memory.load(target, { byteOffset: v.const(0), width: 32 }),
        v.const(1)
      ),
      width: 32
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(incMem, [], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);
  const read = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;
  const write = entryNodes(block).find(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    read,
    write,
    finishDispatch(v.const(0x1006))
  ]);
  strictEqual(nestedBodies(block).length, 0);
  strictEqual(read.inputs[0]!.value, address);
  strictEqual(write.inputs[0]!.value, address);
  strictEqual(write.inputs[1]!.value, v.binary("add", outputOf(read), v.const(1)));
});

test("a folded byte length selects the static flat guard path", () => {
  let foldedByteLength!: ValueId;
  const foldedGuard: SemanticTemplate = (s, v) => {
    const address = v.const(0x2000);
    const byteLength = v.binary("shl", v.const(1), v.const(2));

    foldedByteLength = byteLength;
    guardDsMemory(s, address, byteLength, "read");
  };
  const builder = createLegacyInstructionBlock();

  builder.add(foldedGuard, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  strictEqual(block.values.constValue(foldedByteLength), 4);
  strictEqual(entryNodes(block).filter((node) => node.kind === "if").length, 0);
});

test("memory resolution is nonterminal and adds no IR nodes", () => {
  const template: SemanticTemplate = (s, v) => {
    s.memory.resolve({
      reference: s.memory.reference("ds", v.const(0x2000)),
      byteLength: v.const(4),
      intent: "read"
    });

    s.write(s.reg("eax"), v.const(7), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(template, [], loc(0x1000, 0x1001));
  const block = builder.finish();
  const nodes = entryNodes(block);

  strictEqual(nodes.filter((node) => isMemoryRead(node) || isMemoryWrite(node)).length, 0);
  strictEqual(nodes.some((node) => node.kind === "if"), false);
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    block.values.const(7)
  );
});

test("memory guard emits the canonical fault selection without a transfer", () => {
  let address!: ValueId;
  const checkedAccess: SemanticTemplate = (s, v) => {
    address = s.read(s.reg("eax"), { width: 32 });
    s.memory.guard({
      reference: s.memory.reference("ds", address),
      byteLength: v.const(4),
      intent: "write"
    });
    s.write(s.reg("ebx"), v.const(7), { width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(checkedAccess, [], loc(0x1000, 0x1001));
  const block = builder.finish();
  const nodes = entryNodes(block);

  strictEqual(
    nodes.filter((node) => isMemoryRead(node) || isMemoryWrite(node)).length,
    0
  );
  strictEqual(nodes.filter((node) => node.kind === "if").length, 1);
  strictEqual(ifNode(block).hint, "unlikely");
  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(block.values, "write", address)
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    block.values.const(7)
  );
});

test("guarded memory access remains reusable in a child semantic region", () => {
  let address!: ValueId;
  const checkedStoreArm: SemanticTemplate = (s, v) => {
    address = s.read(s.reg("eax"), { width: 32 });
    const access = s.memory.guard({
      reference: s.memory.reference("ds", address),
      byteLength: v.const(4),
      intent: "write"
    });

    s.if(s.read(s.reg("ecx"), { width: 32 }), (then) => {
      then.memory.store(access, { value: v.const(1), width: 32 });
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(checkedStoreArm, [], loc(0x1000, 0x1001));
  const block = builder.finish();
  const rootNodes = entryNodes(block);
  const selections = rootNodes.filter(
    (node): node is IfControl => node.kind === "if"
  );
  const faultSelection = selections.find((selection) => selection.hint === "unlikely");
  const storeSelection = selections.find((selection) =>
    selection.thenBody.nodes.some((node) => isMemoryWrite(node))
  );

  strictEqual(selections.length, 2);
  ok(faultSelection !== undefined, "preflight fault selection exists in the parent region");
  ok(storeSelection !== undefined, "the child region contains the memory transfer");
  strictEqual(rootNodes.some((node) => isMemoryWrite(node)), false);
  strictEqual(
    storeSelection.thenBody.nodes.filter((node) => isMemoryWrite(node)).length,
    1
  );
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(block.values, "write", address)
  );
});

test("a resolve caller selects its access fault before loading", () => {
  let address!: ValueId;
  const manualLoad: SemanticTemplate = (s, v) => {
    address = s.read(s.reg("eax"), { width: 32 });
    const resolution = s.memory.resolve({
      reference: s.memory.reference("ds", address),
      byteLength: v.const(4),
      intent: "read"
    });

    s.if(resolution.fault.condition, (fault) => {
      fault.cpuException(resolution.fault.exception);
    }, "unlikely");
    s.memory.load(resolution.access, { byteOffset: v.const(0), width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(manualLoad, [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const nodes = entryNodes(block);

  strictEqual(nodes.filter((node) => isMemoryRead(node)).length, 1);
  strictEqual(nodes.filter((node) => node.kind === "if").length, 1);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(block.values, "read", address)
  );
});

test("constant memory access offsets must fit their resolved range", () => {
  const outOfRange: SemanticTemplate = (s, v) => {
    const access = guardDsMemory(s, v.const(0x2000), v.const(4), "read");

    s.memory.load(access, { byteOffset: v.const(1), width: 32 });
  };

  throws(
    () => createLegacyInstructionBlock().add(outOfRange, [], loc(0x1000, 0x1001)),
    /exceeds 4-byte resolution/
  );
});

test("constant relative offsets become memory immediates at the upper boundary", () => {
  const boundaryAccess: SemanticTemplate = (s, v) => {
    const access = guardDsMemory(s, v.const(0x2000), v.const(8), "write");
    const value = s.memory.load(access, { byteOffset: v.const(4), width: 32 });

    s.memory.store(access, { byteOffset: v.const(4), value: value, width: 32 });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(boundaryAccess, [], loc(0x1000, 0x1001));
  const nodes = entryNodes(builder.finish());
  const read = nodes.find((node): node is MemoryReadOperation => isMemoryRead(node));
  const write = nodes.find((node): node is MemoryWriteOperation => isMemoryWrite(node));

  ok(read !== undefined);
  ok(write !== undefined);
  strictEqual(read.displacement, 4);
  strictEqual(write.displacement, 4);
  strictEqual(read.inputs[0]!.value, write.inputs[0]!.value);
});

test("READ and WRITE resolutions retain their exact fault intents", () => {
  let address!: ValueId;
  const bothIntents: SemanticTemplate = (s, v) => {
    address = s.read(s.reg("eax"), { width: 32 });
    const memory = s.memory.reference("ds", address);
    const read = s.memory.resolve({
      reference: memory,
      byteLength: v.const(4),
      intent: "read"
    });
    const write = s.memory.resolve({
      reference: memory,
      byteLength: v.const(4),
      intent: "write"
    });

    s.if(read.fault.condition, (failure) => {
      failure.cpuException(read.fault.exception);
    }, "unlikely");
    s.if(write.fault.condition, (failure) => {
      failure.cpuException(write.fault.exception);
    }, "unlikely");
    const value = s.memory.load(read.access, {
      byteOffset: v.const(0),
      width: 32
    });

    s.memory.store(write.access, {
      byteOffset: v.const(0),
      value,
      width: 32
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(bothIntents, [], loc(0x1000, 0x1001));
  const block = builder.finish();

  strictEqual(nestedBodies(block).length, 2);
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
      createLegacyInstructionBlock().add(
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
  const address = s.read(s.reg("ebx"), { width: 32 });

  s.write(s.operand(0), v.const(0x222), { width: 32 });
  writeDsMemory(s, v, address, s.read(s.operand(0), { width: 32 }), 32);
};

test("a guard after a register write restores the pre-instruction value in its edge", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x111)], loc(0x1000, 0x1005));
  builder.add(setRegThenStore, [regBinding("eax")], loc(0x1005, 0x100b));

  const block = builder.finish();
  const v = block.values;
  const address = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  // The edge flushes eax's value as of instruction start — never the 0x222
  // this instruction wrote before guarding.
  deepStrictEqual(nestedBodyFlushes(block, 1), [
    stateWrite(v, gprChannel("eax"), v.const(0x111)),
    stateWrite(v, coreStateFields.eip, v.const(0x1005))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", address)
  );

  // The main path keeps the new value: the store and the flush carry 0x222.
  const store = entryNodes(block).find(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  )!;

  strictEqual(store.inputs[1]!.value, v.const(0x222));
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    v.const(0x222)
  );
});

test("a guard after writing a previously-clean register omits the channel from its edge", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(setRegThenStore, [regBinding("eax")], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  // eax had no pending at instruction start: cpu state memory already holds the
  // right bytes, so the edge writes only the eip.
  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(v, coreStateFields.eip, v.const(0x1000))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", address)
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    v.const(0x222)
  );
});

test("pop [ebx] guards the stack read first and omits boundary-absent esp from its write edge", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popSemantic(), [mem({ base: "ebx", scale: 1, disp: 0 })], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const popValue = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);
  const nextEsp = v.binary("add", esp, v.const(4));

  strictEqual(nestedBodies(block).length, 2);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryReadOperation(popValue, esp, 32),
    stateRead(v, ebx, gprChannel("ebx")),
    ...memoryGuard(block, 2, ebx, 4, "write"),
    memoryWriteOperation(ebx, popValue, 32),
    stateWrite(v, gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1002))
  ]);

  // esp was boundary-absent, so neither edge writes it — not even the write
  // guard's, where esp is already pending with the incremented value.
  const eipFlushes = [stateWrite(v, coreStateFields.eip, v.const(0x1000))];

  deepStrictEqual(nestedBodyView(block, 1).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", esp));
  deepStrictEqual(nestedBodyView(block, 2).flushes, eipFlushes);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", ebx));
});

test("pop fs:[ebx] writes to the linear destination address", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popSemantic(), [mem({ segment: "fs", base: "ebx", scale: 1, disp: 0 })], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const ebx = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);
  const fsBase = outputOf(stateReadFor(block, entryNodes(block), segmentBaseChannel("fs"))!);
  const popValue = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);
  const nextEsp = v.binary("add", esp, v.const(4));
  const address = v.binary("add", fsBase, ebx);

  deepStrictEqual(entryNodes(block), [
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryReadOperation(popValue, esp, 32),
    stateRead(v, ebx, gprChannel("ebx")),
    stateRead(v, fsBase, segmentBaseChannel("fs")),
    ...memoryGuard(block, 2, address, 4, "write"),
    memoryWriteOperation(address, popValue, 32),
    stateWrite(v, gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1002))
  ]);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", address));
});

test("pop [ebx] write edge restores a previous instruction's pending esp", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("esp"), immBinding(0x30)], loc(0x1000, 0x1005));
  builder.add(popSemantic(), [mem({ base: "ebx", scale: 1, disp: 0 })], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const ebxRead = stateReadFor(block, entryNodes(block), gprChannel("ebx"))!;

  // The edge restores the boundary esp — the mov's 0x30, not the pop's
  // incremented value.
  deepStrictEqual(nestedBodyFlushes(block, 1), [
    stateWrite(v, gprChannel("esp"), v.const(0x30)),
    stateWrite(v, coreStateFields.eip, v.const(0x1005))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "write", outputOf(ebxRead))
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("esp"))!),
    v.binary("add", v.const(0x30), v.const(4))
  );
});

test("pop [esp] builds the destination address from the incremented esp", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popSemantic(), [mem({ base: "esp", scale: 1, disp: 0 })], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const popValue = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);
  const nextEsp = v.binary("add", esp, v.const(4));

  deepStrictEqual(entryNodes(block), [
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryReadOperation(popValue, esp, 32),
    ...memoryGuard(block, 2, nextEsp, 4, "write"),
    memoryWriteOperation(nextEsp, popValue, 32),
    stateWrite(v, gprChannel("esp"), nextEsp),
    finishDispatch(v.const(0x1003))
  ]);
});

test("pop [esp+k] adds the displacement to the incremented esp", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popSemantic(), [mem({ base: "esp", scale: 1, disp: 8 })], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const address = v.binary("add", v.binary("add", esp, v.const(4)), v.const(8));
  const store = entryNodes(block).find(
    (node): node is MemoryWriteOperation => isMemoryWrite(node)
  )!;

  strictEqual(store.effect.resource.id, "memory.guest");
  strictEqual(store.inputs[0]!.value, address);
});

test("a fault branch after a memory write in the same instruction fails loudly", () => {
  const storeThenFault: SemanticTemplate = (s, v) => {
    const firstAddress = v.const(0x2000);
    const access = guardDsMemory(s, firstAddress, v.const(4), "write");

    s.memory.store(access, {
      byteOffset: v.const(0),
      value: v.const(1),
      width: 32
    });
    guardDsMemory(s, s.read(s.reg("eax"), { width: 32 }), v.const(4), "write");
  };

  throws(
    () =>
      createLegacyInstructionBlock().add(storeThenFault, [], loc(0x1000, 0x1006)),
    /CPU exception cannot follow a memory write/
  );
});

test("memory resolution itself may follow a memory write", () => {
  const storeThenResolve: SemanticTemplate = (s, v) => {
    const access = guardDsMemory(s, v.const(0x2000), v.const(4), "write");

    s.memory.store(access, {
      byteOffset: v.const(0),
      value: v.const(1),
      width: 32
    });
    s.memory.resolve({
      reference: s.memory.reference("ds", v.const(0x3000)),
      byteLength: v.const(4),
      intent: "read"
    });
  };
  const builder = createLegacyInstructionBlock();

  builder.add(storeThenResolve, [], loc(0x1000, 0x1006));

  strictEqual(entryNodes(builder.finish()).filter(isMemoryWrite).length, 1);
});

test("a continuing dynamic arm carries its memory write into the parent scope", () => {
  const armStoreThenException: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (then) => {
      writeDsMemory(then, v, v.const(0x2000), v.const(1), 32);
    });
    s.cpuException(invalidOpcode());
  };

  throws(
    () => createLegacyInstructionBlock().add(armStoreThenException, [], loc(0x1000, 0x1005)),
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
    () => createLegacyInstructionBlock().add(loopStoreThenException, [], loc(0x1000, 0x1005)),
    /CPU exception cannot follow a memory write/
  );
});

test("a terminating dynamic arm does not carry its memory write into the skipped path", () => {
  const armStoreThenJump: SemanticTemplate = (s, v) => {
    s.if(s.read(s.reg("eax"), { width: 32 }), (then) => {
      writeDsMemory(then, v, v.const(0x2000), v.const(1), 32);
      then.jump(v.const(0x3000));
    });
    s.cpuException(invalidOpcode());
  };
  const builder = createLegacyInstructionBlock();

  builder.add(armStoreThenJump, [], loc(0x1000, 0x1005));

  const block = builder.finish();

  validateIrBlock(block);
  strictEqual(
    nestedBodies(block)[0]?.nodes.some((node) => isMemoryWrite(node)),
    true
  );
  strictEqual(entryNodes(block).some((node) => isMemoryWrite(node)), false);
  deepStrictEqual(
    entryNodes(block).at(-1),
    finishException(block.values, invalidOpcode())
  );
});

test("a guard after flushing a channel first written this instruction fails loudly", () => {
  const flushThenGuard: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.const(1), { width: 8 });
    s.read(s.operand(1), { width: 16 });
    guardDsMemory(s, s.read(s.reg("ebx"), { width: 32 }), v.const(4), "read");
  };

  throws(
    () =>
      createLegacyInstructionBlock().add(flushThenGuard, [regBinding("al"), regBinding("ax")], loc(0x1000, 0x1003)),
    /unrestorable/
  );
});

test("add r/m32, r32 with both operands dynamic reads, then writes, in one block", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const dst = v.external(0);
  const src = v.external(1);
  const nodes = entryNodes(block);
  const reads = stateReads(nodes);
  const sum = v.binary("add", outputOf(reads[0]!), outputOf(reads[1]!));

  strictEqual(nestedBodies(block).length, 0);
  deepStrictEqual(block.values.node(dst), { kind: "external", external: 0 });
  deepStrictEqual(nodes[0], dynamicGprRead(v, outputOf(reads[0]!), dst, 32));
  deepStrictEqual(nodes[1], dynamicGprRead(v, outputOf(reads[1]!), src, 32));
  deepStrictEqual(nodes[2], dynamicGprWrite(v, dst, 32, sum));

  // Lazy flags commit from the dynamic reads exactly as from static ones.
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: outputOf(reads[0]!), right: outputOf(reads[1]!) });
});

test("a static register read keeps its order across a dynamic write", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regDynamicBinding(0), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const read = stateReadFor(block, entryNodes(block), gprChannel("ebx"))!;

  deepStrictEqual(entryNodes(block), [
    stateRead(v, outputOf(read), gprChannel("ebx")),
    dynamicGprWrite(v, v.external(0), 32, outputOf(read)),
    finishDispatch(v.const(0x1002))
  ]);
});

test("dirty GPR pendings flush before dynamic access; flags and eip ride through", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.add(movSemantic(32), [regDynamicBinding(0), regBinding("ecx")], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const eax = outputOf(stateReadFor(block, entryNodes(block), gprChannel("eax"))!);
  const sum = v.binary("add", eax, v.const(5));
  const nodes = entryNodes(block);
  const eaxFlush = nodes.findIndex((node) =>
    writesStateChannel(v, node, gprChannel("eax"))
  );
  const dynamicWrite = nodes.findIndex((node) =>
    writesDynamicGpr(v, node, v.external(0), 32)
  );
  const lazyKindFlush = nodes.findIndex((node) =>
    writesStateChannel(v, node, flagStateFields.lazyKind)
  );

  ok(eaxFlush !== -1 && dynamicWrite !== -1, "expected an eax flush and a dynamic write");
  ok(eaxFlush < dynamicWrite, "the dirty eax pending must flush before the dynamic write");
  ok(dynamicWrite < lazyKindFlush, "lazy flags ride through and flush at the end");
  strictEqual(
    stateWrites(block).filter((write) =>
      writesStateChannel(v, write, gprChannel("eax"))
    ).length,
    1
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    sum
  );
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });

  strictEqual(stateWriteFor(block, stateWrites(block), coreStateFields.eip), undefined);
});

test("a dynamic write invalidates static GPR pendings for later instructions", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(movSemantic(32), [regDynamicBinding(0), immBinding(5)], loc(0x1005, 0x100b));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const nodes = entryNodes(block);
  const eaxReads = nodes.filter(
    (node): node is StateReadOperation =>
      readsStateChannel(block.values, node, gprChannel("eax"))
  );
  const dynamicWrite = nodes.findIndex(
    (node) => writesDynamicGpr(block.values, node, block.values.external(0), 32)
  );

  // The dynamic write may have hit eax's word, so the third mov reloads it.
  strictEqual(eaxReads.length, 1);
  ok(nodes.indexOf(eaxReads[0]!) > dynamicWrite, "the eax reload must follow the dynamic write");
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ebx"))!),
    outputOf(eaxReads[0]!)
  );
});

test("a dynamic read leaves flushed pendings serving later static reads", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(movSemantic(32), [regBinding("ebx"), regDynamicBinding(0)], loc(0x1005, 0x100b));
  builder.add(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);

  // The dynamic read flushed eax once and left it clean: the third mov is
  // served from the pending with no reload and no second store.
  strictEqual(
    stateWrites(block).filter((write) =>
      writesStateChannel(v, write, gprChannel("eax"))
    ).length,
    1
  );
  strictEqual(
    nodes.filter((node) =>
      readsStateChannel(v, node, gprChannel("eax"))
    ).length,
    0
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("ecx"))!),
    v.const(0x77)
  );
});

test("pop r/mDyn flushes the incremented esp before the dynamic store, after the guard", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(popSemantic(), [regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const popValue = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);
  const nextEsp = v.binary("add", esp, v.const(4));

  // Values-first: the guard (and its snapshot) precedes the esp flush the
  // dynamic store forces, so the unrestorable store happens after the last
  // fault edge.
  strictEqual(nestedBodies(block).length, 1);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryReadOperation(popValue, esp, 32),
    stateWrite(v, gprChannel("esp"), nextEsp),
    dynamicGprWrite(v, v.external(0), 32, popValue),
    finishDispatch(v.const(0x1002))
  ]);
});

test("an 8-bit template width lowers a one-byte dynamic slot", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("bl"), regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const read = entryNodes(block).find(
    (node): node is StateReadOperation =>
      readsDynamicGpr(v, node, v.external(0), 8)
  );

  ok(read !== undefined, "expected a dynamic byte-register read");

  deepStrictEqual(entryNodes(block), [
    dynamicGprRead(v, outputOf(read), v.external(0), 8),
    stateWrite(v, gprChannel("bl"), outputOf(read)),
    finishDispatch(v.const(0x1002))
  ]);
});

test("a 16-bit set through a dynamic register stores a two-byte slot", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(16), [regDynamicBinding(0), immBinding(0x1234)], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(
    entryNodes(block)[0],
    dynamicGprWrite(v, v.external(0), 16, v.const(0x1234))
  );
});

test("movsx r32, r8 from a dynamic register marks the read signed with no extra extend", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movsxSemantic(8, 32), [regBinding("eax"), regDynamicBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const read = entryNodes(block).find(
    (node): node is StateReadOperation =>
      readsDynamicGpr(v, node, v.external(0), 8)
  );

  ok(read !== undefined, "expected a signed dynamic byte-register read");
  deepStrictEqual(
    entryNodes(block)[0],
    dynamicGprRead(v, outputOf(read), v.external(0), 8, true)
  );
  strictEqual(
    stateWriteValue(stateWriteFor(block, stateWrites(block), gprChannel("eax"))!),
    outputOf(read)
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("a guard after a dynamic flush of an instruction-written register fails loudly", () => {
  const setThenDynamicRead: SemanticTemplate = (s, v) => {
    s.write(s.reg("ebx"), v.const(0x111), { width: 32 });
    s.read(s.operand(0), { width: 32 });
    guardDsMemory(s, s.read(s.reg("ecx"), { width: 32 }), v.const(4), "read");
  };

  throws(
    () =>
      createLegacyInstructionBlock().add(setThenDynamicRead, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("a guard after a dynamic write fails loudly", () => {
  const dynamicWriteThenGuard: SemanticTemplate = (s, v) => {
    s.write(s.operand(0), v.const(0x222), { width: 32 });
    guardDsMemory(s, s.read(s.reg("ebx"), { width: 32 }), v.const(4), "write");
  };

  throws(
    () =>
      createLegacyInstructionBlock().add(dynamicWriteThenGuard, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("Core commits an external next EIP before dispatch", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), immBinding(5)],
    externalInstructionLocation(0, 1)
  );

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryNodes(block), [
    stateWrite(v, gprChannel("eax"), v.const(5)),
    finishDispatch(v.external(1))
  ]);
  const rawNodes = rawEntryNodes(block);
  const finishIndex = rawNodes.length - 1;
  const eipCommitIndex = rawNodes.findIndex(
    (node) => writesStateChannel(v, node, coreStateFields.eip)
  );

  ok(eipCommitIndex >= 0 && eipCommitIndex < finishIndex);
  deepStrictEqual(
    rawNodes[eipCommitIndex],
    stateWrite(v, coreStateFields.eip, v.external(1))
  );
});

test("a fault edge restores an external eip", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), mem({ base: "ebx", scale: 1, disp: 0 })],
    externalInstructionLocation(4, 5)
  );

  const block = builder.finish();
  const v = block.values;
  const address = outputOf(stateReadFor(block, entryNodes(block), gprChannel("ebx"))!);

  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(v, coreStateFields.eip, v.external(4))
  ]);
  deepStrictEqual(
    nestedBodyView(block, 1).terminator,
    pageFaultStop(v, "read", address)
  );
  deepStrictEqual(
    rawEntryNodes(block).filter(
      (node): node is StateWriteOperation =>
        writesStateChannel(v, node, coreStateFields.eip)
    ),
    [stateWrite(v, coreStateFields.eip, v.external(5))]
  );
  deepStrictEqual(entryNodes(block).at(-1), finishDispatch(v.external(5)));
});

// The memDynamic address: the in-block base register read plus the
// pre-summed offset external.
function dynamicAddress(block: IrBlock, baseRead: StateReadOperation): ValueId {
  const v = block.values;

  return v.binary("add", outputOf(baseRead), v.external(1));
}

function dynamicBaseRead(block: IrBlock): StateReadOperation {
  const v = block.values;
  const expected = dynamicGprRead(v, valueId(0), v.external(0), 32);
  const read = entryNodes(block).find(
    (node): node is StateReadOperation =>
      readsDynamicGpr(v, node, v.external(0), 32) &&
      node.inputs[0]?.value === expected.inputs[0]?.value
  );

  ok(read !== undefined, "expected a dynamic base register read");
  return read;
}

function dynamicSegmentBaseRead(
  block: IrBlock,
  index: ValueId
): StateReadOperation {
  const expected = dynamicSegmentRead(block.values, valueId(0), index, "base");
  const read = entryNodes(block).find(
    (node): node is StateReadOperation =>
      readsDynamicSegment(block.values, node, index, "base") &&
      node.inputs[0]?.value === expected.inputs[0]?.value
  );

  ok(read !== undefined, "expected a dynamic segment base read");
  return read;
}

test("a memStatic operand guards and accesses the external address", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), memStaticBinding(7, staticMemSegment("ds"))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.external(7);
  const load = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryReadOperation(outputOf(load), address, 32),
    stateWrite(v, gprChannel("eax"), outputOf(load)),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("a segmented memStatic operand adds the selected segment base", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), memStaticBinding(7, dynamicMemSegment(8))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const segmentBase = dynamicSegmentBaseRead(block, v.external(8));
  const address = v.binary("add", outputOf(segmentBase), v.external(7));
  const load = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    dynamicSegmentRead(v, outputOf(segmentBase), v.external(8), "base"),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryReadOperation(outputOf(load), address, 32),
    stateWrite(v, gprChannel("eax"), outputOf(load)),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("a memDynamic operand reads the base register inside the block", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    movSemantic(32),
    [regBinding("eax"), memDynamicBinding(0, 1, staticMemSegment("ds"))],
    loc(0x1000, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);
  const load = entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!;

  deepStrictEqual(entryNodes(block), [
    dynamicGprRead(v, outputOf(baseRead), v.external(0), 32),
    ...memoryGuard(block, 1, address, 4, "read"),
    memoryReadOperation(outputOf(load), address, 32),
    stateWrite(v, gprChannel("eax"), outputOf(load)),
    finishDispatch(v.const(0x1006))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", address));
});

test("fs memDynamic operands add the segment base to the dynamic effective address", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, staticMemSegment("fs")), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const nodes = entryNodes(block);
  const baseRead = dynamicBaseRead(block);
  const fsBase = stateReadFor(block, nodes, segmentBaseChannel("fs"))!;
  const offset = dynamicAddress(block, baseRead);
  const address = block.values.binary("add", outputOf(fsBase), offset);
  const load = nodes.find((node): node is MemoryReadOperation => isMemoryRead(node))!;
  const store = nodes.find((node): node is MemoryWriteOperation => isMemoryWrite(node))!;

  strictEqual(
    nodes.filter((node) => readsDynamicGpr(block.values, node, block.values.external(0), 32)).length,
    1
  );
  strictEqual(
    nodes.filter((node) =>
      readsStateChannel(block.values, node, segmentBaseChannel("fs"))
    ).length,
    1
  );
  strictEqual(load.effect.resource, store.effect.resource);
  strictEqual(load.inputs[0]!.value, address);
  strictEqual(store.inputs[0]!.value, address);
});

test("dynamic memDynamic segments read the selected segment base", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, dynamicMemSegment(2)), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const nodes = entryNodes(block);
  const baseRead = dynamicBaseRead(block);
  const segmentBase = dynamicSegmentBaseRead(block, v.external(2));
  const offset = dynamicAddress(block, baseRead);
  const address = v.binary("add", outputOf(segmentBase), offset);
  const load = nodes.find((node): node is MemoryReadOperation => isMemoryRead(node))!;
  const store = nodes.find((node): node is MemoryWriteOperation => isMemoryWrite(node))!;

  strictEqual(
    nodes.filter((node) =>
      readsDynamicSegment(v, node, v.external(2), "base")
    ).length,
    1
  );
  strictEqual(
    nodes.filter((node) => isStateRead(node)).length,
    2
  );
  strictEqual(load.effect.resource, store.effect.resource);
  strictEqual(load.inputs[0]!.value, address);
  strictEqual(store.inputs[0]!.value, address);
});

test("lea with memDynamic uses the dynamic effective address without segment bases", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    leaSemantic(32),
    [regBinding("eax"), memDynamicBinding(0, 1, staticMemSegment("fs"))],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);

  deepStrictEqual(entryNodes(block), [
    dynamicGprRead(v, outputOf(baseRead), v.external(0), 32),
    stateWrite(v, gprChannel("eax"), address),
    finishDispatch(v.const(0x1003))
  ]);
});

test("a read+write memDynamic operand reads the base once and reuses the address", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    aluSemantic("add", 32),
    [memDynamicBinding(0, 1, staticMemSegment("ds")), immBinding(5)],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const nodes = entryNodes(block);
  const baseReads = nodes.filter(
    (node) => readsDynamicGpr(block.values, node, block.values.external(0), 32)
  );
  const load = nodes.find((node): node is MemoryReadOperation => isMemoryRead(node))!;
  const store = nodes.find((node): node is MemoryWriteOperation => isMemoryWrite(node))!;

  strictEqual(baseReads.length, 1);
  strictEqual(load.inputs[0]!.value, dynamicAddress(block, dynamicBaseRead(block)));
  strictEqual(store.inputs[0]!.value, load.inputs[0]!.value);
});

test("pop [memDynamic] flushes esp before the base read and restores it on the write edge", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(
    popSemantic(),
    [memDynamicBinding(0, 1, staticMemSegment("ds"))],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const esp = outputOf(stateReadFor(block, entryNodes(block), gprChannel("esp"))!);
  const popValue = outputOf(entryNodes(block).find(
    (node): node is MemoryReadOperation => isMemoryRead(node)
  )!);
  const nextEsp = v.binary("add", esp, v.const(4));
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);

  // The main path stores the incremented esp before the base read, so an
  // esp-based destination follows the SDM; the value comes from the
  // pre-increment esp read.
  strictEqual(nestedBodies(block).length, 2);
  deepStrictEqual(entryNodes(block), [
    stateRead(v, esp, gprChannel("esp")),
    ...memoryGuard(block, 1, esp, 4, "read"),
    memoryReadOperation(popValue, esp, 32),
    stateWrite(v, gprChannel("esp"), nextEsp),
    dynamicGprRead(v, outputOf(baseRead), v.external(0), 32),
    ...memoryGuard(block, 2, address, 4, "write"),
    memoryWriteOperation(address, popValue, 32),
    finishDispatch(v.const(0x1003))
  ]);

  // The read guard predates the flush: its edge omits esp (cpu state memory
  // still holds it on that path). The write guard's edge restores the
  // pre-instruction esp read the flush destroyed.
  deepStrictEqual(nestedBodyView(block, 1).flushes, [
    stateWrite(v, coreStateFields.eip, v.const(0x1000))
  ]);
  deepStrictEqual(nestedBodyView(block, 1).terminator, pageFaultStop(v, "read", esp));
  deepStrictEqual(nestedBodyFlushes(block, 2), [
    stateWrite(v, gprChannel("esp"), esp),
    stateWrite(v, coreStateFields.eip, v.const(0x1000))
  ]);
  deepStrictEqual(nestedBodyView(block, 2).terminator, pageFaultStop(v, "write", address));
});

test("a guard after a memDynamic flush of a never-read register fails loudly", () => {
  const blindWriteThenDynamicAddress: SemanticTemplate = (s, v) => {
    s.write(s.reg("ebx"), v.const(0x111), { width: 32 });
    guardDsMemory(s, s.address(s.operand(0)), v.const(4), "write");
  };

  throws(
    () =>
      createLegacyInstructionBlock().add(
        blindWriteThenDynamicAddress,
        [memDynamicBinding(0, 1, staticMemSegment("ds"))],
        loc(0x1000, 0x1002)
      ),
    /unrestorable/
  );
});

test("a narrow immExternal get truncates to the access width", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("bl"), immExternalBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const write = stateWriteFor(block, stateWrites(block), gprChannel("bl"));

  deepStrictEqual(v.node(stateWriteValue(write!)), {
    kind: "truncate",
    inputType: "i32",
    width: 8,
    value: v.external(0)
  });
});

test("a signed immExternal get sign-extends instead of masking", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movsxSemantic(8, 32), [regBinding("eax"), immExternalBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const write = stateWriteFor(block, stateWrites(block), gprChannel("eax"));

  deepStrictEqual(v.node(stateWriteValue(write!)), {
    kind: "extend",
    resultType: "i32",
    width: 8,
    value: v.external(0),
    signed: true
  });
});

function instructionCountRead(block: IrBlock): StateReadOperation {
  const read = stateReadFor(block, rawEntryNodes(block), instructionCountField);

  ok(read !== undefined, "expected an instruction-count read");
  return read;
}

test("every instruction advances the instruction-count field once, flushed once", () => {
  const builder = createLegacyInstructionBlock();
  const mov = movSemantic(32);

  builder.add(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.add(mov, [regBinding("ecx"), immBinding(9)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryNodes(block).filter(
    (node): node is StateWriteOperation =>
      writesStateChannel(v, node, instructionCountField)
  );

  // Both advances fold onto the block's one count read.
  deepStrictEqual(writes, [
    stateWrite(
      v,
      instructionCountField,
      v.binary("add", outputOf(instructionCountRead(block)), v.const(2))
    )
  ]);
});

test("conditional jump side exit and fallthrough flush the advanced count", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(jccSemantic("E"), [immBinding(0x2000)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const taken = nestedBodyView(block, 1);
  const takenRead = stateReadFor(block, taken.nodes, instructionCountField);
  const fallthroughRead = instructionCountRead(block);

  ok(takenRead !== undefined, "expected taken count read");
  strictEqual(
    stateWriteValue(
      stateWriteFor(block, taken.flushes, instructionCountField)!
    ),
    v.binary("add", outputOf(takenRead), v.const(1))
  );
  strictEqual(
    stateWriteValue(
      rawEntryNodes(block).find(
        (node): node is StateWriteOperation =>
          writesStateChannel(v, node, instructionCountField)
      )!
    ),
    v.binary("add", outputOf(fallthroughRead), v.const(1))
  );
});

test("a fault edge restores the boundary count", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.add(
    movSemantic(32),
    [mem({ base: "ebx", scale: 1, disp: 0 }), regBinding("eax")],
    loc(0x1005, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;

  // The faulting store's own advance never reaches the edge: it restores the
  // first instruction's count.
  strictEqual(
    stateWriteValue(
      stateWriteFor(
        block,
        nestedBodyView(block, 1).flushes,
        instructionCountField
      )!
    ),
    v.binary("add", outputOf(instructionCountRead(block)), v.const(1))
  );
});

test("a host trap flushes the advanced count", () => {
  const builder = createLegacyInstructionBlock();

  builder.add(intSemantic(), [immBinding(0x21)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryNodes(block).filter(
    (node): node is StateWriteOperation =>
      writesStateChannel(v, node, instructionCountField)
  );

  deepStrictEqual(writes, [
    stateWrite(
      v,
      instructionCountField,
      v.binary("add", outputOf(instructionCountRead(block)), v.const(1))
    )
  ]);
});
