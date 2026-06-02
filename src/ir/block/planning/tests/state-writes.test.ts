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
  analyzeBarrierFacts,
  analyzeExpressionNeeds,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildTimelineGeometry,
  type ExprNeeds,
  type PlannedStateWrite,
  type StateObligations,
  type StateWritePlan,
  type ValuePlan
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import {
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

test("StateWritePlan keeps EAX then AL materialization order", () => {
  const { obligations, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x1234) },
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5) },
    { op: "next" }
  ]);

  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: obligations.obligations[0]!.id,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("eax") },
      value: {
        kind: "inline",
        expr: exprConst(0x1234)
      }
    },
    {
      obligation: obligations.obligations[1]!.id,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("al") },
      value: {
        kind: "inline",
        expr: exprConst(5)
      }
    }
  ]);
  strictEqual(stateWrites.writes[0]!.point, obligations.obligations[0]!.point);
  strictEqual(stateWrites.writes[1]!.point, obligations.obligations[1]!.point);
});

test("StateWritePlan keeps normalized AL then EAX as only an EAX write", () => {
  const { obligations, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5) },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x1234) },
    { op: "next" }
  ]);

  strictEqual(obligations.obligations.length, 1);
  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: obligations.obligations[0]!.id,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("eax") },
      value: {
        kind: "inline",
        expr: exprConst(0x1234)
      }
    }
  ]);
});

test("StateWritePlan preserves undefined flag writes without expression recipes", () => {
  const { obligations, stateWrites } = analyzeBlock([
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) },
        AF: { kind: "undef" }
      }
    },
    { op: "next" }
  ]);

  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: obligations.obligations[0]!.id,
      reason: "exit-state",
      target: { kind: "flag", flag: "CF" },
      value: {
        kind: "inline",
        expr: exprConst(1)
      }
    },
    {
      obligation: obligations.obligations[1]!.id,
      reason: "exit-state",
      target: { kind: "flag", flag: "AF" },
      value: undefined
    }
  ]);
});

test("StateWritePlan uses value-plan recipes for concrete write values", () => {
  const { facts, geometry, stateWrites, values } = analyzeBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c(0x1000) },
      accessWidth: 32
    },
    { op: "set", target: { kind: "mem", address: c(0x2000) }, value: c(1), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(0) },
    { op: "next" }
  ]);
  const definition = facts.definitions[0]!;
  const saved = values.savedExprs[0]!;
  const memoryStore = geometry.memory.writes[0]!;

  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: stateWrites.writes[0]!.obligation,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("ebx") },
      value: {
        kind: "saved-expr",
        saved: saved.id
      }
    }
  ]);
  deepStrictEqual(saved.expr, exprInput({ kind: "def", id: definition.id }));
  strictEqual(saved.saveAt, memoryStore.point);
});

test("StateWritePlan records dynamic-register-store pre-state writes", () => {
  const { geometry, obligations, stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x11) },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 },
    { op: "next" }
  ], {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(2), 32)]
    })
  });
  const dynamicStore = geometry.registers.dynamicStores[0]!;

  strictEqual(stateWrites.writes.length, 1);
  strictEqual(stateWrites.writes[0]!.point, dynamicStore.preStatePoint);
  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: obligations.obligations[0]!.id,
      reason: "dynamic-register-store-pre-state",
      target: { kind: "reg", reg: registerAlias("eax") },
      value: {
        kind: "inline",
        expr: exprConst(0x11)
      }
    }
  ]);
});

test("StateWritePlan concrete values reference matching state-obligation expression needs", () => {
  const { needs, stateWrites, values } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(0x22) },
    {
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: c(1) }
      }
    },
    { op: "next" }
  ]);

  for (const write of stateWrites.writes) {
    if (write.value === undefined) {
      continue;
    }

    strictEqual(write.value, recipeForWrite(write, needs, values));
  }
});

test("StateWritePlan follows snapshot-delta order rather than attempted write order", () => {
  const { stateWrites } = analyzeBlock([
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: c(2) },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c(1) },
    { op: "next" }
  ]);

  deepStrictEqual(writeSummaries(stateWrites.writes), [
    {
      obligation: stateWrites.writes[0]!.obligation,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("eax") },
      value: {
        kind: "inline",
        expr: exprConst(1)
      }
    },
    {
      obligation: stateWrites.writes[1]!.obligation,
      reason: "exit-state",
      target: { kind: "reg", reg: registerAlias("ebx") },
      value: {
        kind: "inline",
        expr: exprConst(2)
      }
    }
  ]);
});

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  facts: ReturnType<typeof analyzeBarrierFacts>;
  geometry: ReturnType<typeof buildTimelineGeometry>;
  obligations: StateObligations;
  needs: ExprNeeds;
  values: ValuePlan;
  stateWrites: StateWritePlan;
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ walked, geometry, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs, geometry, facts });
  const stateWrites = analyzeStateWrites({ obligations, needs, values });

  return {
    facts,
    geometry,
    obligations,
    needs,
    values,
    stateWrites
  };
}

function writeSummaries(writes: readonly PlannedStateWrite[]): readonly unknown[] {
  return writes.map((write) => ({
    obligation: write.obligation,
    reason: write.reason,
    target: write.target,
    value: write.value
  }));
}

function recipeForWrite(
  write: PlannedStateWrite,
  needs: ExprNeeds,
  values: ValuePlan
): NonNullable<PlannedStateWrite["value"]> {
  const need = needs.valueNeedByObligation.get(write.obligation);

  if (need === undefined) {
    throw new Error(`state write ${write.id} has no matching expression need`);
  }

  const recipe = values.recipeByNeed.get(need);

  if (recipe === undefined) {
    throw new Error(`state write ${write.id} has no matching expression recipe`);
  }

  return recipe;
}

function v(value: number): VarRef {
  return { kind: "var", id: value };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
