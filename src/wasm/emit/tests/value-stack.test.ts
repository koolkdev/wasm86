import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { ExternalValueId } from "#ir/operands.js";
import { gprChannel, lazyFlagsBChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import type { Body } from "#ir/block.js";
import { ValueTable, fitsUnsigned } from "#ir/values.js";
import { emitOp } from "#wasm/emit/ops.js";
import { ValueStack } from "#wasm/emit/value-stack.js";
import { analyzePlacement } from "#wasm/emit/placement.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#wasm/encoder/types.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { defineLazyFlagHelper } from "#wasm/helpers/lazy-flags.js";
import { createWasmHelperRegistry } from "#wasm/helpers/module.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { PageFaultErrorCode, pageFault } from "#x86/exceptions.js";
import { memoryRead, resolveFlag, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import type { MemoryReadAction, ResolveFlagAction, StateReadAction } from "#ir/tests/storage-op-helpers.js";

function testBody(actions: readonly Action[]): Body {
  return { actions };
}

type TestEmitter = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  valueStack: ValueStack;
}>;

function createTestEmitter(
  values: ValueTable,
  actionBody: Body,
  externalIds: readonly ExternalValueId[] = [],
  helpers = createWasmHelperRegistry(new WasmModuleEncoder())
): TestEmitter {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const externalLocals = new Map(externalIds.map((id) => [id, body.addLocal(wasmValueType.i32)]));
  const valueStack = new ValueStack({
    body,
    scratch,
    values,
    placement: analyzePlacement({ body: actionBody, values }),
    externalLocals,
    // The real op lowering: its state and guest accesses emit the same
    // opcode shapes the assertions pin (const address + load).
    emitOp: (op, operands) => emitOp(body, helpers, op, operands)
  });

  return { body, scratch, valueStack };
}

test("a deferred flag resolve emits its Wasm call at first use", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const helpers = createWasmHelperRegistry(new WasmModuleEncoder());
  const helperIndex = defineLazyFlagHelper(helpers, "ZF");
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    helpers
  );

  strictEqual(helperIndex, 0);
  valueStack.scheduledProducer(resolveAction);
  valueStack.emitUse(resolved);
  valueStack.assertClear();
  scratch.assertClear();

  // Nothing at the action point; the call sinks into the consumer.
  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.call, wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a captured flag resolve calls at its action point and replays", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const record = values.const(0);
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const helpers = createWasmHelperRegistry(new WasmModuleEncoder());

  defineLazyFlagHelper(helpers, "ZF");

  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(lazyFlagsBChannel, record),
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    helpers
  );

  valueStack.scheduledProducer(resolveAction);
  valueStack.emitUse(resolved);
  valueStack.assertClear();
  scratch.assertClear();

  // The lazy record between resolve and use pins the observation point.
  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.call,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
});

test("scheduled flag resolves fail clearly when the helper is missing", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const { valueStack } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    createWasmHelperRegistry(new WasmModuleEncoder())
  );

  valueStack.scheduledProducer(resolveAction);

  throws(() => valueStack.emitUse(resolved), /missing Wasm helper resolveZF/);
});

test("dead scheduled flag resolves emit nothing and require no helper", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([resolveAction]),
    [],
    createWasmHelperRegistry(new WasmModuleEncoder())
  );

  valueStack.scheduledProducer(resolveAction);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("single-use values emit inline with no locals", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);
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
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);
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
  const values = new ValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const readEax: StateReadAction = stateRead(eax, gprChannel("eax"));
  const readEbx: StateReadAction = stateRead(ebx, gprChannel("ebx"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readEax,
      readEbx,
      stateWrite(gprChannel("ebx"), eax),
      stateWrite(gprChannel("eax"), ebx)
    ])
  );

  valueStack.scheduledProducer(readEax);
  valueStack.scheduledProducer(readEbx);
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
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), seven)
    ])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("constant and external leaves re-emit per use without scratch locals", () => {
  const values = new ValueTable();
  const seven = values.const(7);
  const external = values.external(3);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), seven),
      stateWrite(gprChannel("ebx"), seven),
      stateWrite(gprChannel("ecx"), external),
      stateWrite(gprChannel("edx"), external)
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
  const values = new ValueTable();
  const external = values.external(3);
  const { valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ])
  );

  throws(() => valueStack.emitUse(external), /no local bound for external value 3/);
});

test("select pushes whenTrue, whenFalse, then condition", () => {
  const values = new ValueTable();
  const one = values.external(0);
  const two = values.external(1);
  const whenTrue = values.unary("popcnt", one);
  const condition = values.compare("lt_u", one, two);
  const select = values.select(condition, whenTrue, two);
  const { body, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), select)
    ]),
    [0, 1]
  );

  valueStack.emitUse(select);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.localGet,
    wasmOpcode.i32Popcnt,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32LtU,
    wasmOpcode.select,
    wasmOpcode.end
  ]);
});

