import {
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { emitWasmIrStoreGuestUnchecked } from "#wasm/codegen/memory.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import {
  exprBits,
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprProject,
  exprUnary
} from "#ir/expr/builders.js";
import type {
  ExprInputSource,
  ExprRef
} from "#ir/expr/types.js";
import {
  emitExpr,
  type EmittedExpr,
  type ExprEmitContext
} from "#backends/wasm/jit/codegen/emit/expressions.js";

test("ExprEmitter low-byte projection emits a clean masked value", () => {
  const result = emitTestExpr(exprProject(8, eax()));

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

test("ExprEmitter high-byte extraction emits shift and cleanup", () => {
  const result = emitTestExpr(exprBits(eax(), 8, 8));

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32ShrU), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

test("ExprEmitter byte memory store still leaves byte cleanup downstream", () => {
  const body = new WasmFunctionBodyEncoder();
  const context = testContext(body);

  emitWasmIrStoreGuestUnchecked(
    body,
    () => body.i32Const(0),
    () => {
      emitExpr(context, exprProject(8, eax()));
    },
    8
  );
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
});

test("ExprEmitter signed compares sign-extend 8-bit operands without pre-mask", () => {
  const result = emitTestExpr(exprCompare(8, "lt_s", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter signed compares sign-extend 16-bit operands without pre-mask", () => {
  const result = emitTestExpr(exprCompare(16, "lt_s", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter signed compares use direct i32 signed compare for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "lt_s", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter unsigned compares clean 8-bit operands without sign extension", () => {
  const result = emitTestExpr(exprCompare(8, "lt_u", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter unsigned compares clean 16-bit operands without sign extension", () => {
  const result = emitTestExpr(exprCompare(16, "lt_u", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter unsigned compares use direct i32 unsigned compare for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "lt_u", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter eq compares clean 8-bit operands", () => {
  const result = emitTestExpr(exprCompare(8, "eq", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Eq), 1);
});

test("ExprEmitter ne compares clean 16-bit operands", () => {
  const result = emitTestExpr(exprCompare(16, "ne", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Ne), 1);
});

test("ExprEmitter eq compares use direct i32 equality for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "eq", eax(), ebx()));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Eq), 1);
});

test("ExprEmitter popcnt emits the Wasm popcnt primitive", () => {
  const result = emitTestExpr(exprUnary("popcnt", exprBinary("and", eax(), exprConst(0xff))));

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Popcnt), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

type TestEmitResult = Readonly<{
  emitted: EmittedExpr;
  opcodes: readonly number[];
}>;

function emitTestExpr(expr: ExprRef): TestEmitResult {
  const body = new WasmFunctionBodyEncoder();
  const emitted = emitExpr(testContext(body), expr);

  body.end();
  return {
    emitted,
    opcodes: wasmBodyOpcodes(body.encode())
  };
}

function testContext(body: WasmFunctionBodyEncoder): ExprEmitContext {
  const locals = {
    eax: body.addLocal(wasmValueType.i32),
    ebx: body.addLocal(wasmValueType.i32),
    ZF: body.addLocal(wasmValueType.i32)
  };

  return {
    body,
    inputs: {
      emitInput: (source) => {
        body.localGet(localForSource(locals, source));
        return {
          valueWidth: { logicalWidth: 32, cleanWidth: 32 }
        };
      }
    }
  };
}

function localForSource(
  locals: Readonly<{ eax: number; ebx: number; ZF: number }>,
  source: ExprInputSource
): number {
  switch (source.kind) {
    case "reg":
      switch (source.reg) {
        case "eax":
          return locals.eax;
        case "ebx":
          return locals.ebx;
        default:
          throw new Error(`unexpected test register ${source.reg}`);
      }
    case "flag":
      if (source.flag !== "ZF") {
        throw new Error(`unexpected test flag ${source.flag}`);
      }
      return locals.ZF;
    case "def":
      throw new Error(`unexpected test block definition ${source.id}`);
  }
}

function eax(): ExprRef {
  return exprInput({ kind: "reg", reg: "eax" });
}

function ebx(): ExprRef {
  return exprInput({ kind: "reg", reg: "ebx" });
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}
