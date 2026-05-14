import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { buildIr } from "#x86/ir/build/builder.js";

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

test("builder exposes unknown operand metadata by default", () => {
  deepStrictEqual(
    buildIr((s, context) => {
      const operandInfo = context.operandInfo(0);

      s.set(s.reg("eax"), operandInfo.storage === "mem" ? 1 : 0);
    }),
    [
      {
        op: "set",
        target: { kind: "reg", reg: "eax" },
        value: { kind: "const", type: "i32", value: 0 },
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
