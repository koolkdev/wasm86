import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { ExternalValueId } from "#ir/action/operands.js";
import { gprChannel } from "#ir/action/slots.js";
import type {
  Action,
  EdgeRegion,
  EntryRegion,
  ReadMemoryAction,
  ReadStateAction
} from "#ir/action/types.js";
import { createValueTable, type ValueTable } from "#ir/action/values.js";
import { createValueStack, type ValueStack } from "#wasm/emit/action/value-stack.js";
import { analyzeBlockValues } from "#wasm/emit/action/values.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#wasm/encoder/types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";

function entryRegion(actions: readonly Action[]): EntryRegion {
  return { id: 0, kind: "entry", actions };
}

type TestEmitter = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  valueStack: ValueStack;
}>;

function createTestEmitter(
  values: ValueTable,
  region: EntryRegion,
  externalIds: readonly ExternalValueId[] = []
): TestEmitter {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const externalLocals = new Map(externalIds.map((id) => [id, body.addLocal(wasmValueType.i32)]));
  const valueStack = createValueStack({
    body,
    scratch,
    values,
    analysis: analyzeBlockValues({ entry: region.id, regions: [region], values }),
    externalLocals,
    // Stand-ins for the state and guest access layers: plain loads.
    loadSlot: () => body.i32Const(0).i32Load({ align: 2, offset: 0, memoryIndex: 0 }),
    loadGuest: () => body.i32Load({ align: 2, offset: 0, memoryIndex: 1 })
  });

  return { body, scratch, valueStack };
}

test("single-use values emit inline with no locals", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readAction);
  valueStack.emitUse(sum);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a multi-use value tees once and replays from one freed local", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "writeState", slot: gprChannel("ecx"), value: sum },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readAction);
  valueStack.emitUse(sum);
  valueStack.emitUse(sum);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a pinned read loads once at its action point and replays past the store", () => {
  const values = createValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const readEax: ReadStateAction = { kind: "readState", output: eax, slot: gprChannel("eax") };
  const readEbx: ReadStateAction = { kind: "readState", output: ebx, slot: gprChannel("ebx") };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readEax,
      readEbx,
      { kind: "writeState", slot: gprChannel("ebx"), value: eax },
      { kind: "writeState", slot: gprChannel("eax"), value: ebx },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readEax);
  valueStack.readState(readEbx);
  valueStack.emitUse(eax);
  valueStack.emitUse(ebx);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The ebx read is captured at its action point; the eax read loads at its
  // use. Exactly two state loads either way.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a dead read emits nothing", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const seven = values.internConst(7);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("eax"), value: seven },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readAction);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("constant and external leaves re-emit per use without scratch locals", () => {
  const values = createValueTable();
  const seven = values.internConst(7);
  const external = values.internExternal(3);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: seven },
      { kind: "writeState", slot: gprChannel("ebx"), value: seven },
      { kind: "writeState", slot: gprChannel("ecx"), value: external },
      { kind: "writeState", slot: gprChannel("edx"), value: external },
      { kind: "continue" }
    ]),
    [3]
  );

  valueStack.emitUse(seven);
  valueStack.emitUse(seven);
  valueStack.emitUse(external);
  valueStack.emitUse(external);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  // Only the external's binding local — nothing from the scratch allocator.
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("an external without a bound local fails loudly", () => {
  const values = createValueTable();
  const external = values.internExternal(3);
  const { valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: external },
      { kind: "continue" }
    ])
  );

  throws(() => valueStack.emitUse(external), /no local bound for external value 3/);
});

test("select pushes whenTrue, whenFalse, then condition", () => {
  const values = createValueTable();
  const one = values.internConst(1);
  const two = values.internConst(2);
  const whenTrue = values.internUnary("popcnt", one);
  const condition = values.internCompare("lt_u", one, two);
  const select = values.internSelect(condition, whenTrue, two);
  const { body, valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: select },
      { kind: "continue" }
    ])
  );

  valueStack.emitUse(select);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Popcnt,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32LtU,
    wasmOpcode.select,
    wasmOpcode.end
  ]);
});

test("operators map to their wasm opcodes", () => {
  const values = createValueTable();
  const one = values.internConst(1);
  const two = values.internConst(2);
  const shifted = values.internBinary("shl", one, two);
  const mixed = values.internBinary("xor", shifted, values.internBinary("shr_u", one, two));
  const extended = values.internUnary("extend16_s", values.internUnary("extend8_s", one));
  const masked = values.internBinary("sub", values.internBinary("and", one, two), values.internBinary("or", one, two));
  const equal = values.internCompare("eq", one, two);
  const signed = values.internCompare("ge_s", one, two);
  const { body, valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: mixed },
      { kind: "writeState", slot: gprChannel("ebx"), value: extended },
      { kind: "writeState", slot: gprChannel("ecx"), value: masked },
      { kind: "writeState", slot: gprChannel("edx"), value: equal },
      { kind: "writeState", slot: gprChannel("esi"), value: signed },
      { kind: "continue" }
    ])
  );

  valueStack.emitUse(mixed);
  valueStack.emitUse(extended);
  valueStack.emitUse(masked);
  valueStack.emitUse(equal);
  valueStack.emitUse(signed);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32Shl,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32ShrU,
    wasmOpcode.i32Xor,
    wasmOpcode.i32Const,
    wasmOpcode.i32Extend8S,
    wasmOpcode.i32Extend16S,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32Or,
    wasmOpcode.i32Sub,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32Eq,
    wasmOpcode.i32Const,
    wasmOpcode.i32Const,
    wasmOpcode.i32GeS,
    wasmOpcode.end
  ]);
});

