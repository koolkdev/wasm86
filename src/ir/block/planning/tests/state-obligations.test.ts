import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import {
  analyzeStateObligations,
  buildTimelineGeometry,
  type StateObligation
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import type {
  IrBlock,
  IrConstValueRef,
  IrValueType,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("AL write before exit creates AL obligation only", () => {
  const { obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5) },
    { op: "next" }
  ]);

  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("al") },
        value: exprConst(5)
      }
    }
  ]);
});

test("EAX then AL creates ordered EAX and AL obligations", () => {
  const { obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x1234) },
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5) },
    { op: "next" }
  ]);

  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("eax") },
        value: exprConst(0x1234)
      }
    },
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("al") },
        value: exprConst(5)
      }
    }
  ]);
});

test("AL then EAX creates EAX obligation only", () => {
  const { obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5) },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x1234) },
    { op: "next" }
  ]);

  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("eax") },
        value: exprConst(0x1234)
      }
    }
  ]);
});

test("no-op writes that leave the snapshot equal to the baseline create no obligations", () => {
  const eax = v(0);
  const { obligations } = analyzeBlock([
    { op: "get", dst: eax, source: { kind: "reg", reg: "eax" } },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: eax },
    { op: "next" }
  ]);

  deepStrictEqual(obligations, []);
});

test("dynamic-register-store pre-state uses the action stateBefore snapshot", () => {
  const { geometry, obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11) },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(2), 32)]
    })
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;

  strictEqual(obligations.length, 1);
  strictEqual(obligations[0]!.reason, "dynamic-register-store-pre-state");
  strictEqual(obligations[0]!.point, dynamicStore.preStatePoint);
  deepStrictEqual(obligations[0]!.write, {
    target: { kind: "reg", reg: registerAlias("eax") },
    value: exprConst(0x11)
  });
});

test("dynamic-register-store is register-only and leaves pending flags for the exit", () => {
  const { geometry, obligations } = analyzeBlock([
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) }
      }
    },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(2), 32)]
    })
  });
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(obligations.length, 1);
  strictEqual(obligations[0]!.point, fallthrough.point);
  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "flag", flag: "CF" },
        value: exprConst(1)
      }
    }
  ]);
});

test("dynamic-register-store emits pending registers before the store and leaves flags for exit", () => {
  const { geometry, obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11) },
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) }
      }
    },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(2), 32)]
    })
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(obligations.length, 2);
  strictEqual(obligations[0]!.point, dynamicStore.preStatePoint);
  strictEqual(obligations[1]!.point, fallthrough.point);
  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "dynamic-register-store-pre-state",
      write: {
        target: { kind: "reg", reg: registerAlias("eax") },
        value: exprConst(0x11)
      }
    },
    {
      reason: "exit-state",
      write: {
        target: { kind: "flag", flag: "CF" },
        value: exprConst(1)
      }
    }
  ]);
});

test("later writes after an exit source point do not affect that exit path", () => {
  const { geometry, obligations } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(2) },
    { op: "next" }
  ]);
  const memoryFault = geometry.exits.points.find((point) => point.exit.kind === "memoryFault")!;
  const fallthrough = geometry.exits.points.find((point) => point.exit.kind === "fallthrough")!;

  strictEqual(obligations.length, 2);
  strictEqual(obligations[0]!.point, memoryFault.point);
  strictEqual(obligations[1]!.point, fallthrough.point);
  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("eax") },
        value: exprConst(1)
      }
    },
    {
      reason: "exit-state",
      write: {
        target: { kind: "reg", reg: registerAlias("eax") },
        value: exprConst(2)
      }
    }
  ]);
});

test("flag obligations include defined and architecturally undefined changes", () => {
  const { obligations } = analyzeBlock([
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) },
        AF: { kind: "undef" }
      }
    },
    { op: "next" }
  ]);

  deepStrictEqual(obligationWrites(obligations), [
    {
      reason: "exit-state",
      write: {
        target: { kind: "flag", flag: "CF" },
        value: exprConst(1)
      }
    },
    {
      reason: "exit-state",
      write: {
        target: { kind: "flag", flag: "AF" },
        value: undefined
      }
    }
  ]);
});

test("direct flag-condition caches do not create architectural obligations", () => {
  const { obligations } = analyzeBlock([
    {
      op: "flags.write",
      cells: {},
      conditions: {
        E: c(1)
      }
    },
    { op: "next" }
  ]);

  deepStrictEqual(obligations, []);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  geometry: ReturnType<typeof buildTimelineGeometry>;
  obligations: readonly StateObligation[];
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);

  return {
    geometry,
    obligations: analyzeStateObligations({ walked, geometry }).obligations
  };
}

function obligationWrites(obligations: readonly StateObligation[]): readonly unknown[] {
  return obligations.map((obligation) => ({
    reason: obligation.reason,
    write: obligation.write
  }));
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): IrConstValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
