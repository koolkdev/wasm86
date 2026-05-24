import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { buildIr } from "#x86/ir/build/builder.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";

test("builder appends implicit next for fallthrough templates", () => {
  deepStrictEqual(buildIr(() => {}), [{ op: "next" }]);
});

test("builder rejects ops after a terminator", () => {
  throws(
    () =>
      buildIr((s) => {
        s.jump(s.get(s.operand(0)));
        s.get(s.operand(1));
      }),
    /cannot emit get after IR terminator/
  );
});

test("builder rejects missing semantic operand metadata", () => {
  throws(
    () =>
      buildIr((_s, context) => {
        context.operandInfo(0);
      }),
    /missing semantic operand metadata for operand 0/
  );
});

test("builder exposes register operand metadata explicitly", () => {
  deepStrictEqual(
    buildIr(
      (s, context) => {
        const operandInfo = context.operandInfo(0);

        s.set(s.reg("eax"), operandInfo.storage === "reg" ? 1 : 0);
      },
      { operandInfo: [{ storage: "reg" }] }
    ),
    [
      {
        op: "set",
        target: { kind: "reg", reg: "eax" },
        value: { kind: "const", type: "i32", value: 1 },
        accessWidth: 32
      },
      { op: "next" }
    ]
  );
});

test("builder exposes semantic operand metadata", () => {
  deepStrictEqual(
    buildIr(
      (s, context) => {
        const operandInfo = context.operandInfo(0);

        s.set(s.reg("eax"), operandInfo.storage === "mem" ? 1 : 0);
      },
      { operandInfo: [{ storage: "mem" }] }
    ),
    [
      {
        op: "set",
        target: { kind: "reg", reg: "eax" },
        value: { kind: "const", type: "i32", value: 1 },
        accessWidth: 32
      },
      { op: "next" }
    ]
  );
});

test("builder constructs explicit memory guards with byte lengths", () => {
  deepStrictEqual(
    buildIr((s) => {
      const address = s.address(s.operand(0));
      const memory = s.mem(address);

      s.memoryGuard(address, 4, "read");
      s.get(memory);
    }),
    [
      { op: "address", dst: { kind: "var", id: 0 }, operand: { kind: "operand", index: 0 } },
      { op: "memory.guard", address: { kind: "var", id: 0 }, byteLength: 4, access: "read" },
      {
        op: "get",
        dst: { kind: "var", id: 1 },
        source: { kind: "mem", address: { kind: "var", id: 0 } },
        accessWidth: 32
      },
      { op: "next" }
    ]
  );
});

test("plain get and set do not emit implicit memory guards", () => {
  deepStrictEqual(
    buildIr((s) => {
      const memory = s.mem(s.const32(0x1000));

      s.get(memory);
      s.set(memory, 1);
    }).map((op) => op.op),
    ["get", "set", "next"]
  );
});

test("builder creates semantic flag write with one expression cell and no conditions", () => {
  deepStrictEqual(
    buildIr((s) => {
      const value = s.get(s.operand(0));

      s.writeFlags({
        cells: {
          ZF: s.flagExpr(value)
        }
      });
    }),
    [
      { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
      {
        op: "flags.write",
        cells: {
          ZF: { kind: "expr", value: { kind: "var", id: 0 } }
        }
      },
      { op: "next" }
    ]
  );
});

test("builder creates partial semantic flag write with undef cell and sparse conditions", () => {
  deepStrictEqual(
    buildIr((s) => {
      const result = s.get(s.operand(0));
      const eq = s.i32Select(result, 1, 0);

      s.writeFlags({
        cells: {
          ZF: s.flagExpr(eq),
          AF: s.flagUndef()
        },
        conditions: {
          E: eq
        }
      });
    }),
    [
      { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
      {
        op: "value.select",
        type: "i32",
        dst: { kind: "var", id: 1 },
        condition: { kind: "var", id: 0 },
        whenTrue: { kind: "const", type: "i32", value: 1 },
        whenFalse: { kind: "const", type: "i32", value: 0 }
      },
      {
        op: "flags.write",
        cells: {
          ZF: { kind: "expr", value: { kind: "var", id: 1 } },
          AF: { kind: "undef" }
        },
        conditions: {
          E: { kind: "var", id: 1 }
        }
      },
      { op: "next" }
    ]
  );
});

test("builder still creates legacy flag producer writes through setFlags", () => {
  deepStrictEqual(
    buildIr((s) => {
      const result = s.get(s.operand(0));

      s.setFlags("logic", { result }, 8);
    }),
    [
      { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
      createIrFlagSetOp("logic", { result: { kind: "var", id: 0 } }, 8),
      { op: "next" }
    ]
  );
});
