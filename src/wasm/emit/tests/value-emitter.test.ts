import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { ExternalValueId } from "#ir/operands.js";
import { gprChannel, lazyFlagsBChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import type { Body } from "#ir/block.js";
import { bodyInputValues } from "#ir/traverse.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { emitOp, type BorrowedUse } from "#wasm/emit/ops.js";
import { ValueEmitter } from "#wasm/emit/value-emitter.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";
import { analyzeValueUses } from "#wasm/emit/value-uses.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { LegacyHelperIndexRegistryAdapter } from "#wasm/helpers/registry.js";
import {
  wasmBodyInstructions,
  wasmBodyLocalCount,
  wasmBodyOpcodes
} from "#compiler/encoder/tests/body-opcodes.js";
import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import { memoryRead, resolveFlag, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import type { MemoryReadAction, ResolveFlagAction, StateReadAction } from "#ir/tests/storage-op-helpers.js";

function testBody(actions: readonly Action[]): Body {
  return { actions };
}

function captureBodyValues(valueEmitter: ValueEmitter, values: ValueTable, body: Body): void {
  valueEmitter.captureValues(bodyInputValues(body, values));
}

function zfHelperRegistry() {
  return new LegacyHelperIndexRegistryAdapter([
    { key: { kind: "lazyFlag", flag: "ZF" }, functionIndex: 0 }
  ]);
}

type TestEmitter = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  valueEmitter: ValueEmitter;
}>;

function createTestEmitter(
  values: ValueTable,
  actionBody: Body,
  externalIds: readonly ExternalValueId[] = [],
  helpers = new LegacyHelperIndexRegistryAdapter([])
): TestEmitter {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const externalLocals = new Map(externalIds.map((id) => [id, body.addLocal(wasmValueType.i32)]));
  const block = { body: actionBody, values };
  const valueEmitter = new ValueEmitter({
    body,
    scratch,
    values,
    uses: analyzeValueUses(block, analyzeLiveness(block)),
    externalLocals,
    // The real op lowering: its state and guest accesses emit the same
    // opcode shapes the assertions pin (const address + load).
    emitOp: (op, operands) => emitOp(body, helpers, op, operands),
    claimProducerAtUse: (output) => {
      throw new Error(`action output ${output} has no test schedule`);
    }
  });

  return { body, scratch, valueEmitter };
}

test("captureProducer emits a flag resolve and binds its result", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const helpers = zfHelperRegistry();
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    helpers
  );

  valueEmitter.captureProducer(resolveAction);
  valueEmitter.emitUse(resolved);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.call,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("captureProducer observes lazy flags before later mutation", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const record = values.const(0);
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const helpers = zfHelperRegistry();

  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(lazyFlagsBChannel, record),
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    helpers
  );

  valueEmitter.captureProducer(resolveAction);
  valueEmitter.emitUse(resolved);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  // The lazy record between resolve and use pins the observation point.
  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.call,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
});

test("captureProducer reports a missing flag helper", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const { valueEmitter } = createTestEmitter(
    values,
    testBody([
      resolveAction,
      stateWrite(gprChannel("eax"), resolved)
    ]),
    [],
    new LegacyHelperIndexRegistryAdapter([])
  );

  throws(
    () => valueEmitter.captureProducer(resolveAction),
    /missing Wasm helper resolveZF/
  );
});

test("a flag resolve with no event emits nothing", () => {
  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const resolveAction: ResolveFlagAction = resolveFlag(resolved, "ZF");
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([resolveAction]),
    [],
    new LegacyHelperIndexRegistryAdapter([])
  );

  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("a capture event stores even a single-use result for replay", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(sum);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a multi-use value tees once and replays from one freed local", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(sum);
  valueEmitter.emitUse(sum);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
  deepStrictEqual(
    wasmBodyInstructions(encoded)
      .filter((instruction) => instruction.local !== undefined)
      .map((instruction) => instruction.local),
    [0, 0, 0, 0]
  );
});

