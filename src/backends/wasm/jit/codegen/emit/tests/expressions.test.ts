import {
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { emitWasmIrStoreGuestUnchecked } from "#backends/wasm/codegen/memory.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import {
  exprBits,
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprProject,
  exprUnary
} from "#x86/expr/builders.js";
import {
  bitsUse,
  exactUse,
  full32Use
} from "#x86/expr/uses.js";
import type {
  ExprRef,
  ExprUse,
  ExprInputSource
} from "#x86/expr/types.js";
import {
  emitExpr,
  type EmittedExpr,
  type ExprEmitContext
} from "#backends/wasm/jit/codegen/emit/expressions.js";

test("ExprEmitter low-byte consumer of low-byte projection emits no redundant mask", () => {
  const result = emitTestExpr(exprProject(8, eax()), bitsUse(0xff));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
});

test("ExprEmitter high-byte consumer of low-byte projection emits zero without reading source", () => {
  const result = emitTestExpr(exprProject(8, eax()), bitsUse(0xff00));

  strictEqual(countOpcode(result.opcodes, wasmOpcode.localGet), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Const), 1);
});

test("ExprEmitter full consumer of low-byte projection emits a clean masked value", () => {
  const result = emitTestExpr(exprProject(8, eax()), full32Use());

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

test("ExprEmitter byte memory store consumes only low byte", () => {
  const body = new WasmFunctionBodyEncoder();
  const context = testContext(body);

  emitWasmIrStoreGuestUnchecked(
    body,
    () => body.i32Const(0),
    () => {
      emitExpr(context, exprProject(8, eax()), bitsUse(0xff));
    },
    8
  );
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 0);
});

test("ExprEmitter full32 request emits a clean full-width stack value", () => {
  const result = emitTestExpr(exprBits(eax(), 8, 8), full32Use());

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32ShrU), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

test("ExprEmitter signed compares sign-extend 8-bit operands without pre-mask", () => {
  const result = emitTestExpr(exprCompare(8, "lt_s", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter signed compares sign-extend 16-bit operands without pre-mask", () => {
  const result = emitTestExpr(exprCompare(16, "lt_s", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter signed compares use direct i32 signed compare for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "lt_s", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtS), 1);
});

test("ExprEmitter unsigned compares clean 8-bit operands without sign extension", () => {
  const result = emitTestExpr(exprCompare(8, "lt_u", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter unsigned compares clean 16-bit operands without sign extension", () => {
  const result = emitTestExpr(exprCompare(16, "lt_u", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter unsigned compares use direct i32 unsigned compare for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "lt_u", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32LtU), 1);
});

test("ExprEmitter eq compares clean 8-bit operands", () => {
  const result = emitTestExpr(exprCompare(8, "eq", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Eq), 1);
});

test("ExprEmitter ne compares clean 16-bit operands", () => {
  const result = emitTestExpr(exprCompare(16, "ne", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 2);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Extend16S), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Ne), 1);
});

test("ExprEmitter eq compares use direct i32 equality for 32-bit operands", () => {
  const result = emitTestExpr(exprCompare(32, "eq", eax(), ebx()), exactUse());

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Eq), 1);
});

test("ExprEmitter popcnt emits the Wasm popcnt primitive", () => {
  const result = emitTestExpr(exprUnary("popcnt", exprBinary("and", eax(), exprConst(0xff))), exactUse());

  strictEqual(result.emitted.valueWidth.cleanWidth, 8);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Popcnt), 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32And), 1);
});

type TestEmitResult = Readonly<{
  emitted: EmittedExpr;
  opcodes: readonly number[];
}>;

function emitTestExpr(expr: ExprRef, use: ExprUse): TestEmitResult {
  const body = new WasmFunctionBodyEncoder();
  const emitted = emitExpr(testContext(body), expr, use);

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
      emitInput: (source, use) => {
        if (use.kind === "bits" && use.mask === 0) {
          body.i32Const(0);
          return {
            valueWidth: { logicalWidth: 8, cleanWidth: 8, constValue: 0 }
          };
        }

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