test("project masks to the requested width", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const low8 = values.internProject(8, read);
  const low16 = values.internProject(16, read);
  const full = values.internProject(32, read);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { body, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("ebx"), value: low8 },
      { kind: "writeState", slot: gprChannel("ecx"), value: low16 },
      { kind: "writeState", slot: gprChannel("edx"), value: full },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readAction);
  valueStack.emitUse(low8);
  valueStack.emitUse(low16);
  valueStack.emitUse(full);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.end
  ]);
});

test("equality against constant zero emits eqz from either side", () => {
  const values = createValueTable();
  const external = values.internExternal(3);
  const zero = values.internConst(0);
  const left = values.internCompare("eq", external, zero);
  const right = values.internCompare("eq", zero, external);
  const { body, valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: left },
      { kind: "writeState", slot: gprChannel("ebx"), value: right },
      { kind: "continue" }
    ]),
    [3]
  );

  valueStack.emitUse(left);
  valueStack.emitUse(right);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.localGet,
    wasmOpcode.i32Eqz,
    wasmOpcode.localGet,
    wasmOpcode.i32Eqz,
    wasmOpcode.end
  ]);
});

test("ne and non-zero equality keep the generic compare", () => {
  const values = createValueTable();
  const external = values.internExternal(3);
  const notZero = values.internCompare("ne", external, values.internConst(0));
  const one = values.internCompare("eq", external, values.internConst(1));
  const { body, valueStack } = createTestEmitter(
    values,
    entryRegion([
      { kind: "writeState", slot: gprChannel("eax"), value: notZero },
      { kind: "writeState", slot: gprChannel("ebx"), value: one },
      { kind: "continue" }
    ]),
    [3]
  );

  valueStack.emitUse(notZero);
  valueStack.emitUse(one);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Ne,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Eq,
    wasmOpcode.end
  ]);
});

test("a loaded value pins to a local at its action point and replays", () => {
  const values = createValueTable();
  const address = values.internConst(0x2000);
  const loaded = values.addActionOutput();
  const readAction: ReadMemoryAction = { kind: "readMemory", output: loaded, address, width: 32 };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("eax"), value: loaded },
      { kind: "writeState", slot: gprChannel("ebx"), value: loaded },
      { kind: "continue" }
    ])
  );

  valueStack.readMemory(readAction);
  valueStack.emitUse(loaded);
  valueStack.emitUse(loaded);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a dead load emits nothing", () => {
  const values = createValueTable();
  const address = values.internConst(0x2000);
  const loaded = values.addActionOutput();
  const readAction: ReadMemoryAction = { kind: "readMemory", output: loaded, address, width: 32 };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([readAction, { kind: "continue" }])
  );

  valueStack.readMemory(readAction);
  valueStack.assertClear();
  scratch.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [wasmOpcode.end]);
});

test("captureForEdge computes an untouched compound into a local for later uses", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "writeState", slot: gprChannel("ecx"), value: sum },
      { kind: "continue" }
    ])
  );
  // An edge consuming the compound twice plus both leaves: one capture, the
  // rest are no-ops (replay for the compound, reload and inline for the
  // unpinned read and the const).
  const edge: EdgeRegion = {
    id: 1,
    kind: "edge",
    flushes: [
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "writeState", slot: gprChannel("ecx"), value: sum },
      { kind: "writeState", slot: gprChannel("edx"), value: read }
    ],
    terminator: { kind: "exit", reason: "memoryWriteFault", payload: five }
  };

  valueStack.readState(readAction);
  valueStack.captureForEdge(edge);
  valueStack.emitUse(sum);
  valueStack.emitUse(sum);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // One computation set into a local, two replays.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("unconsumed captures fail assertClear and hold their scratch local", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const readAction: ReadStateAction = { kind: "readState", output: read, slot: gprChannel("eax") };
  const { scratch, valueStack } = createTestEmitter(
    values,
    entryRegion([
      readAction,
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "writeState", slot: gprChannel("ecx"), value: sum },
      { kind: "continue" }
    ])
  );

  valueStack.readState(readAction);
  valueStack.emitUse(sum);

  throws(() => valueStack.assertClear(), /captured values with unconsumed uses/);
  throws(() => scratch.assertClear(), /scratch locals still in use/);
});