test("captured reads preserve both snapshots across swapped writes", () => {
  const values = new ValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const readEax: StateReadAction = stateRead(eax, gprChannel("eax"));
  const readEbx: StateReadAction = stateRead(ebx, gprChannel("ebx"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readEax,
      readEbx,
      stateWrite(gprChannel("ebx"), eax),
      stateWrite(gprChannel("eax"), ebx)
    ])
  );

  valueEmitter.captureProducer(readEax);
  valueEmitter.captureProducer(readEbx);
  valueEmitter.emitUse(eax);
  valueEmitter.emitUse(ebx);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  // Both capture events execute before either write consumes a snapshot.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 2);
});

test("a dead read emits nothing", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), seven)
    ])
  );

  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [wasmOpcode.end]);
  strictEqual(wasmBodyLocalCount(encoded), 0);
});

test("constant and external leaves re-emit per use without scratch locals", () => {
  const values = new ValueTable();
  const seven = values.const(7);
  const external = values.external(3);
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), seven),
      stateWrite(gprChannel("ebx"), seven),
      stateWrite(gprChannel("ecx"), external),
      stateWrite(gprChannel("edx"), external)
    ]),
    [3]
  );

  valueEmitter.emitUse(seven);
  valueEmitter.emitUse(seven);
  valueEmitter.emitUse(external);
  valueEmitter.emitUse(external);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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
  const { valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ])
  );

  throws(() => valueEmitter.emitUse(external), /no local bound for external value 3/);
});

test("select pushes whenTrue, whenFalse, then condition", () => {
  const values = new ValueTable();
  const one = values.external(0);
  const two = values.external(1);
  const whenTrue = values.unary("popcnt", one);
  const condition = values.compare(32, "lt_u", one, two);
  const select = values.select(condition, whenTrue, two);
  const { body, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), select)
    ]),
    [0, 1]
  );

  valueEmitter.emitUse(select);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
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
  const trailingZeros = values.unary("ctz", one);
  const leadingZeros = values.unary("clz", two);
  const product = values.binary("mul", one, two);
  const signedQuotient = values.binary("div_s", one, two);
  const unsignedQuotient = values.binary("div_u", one, two);
  const signedRemainder = values.binary("rem_s", one, two);
  const remainder = values.binary("rem_u", one, two);
  const rotatedLeft = values.binary("rotl", one, two);
  const rotatedRight = values.binary("rotr", one, two);
  const extended8 = values.extend(8, one, true);
  const extended16 = values.extend(16, two, true);
  const masked = values.binary("sub", values.binary("and", one, two), values.binary("or", one, two));
  const equal = values.compare(32, "eq", one, two);
  const signed = values.compare(32, "ge_s", one, two);
  const { body, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), mixed),
      stateWrite(gprChannel("esi"), trailingZeros),
      stateWrite(gprChannel("esi"), leadingZeros),
      stateWrite(gprChannel("esi"), product),
      stateWrite(gprChannel("esi"), signedQuotient),
      stateWrite(gprChannel("esi"), unsignedQuotient),
      stateWrite(gprChannel("esi"), signedRemainder),
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

  valueEmitter.emitUse(mixed);
  valueEmitter.emitUse(trailingZeros);
  valueEmitter.emitUse(leadingZeros);
  valueEmitter.emitUse(product);
  valueEmitter.emitUse(signedQuotient);
  valueEmitter.emitUse(unsignedQuotient);
  valueEmitter.emitUse(signedRemainder);
  valueEmitter.emitUse(remainder);
  valueEmitter.emitUse(rotatedLeft);
  valueEmitter.emitUse(rotatedRight);
  valueEmitter.emitUse(extended8);
  valueEmitter.emitUse(extended16);
  valueEmitter.emitUse(masked);
  valueEmitter.emitUse(equal);
  valueEmitter.emitUse(signed);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
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
    wasmOpcode.i32Ctz,
    wasmOpcode.localGet,
    wasmOpcode.i32Clz,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32Mul,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32DivS,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32DivU,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.i32RemS,
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), overflow16),
      stateWrite(gprChannel("ebx"), overflow32)
    ]),
    [0, 1]
  );

  valueEmitter.emitUse(overflow16);
  valueEmitter.emitUse(overflow32);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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
  const five = values.extend64(32, values.external(4), false);
  const six = values.extend64(32, values.external(5), false);
  const seven = values.extend64(32, values.external(6), true);
  const eight = values.extend64(32, values.external(7), true);
  const nine = values.extend64(32, values.external(8), true);
  const ten = values.extend64(32, values.external(9), true);
  const either = values.binary64("or", one, two);
  const quotient = values.binary64("div_u", three, four);
  const remainder = values.binary64("rem_u", five, six);
  const signedQuotient = values.binary64("div_s", seven, eight);
  const signedRemainder = values.binary64("rem_s", nine, ten);
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), either),
      stateWrite(gprChannel("ebx"), quotient),
      stateWrite(gprChannel("ecx"), remainder),
      stateWrite(gprChannel("edx"), signedQuotient),
      stateWrite(gprChannel("esi"), signedRemainder)
    ]),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  );

  valueEmitter.emitUse(either);
  valueEmitter.emitUse(quotient);
  valueEmitter.emitUse(remainder);
  valueEmitter.emitUse(signedQuotient);
  valueEmitter.emitUse(signedRemainder);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.i64Or,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.i64DivU,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32U,
    wasmOpcode.i64RemU,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64DivS,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64RemS,
    wasmOpcode.end
  ]);
});