test("operators map to their wasm opcodes", () => {
  const values = new ValueTable();
  const one = values.external(0);
  const two = values.external(1);
  const shifted = values.binary("shl", one, two);
  const signedShifted = values.binary("shr_s", one, two);
  const unsignedShifted = values.binary("shr_u", one, two);
  const mixed = values.binary("xor", shifted, values.binary("xor", signedShifted, unsignedShifted));
  const product = values.binary("mul", one, two);
  const remainder = values.binary("rem_u", one, two);
  const rotatedLeft = values.binary("rotl", one, two);
  const rotatedRight = values.binary("rotr", one, two);
  const extended8 = values.extend(8, one, true);
  const extended16 = values.extend(16, two, true);
  const masked = values.binary("sub", values.binary("and", one, two), values.binary("or", one, two));
  const equal = values.compare("eq", one, two);
  const signed = values.compare("ge_s", one, two);
  const { body, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), mixed),
      stateWrite(gprChannel("esi"), product),
      stateWrite(gprChannel("esi"), remainder),
      stateWrite(gprChannel("esi"), rotatedLeft),
      stateWrite(gprChannel("esi"), rotatedRight),
      stateWrite(gprChannel("ebx"), extended8),
      stateWrite(gprChannel("edi"), extended16),
      stateWrite(gprChannel("ecx"), masked),
      stateWrite(gprChannel("edx"), equal),
      stateWrite(gprChannel("esi"), signed)
    ]),
    [0, 1]
  );

  valueStack.emitUse(mixed);
  valueStack.emitUse(product);
  valueStack.emitUse(remainder);
  valueStack.emitUse(rotatedLeft);
  valueStack.emitUse(rotatedRight);
  valueStack.emitUse(extended8);
  valueStack.emitUse(extended16);
  valueStack.emitUse(masked);
  valueStack.emitUse(equal);
  valueStack.emitUse(signed);
  valueStack.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Shl,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32ShrS,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32ShrU,
    wasmOpcode.i32Xor,
    wasmOpcode.i32Xor,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Mul,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32RemU,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Rotl,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Rotr,
    wasmOpcode.localGet,
    wasmOpcode.i32Extend8S,
    wasmOpcode.localGet,
    wasmOpcode.i32Extend16S,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32And,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Or,
    wasmOpcode.i32Sub,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Eq,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32GeS,
    wasmOpcode.end
  ]);
});

test("signed multiply overflow expressions lower through typed i64 products", () => {
  const values = new ValueTable();
  const one = values.external(0);
  const two = values.external(1);
  const left16 = values.extend64(16, one, true);
  const right16 = values.extend64(16, two, true);
  const product16 = values.binary64("mul", left16, right16);
  const truncated16 = values.extend64(16, values.truncate64(16, product16), true);
  const overflow16 = values.compare64("ne", product16, truncated16);
  const left32 = values.extend64(32, one, true);
  const right32 = values.extend64(32, two, true);
  const product32 = values.binary64("mul", left32, right32);
  const truncated32 = values.extend64(32, values.truncate64(32, product32), true);
  const overflow32 = values.compare64("ne", product32, truncated32);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), overflow16),
      stateWrite(gprChannel("ebx"), overflow32)
    ]),
    [0, 1]
  );

  valueStack.emitUse(overflow16);
  valueStack.emitUse(overflow32);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.i32Extend16S,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i32Extend16S,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Mul,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.i32WrapI64,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.i32Extend16S,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Ne,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Mul,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.i32WrapI64,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Ne,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 3);
});

test("i64 binary operators lower to wasm i64 opcodes", () => {
  const values = new ValueTable();
  const one = values.extend64(32, values.external(0), false);
  const two = values.extend64(32, values.external(1), false);
  const three = values.extend64(32, values.external(2), false);
  const four = values.extend64(32, values.external(3), false);
  const either = values.binary64("or", one, two);
  const remainder = values.binary64("rem_u", three, four);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), either),
      stateWrite(gprChannel("ebx"), remainder)
    ]),
    [0, 1, 2, 3]
  );

  valueStack.emitUse(either);
  valueStack.emitUse(remainder);
  valueStack.assertClear();
  scratch.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.i64Or,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.i64RemU,
    wasmOpcode.end
  ]);
});

