import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  irOpDst,
  irOpIsTerminator,
  irOpResult
} from "#ir/model/op-semantics.js";
import type { IrOp } from "#ir/model/types.js";
import { const32, irVar } from "#ir/build/builder.js";

test("IR op semantics exposes results, dsts, and terminators", () => {
  const localDef: IrOp = { op: "value.binary", type: "i32", operator: "add", dst: irVar(1), a: irVar(0), b: const32(1) };
  const storageRead: IrOp = { op: "get", dst: irVar(2), source: { kind: "reg", reg: "eax" } };
  const store: IrOp = { op: "set", target: { kind: "reg", reg: "eax" }, value: irVar(1) };

  deepStrictEqual(irOpResult(localDef), { kind: "value", dst: irVar(1), sideEffect: "none" });
  deepStrictEqual(irOpResult(storageRead), { kind: "value", dst: irVar(2), sideEffect: "storageRead" });
  deepStrictEqual(irOpResult(store), { kind: "none" });
  strictEqual(irOpDst(localDef)?.id, 1);
  strictEqual(irOpDst(store), undefined);
  strictEqual(irOpIsTerminator({ op: "next" }), true);
  strictEqual(irOpIsTerminator(localDef), false);
});

test("IR select values expose their result", () => {
  const op: IrOp = {
    op: "value.select",
    type: "i32",
    dst: irVar(3),
    condition: irVar(0),
    whenTrue: irVar(1),
    whenFalse: irVar(2)
  };

  deepStrictEqual(irOpResult(op), { kind: "value", dst: irVar(3), sideEffect: "none" });
});

test("IR memory guards have no result and do not terminate", () => {
  const op: IrOp = {
    op: "memory.guard",
    address: irVar(0),
    byteLength: 4,
    access: "write"
  };

  deepStrictEqual(irOpResult(op), { kind: "none" });
  strictEqual(irOpIsTerminator(op), false);
});