test("i64 equality against an i64 constant lowers to i64.const and i64.eq", () => {
  const values = new ValueTable();
  const value = values.extend64(32, values.external(0), true);
  const equal = values.compare64("eq", value, values.const64(-0x8000_0000_0000_0000n));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), equal)
    ]),
    [0]
  );

  valueEmitter.emitUse(equal);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Const,
    wasmOpcode.i64Eq,
    wasmOpcode.end
  ]);
});

test("i64 binary and comparison operators use their direct opcodes", () => {
  const values = new ValueTable();
  const one = values.extend64(32, values.external(0), true);
  const two = values.extend64(32, values.external(1), true);
  const sum = values.binary64("add", one, two);
  const less = values.compare64("lt_s", one, two);
  const sumEmitter = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), sum)
    ]),
    [0, 1]
  );
  const lessEmitter = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), less)
    ]),
    [0, 1]
  );

  sumEmitter.valueEmitter.emitUse(sum);
  sumEmitter.valueEmitter.releaseFragmentLocals();
  sumEmitter.valueEmitter.assertClear();
  lessEmitter.valueEmitter.emitUse(less);
  lessEmitter.valueEmitter.releaseFragmentLocals();
  lessEmitter.valueEmitter.assertClear();

  deepStrictEqual(wasmBodyOpcodes(sumEmitter.body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64Add,
    wasmOpcode.end
  ]);
  deepStrictEqual(wasmBodyOpcodes(lessEmitter.body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.localGet,
    wasmOpcode.i64ExtendI32S,
    wasmOpcode.i64LtS,
    wasmOpcode.end
  ]);
});

test("truncate masks to the requested width", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const low8 = values.truncate(8, read);
  const low16 = values.truncate(16, read);
  const full = values.truncate(32, read);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), low8),
      stateWrite(gprChannel("ecx"), low16),
      stateWrite(gprChannel("edx"), full)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(low8);
  valueEmitter.emitUse(low16);
  valueEmitter.emitUse(full);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();

  // One capture supplies both truncations.
  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32And,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
});

test("equality against constant zero canonicalizes to eqz from either side", () => {
  const values = new ValueTable();
  const external = values.external(3);
  const zero = values.const(0);
  const left = values.compare(32, "eq", external, zero);
  const right = values.compare(32, "eq", zero, external);

  deepStrictEqual(values.node(left), { kind: "unary", operator: "eqz", value: external });
  strictEqual(right, left);

  const { body, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), left),
      stateWrite(gprChannel("ebx"), right)
    ]),
    [3]
  );

  valueEmitter.emitUse(left);
  valueEmitter.emitUse(right);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i32Eqz,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
});