test("unsupported i64 operators fail at wasm lowering", () => {
  const values = new ValueTable();
  const one = values.extend64(32, values.external(0), true);
  const two = values.extend64(32, values.external(1), true);
  const sum = values.binary64("add", one, two);
  const equal = values.compare64("eq", one, two);
  const sumEmitter = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), sum)
    ]),
    [0, 1]
  );
  const equalEmitter = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), equal)
    ]),
    [0, 1]
  );

  throws(() => sumEmitter.valueStack.emitUse(sum), /unsupported i64 binary operator add/);
  throws(() => equalEmitter.valueStack.emitUse(equal), /unsupported i64 compare operator eq/);
});

test("truncate masks to the requested width", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const low8 = values.truncate(8, read);
  const low16 = values.truncate(16, read);
  const full = values.truncate(32, read);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), low8),
      stateWrite(gprChannel("ecx"), low16),
      stateWrite(gprChannel("edx"), full)
    ])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.emitUse(low8);
  valueStack.emitUse(low16);
  valueStack.emitUse(full);
  valueStack.assertClear();

  // The deferred read materializes once, inside the first truncation, and
  // the later ones replay its tee.
  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localTee,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
});

test("equality against constant zero emits eqz from either side", () => {
  const values = new ValueTable();
  const external = values.external(3);
  const zero = values.const(0);
  const left = values.compare("eq", external, zero);
  const right = values.compare("eq", zero, external);
  const { body, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), left),
      stateWrite(gprChannel("ebx"), right)
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
  const values = new ValueTable();
  const external = values.external(3);
  const notZero = values.compare("ne", external, values.const(0));
  const one = values.compare("eq", external, values.const(1));
  const { body, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), notZero),
      stateWrite(gprChannel("ebx"), one)
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

test("a multi-use deferred load emits at its first use and tees", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), loaded),
      stateWrite(gprChannel("ebx"), loaded)
    ])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.emitUse(loaded);
  valueStack.emitUse(loaded);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // Nothing at the action point: the load executes once at its first use
  // and the remaining use replays the tee.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a multi-use deferred static read emits one slot load and tees", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), read),
      stateWrite(gprChannel("ecx"), read)
    ])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.emitUse(read);
  valueStack.emitUse(read);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // One tee'd slot load instead of a reload per use.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a dead load emits nothing", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([readAction])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.assertClear();
  scratch.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.end().encode()), [wasmOpcode.end]);
});

test("a deferred producer consumed only inside a nested body emits there", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const condition = values.external(0);
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const faultBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), loaded),
      {
        kind: "finish",
        finish: {
          kind: "exit",
          exit: {
            class: "cpuException",
            exception: pageFault(address, PageFaultErrorCode.WRITE)
          }
        }
      }
    ]
  };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody }
    ]),
    [0]
  );

  valueStack.scheduledProducer(readAction);
  valueStack.captureForBody(faultBody);
  valueStack.emitUse(condition);
  body.ifBlock();
  valueStack.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // Nothing materializes on the non-fault path: the load executes inside
  // the body, at its use, without a scratch local.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // Only the external's binding local.
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("captureForBody captures a deferred output's input closure, not the output", () => {
  const values = new ValueTable();
  const base = values.external(0);
  const four = values.const(4);
  const address = values.binary("add", base, four);
  const loaded = values.addActionOutput();
  const condition = values.external(1);
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const faultBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), loaded),
      {
        kind: "finish",
        finish: {
          kind: "exit",
          exit: {
            class: "cpuException",
            exception: pageFault(four, PageFaultErrorCode.WRITE)
          }
        }
      }
    ]
  };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody }
    ]),
    [0, 1]
  );

  valueStack.scheduledProducer(readAction);
  valueStack.captureForBody(faultBody);
  valueStack.emitUse(condition);
  body.ifBlock();
  valueStack.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The address computes into a local before the branch — re-emitting the
  // load inside the body needs it — while the load itself stays inside.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.localGet,
    wasmOpcode.i32Load,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // The two external binding locals plus the captured address.
  strictEqual(wasmBodyLocalCount(encoded), 3);
});

test("sibling fault bodies each emit a deferred producer, keeping the main path clean", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const firstCondition = values.external(0);
  const secondCondition = values.external(1);
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const hostTrap: Action = {
    kind: "finish",
    finish: { kind: "exit", exit: { class: "host", reason: "hostTrap" } }
  };
  const firstBody: Body = { actions: [stateWrite(gprChannel("eax"), loaded), hostTrap] };
  const secondBody: Body = { actions: [stateWrite(gprChannel("ebx"), loaded), hostTrap] };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition: firstCondition, thenBody: firstBody },
      { kind: "if", condition: secondCondition, thenBody: secondBody }
    ]),
    [0, 1]
  );

  valueStack.scheduledProducer(readAction);
  valueStack.captureForBody(firstBody);
  valueStack.emitUse(firstCondition);
  body.ifBlock();
  valueStack.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueStack.captureForBody(secondBody);
  valueStack.emitUse(secondCondition);
  body.ifBlock();
  valueStack.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // Neither body's emission dominates the other's use, so each re-emits
  // the load; no set, no tee, nothing outside the bodies.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // Only the externals' binding locals.
  strictEqual(wasmBodyLocalCount(encoded), 2);
});