test("ne and non-zero equality keep the generic compare", () => {
  const values = new ValueTable();
  const external = values.external(3);
  const notZero = values.compare(32, "ne", external, values.const(0));
  const one = values.compare(32, "eq", external, values.const(1));
  const { body, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), notZero),
      stateWrite(gprChannel("ebx"), one)
    ]),
    [3]
  );

  valueEmitter.emitUse(notZero);
  valueEmitter.emitUse(one);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();

  deepStrictEqual(wasmBodyOpcodes(body.finish().bytes), [
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Ne,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Eq,
    wasmOpcode.end
  ]);
});

test("a captured memory read loads once and replays twice", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), loaded),
      stateWrite(gprChannel("ebx"), loaded)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(loaded);
  valueEmitter.emitUse(loaded);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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

test("a captured state read loads once and replays twice", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), read),
      stateWrite(gprChannel("ecx"), read)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(read);
  valueEmitter.emitUse(read);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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

test("a captured producer remains available to a nested body", () => {
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody }
    ]),
    [0]
  );

  valueEmitter.captureProducer(readAction);
  captureBodyValues(valueEmitter, values, faultBody);
  valueEmitter.emitUse(condition);
  body.ifBlock();
  valueEmitter.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  // This unit invokes the capture primitive explicitly before control.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.localGet,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // The external binding plus the action-output local.
  strictEqual(wasmBodyLocalCount(encoded), 2);
});

test("captureProducer evaluates its input closure before storing the result", () => {
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody }
    ]),
    [0, 1]
  );

  valueEmitter.captureProducer(readAction);
  captureBodyValues(valueEmitter, values, faultBody);
  valueEmitter.emitUse(condition);
  body.ifBlock();
  valueEmitter.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.if,
    wasmOpcode.localGet,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // The two external binding locals plus the output local.
  strictEqual(wasmBodyLocalCount(encoded), 3);
});

test("sibling bodies read one producer local initialized before both", () => {
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition: firstCondition, thenBody: firstBody },
      { kind: "if", condition: secondCondition, thenBody: secondBody }
    ]),
    [0, 1]
  );

  valueEmitter.captureProducer(readAction);
  captureBodyValues(valueEmitter, values, firstBody);
  valueEmitter.emitUse(firstCondition);
  body.ifBlock();
  valueEmitter.emitUse(loaded);
  body.drop();
  body.endBlock();
  captureBodyValues(valueEmitter, values, secondBody);
  valueEmitter.emitUse(secondCondition);
  body.ifBlock();
  valueEmitter.emitUse(loaded);
  body.drop();
  body.endBlock();
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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
    wasmOpcode.if,
    wasmOpcode.localGet,
    wasmOpcode.drop,
    wasmOpcode.end,
    wasmOpcode.end
  ]);
  // The external bindings plus the shared output local.
  strictEqual(wasmBodyLocalCount(encoded), 3);
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      { kind: "if", condition, thenBody: faultBody },
      stateWrite(gprChannel("ecx"), read)
    ]),
    [0]
  );

  valueEmitter.captureProducer(readAction);
  captureBodyValues(valueEmitter, values, faultBody);
  valueEmitter.emitUse(condition);
  body.ifBlock();
  valueEmitter.emitUse(read);
  body.drop();
  body.endBlock();
  valueEmitter.emitUse(read);
  body.drop();
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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
  const { body, scratch, valueEmitter } = createTestEmitter(
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

  valueEmitter.captureProducer(readAction);
  captureBodyValues(valueEmitter, values, nestedBody);
  valueEmitter.emitUse(sum);
  valueEmitter.emitUse(sum);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  // One computation set into a local, two replays.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
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
  const { scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.emitUse(sum);

  throws(() => valueEmitter.assertClear(), /value bindings never released/);
  throws(() => scratch.assertClear(), /scratch locals still in use/);
});