test("a direct use behind a fault body emits once at the body's entry and replays", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const condition = values.external(0);
  const readAction: StateReadAction = stateRead(read, gprChannel("ebx"));
  const faultBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), read),
      { kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "hostTrap" } } }
    ]
  };
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody },
      stateWrite(gprChannel("ecx"), read)
    ]),
    [0]
  );

  valueStack.scheduledProducer(readAction);
  valueStack.captureForBody(faultBody);
  valueStack.emitUse(condition);
  body.ifBlock();
  valueStack.emitUse(read);
  body.drop();
  body.endBlock();
  valueStack.emitUse(read);
  body.drop();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The scope's own use means its flow pays for the value either way, so
  // captureForBody realizes the emission: one slot load set to a local
  // before the guard, replayed by the fault body and the later use.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.localGet,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.localGet,
    wasmOpcode.drop,
    wasmOpcode.end
  ]);
  // The external's binding local plus the one scratch local.
  strictEqual(wasmBodyLocalCount(encoded), 2);
});

test("captureForBody computes an untouched compound into a local for later uses", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );
  // A nested body consuming the compound twice plus a leaf: one capture,
  // the rest are no-ops (replay for the compound, inline for the const).
  const nestedBody: Body = {
    actions: [
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum),
      {
        kind: "finish",
        finish: {
          kind: "exit",
          exit: {
            class: "cpuException",
            exception: pageFault(five, PageFaultErrorCode.WRITE)
          }
        }
      }
    ]
  };

  valueStack.scheduledProducer(readAction);
  valueStack.captureForBody(nestedBody);
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
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);
  valueStack.emitUse(sum);

  throws(() => valueStack.assertClear(), /captured values with unconsumed uses/);
  throws(() => scratch.assertClear(), /scratch locals still in use/);
});

test("a borrowed compound computes once and replays from a pinned local", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);

  const borrow = valueStack.borrowUse(sum);

  borrow.push();
  borrow.push();
  borrow.release();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The first push tees the computed value into a local held only by the
  // borrow's pin; the second peeks it.
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

test("a borrowed leaf re-emits per push without scratch locals", () => {
  const values = new ValueTable();
  const external = values.external(3);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [3]
  );

  const borrow = valueStack.borrowUse(external);

  borrow.push();
  borrow.push();
  borrow.release();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  // Only the external's binding local — the borrow held no scratch.
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a borrow leaves registry lifetimes intact for later counted uses", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);

  const borrow = valueStack.borrowUse(sum);

  borrow.push();
  borrow.push();
  borrow.release();
  valueStack.emitUse(sum);
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The borrow's first push takes one counted use of the compound the
  // registry teed for its remaining use; the second push peeks that same
  // local under the pin, and the last use replays and frees it.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a borrow holds a spent registry local until release", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const { body, scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), loaded)
    ])
  );

  valueStack.scheduledProducer(readAction);

  const borrow = valueStack.borrowUse(loaded);

  borrow.push();
  borrow.push();
  borrow.release();
  valueStack.assertClear();
  scratch.assertClear();

  const encoded = body.end().encode();

  // The first push emits the deferred load and consumes its only counted
  // use; the pin tees it into a local for the second push and frees it at
  // release.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a leaked borrow fails assertClear and holds its scratch local", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { scratch, valueStack } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueStack.scheduledProducer(readAction);

  const borrow = valueStack.borrowUse(sum);

  borrow.push();

  throws(() => valueStack.assertClear(), /borrowed values never released/);
  throws(() => scratch.assertClear(), /scratch locals still in use/);
});

test("a released borrow refuses further pushes and releases", () => {
  const values = new ValueTable();
  const external = values.external(0);
  const { valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [0]
  );
  const borrow = valueStack.borrowUse(external);

  borrow.push();
  borrow.release();

  throws(() => borrow.push(), /pushed after release/);
  throws(() => borrow.release(), /released twice/);
});

test("a borrow must observe its value before release", () => {
  const values = new ValueTable();
  const external = values.external(0);
  const { valueStack } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [0]
  );
  const borrow = valueStack.borrowUse(external);

  throws(() => borrow.release(), /released without a push/);
});