test("assertClear detects semantic var and loop-input binding leaks", () => {
  const values = new ValueTable();
  const loopInput = values.addLoopInput();
  const { scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), loopInput)
    ])
  );
  const loopLocal = scratch.allocLocal(wasmValueType.i32);

  valueEmitter.varLocal(7);
  valueEmitter.bindLoopInput(loopInput, loopLocal);

  throws(() => valueEmitter.assertClear(), /loop inputs never unbound/);

  valueEmitter.unbindLoopInput(loopInput);
  throws(() => valueEmitter.assertClear(), /semantic var locals never released/);

  scratch.freeLocal(loopLocal);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();
});

test("a borrowed compound computes once and replays from a pinned local", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.withBorrowedUse(sum, (borrow) => {
    borrow.push();
    borrow.push();
  });
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  // The first push tees the computed value into a local held only by the
  // borrow's pin; the second peeks it.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [3]
  );

  valueEmitter.withBorrowedUse(external, (borrow) => {
    borrow.push();
    borrow.push();
  });
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.withBorrowedUse(sum, (borrow) => {
    borrow.push();
    borrow.push();
  });
  valueEmitter.emitUse(sum);
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  // The borrow's first push takes one counted use of the compound the
  // registry teed for its remaining use; the second push peeks that same
  // local under the pin, and the last use replays and frees it.
  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});

test("a borrow peeks a stable action-output local", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const readAction: MemoryReadAction = memoryRead(loaded, address, 32);
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("eax"), loaded)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.withBorrowedUse(loaded, (borrow) => {
    borrow.push();
    borrow.push();
  });
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

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

test("a borrowed local is unpinned when its callback throws", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);

  throws(
    () => valueEmitter.withBorrowedUse(sum, (borrow) => {
      borrow.push();
      throw new Error("borrow callback failed");
    }),
    /borrow callback failed/
  );
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();
});

test("a borrowed handle cannot push outside its callback scope", () => {
  const values = new ValueTable();
  const external = values.external(0);
  const { valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [0]
  );
  let escaped: BorrowedUse | undefined;

  valueEmitter.withBorrowedUse(external, (borrow) => {
    escaped = borrow;
    borrow.push();
  });

  throws(() => escaped!.push(), /pushed outside its scope/);
});

test("a borrow callback must observe its value", () => {
  const values = new ValueTable();
  const external = values.external(0);
  const { valueEmitter } = createTestEmitter(
    values,
    testBody([
      stateWrite(gprChannel("eax"), external)
    ]),
    [0]
  );
  throws(() => valueEmitter.withBorrowedUse(external, () => {}), /was never pushed/);
});

test("nested borrows keep the same local pinned until the outer callback ends", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const sum = values.binary("add", read, values.const(5));
  const readAction: StateReadAction = stateRead(read, gprChannel("eax"));
  const { body, scratch, valueEmitter } = createTestEmitter(
    values,
    testBody([
      readAction,
      stateWrite(gprChannel("ebx"), sum),
      stateWrite(gprChannel("ecx"), sum)
    ])
  );

  valueEmitter.captureProducer(readAction);
  valueEmitter.withBorrowedUse(sum, (outer) => {
    outer.push();
    valueEmitter.withBorrowedUse(sum, (inner) => {
      inner.push();
      inner.push();
    });
    outer.push();
  });
  valueEmitter.releaseFragmentLocals();
  valueEmitter.assertClear();
  scratch.assertClear();

  const encoded = body.finish().bytes;

  deepStrictEqual(wasmBodyOpcodes(encoded), [
    wasmOpcode.i32Const,
    wasmOpcode.i32Load,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.i32Const,
    wasmOpcode.i32Add,
    wasmOpcode.localTee,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.localGet,
    wasmOpcode.end
  ]);
  strictEqual(wasmBodyLocalCount(encoded), 1);
});
