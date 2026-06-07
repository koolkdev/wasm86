import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import { modRmSelector } from "#ir/block/modrm-selector.js";
import type { StateObligation } from "#ir/block/planning/index.js";
import type { RegisterAccessMode } from "#ir/block/state/register-materialization.js";
import {
  exprConst,
  exprInput,
  exprInsertBits
} from "#ir/expr/builders.js";
import type {
  IrBlock,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  analyzeWasmBlock,
  wasmLocalRegisterAccessMode,
  wasmMemoryRegisterAccessMode
} from "#wasm/emit/block/analysis.js";

test("Wasm block analysis applies one register access mode to walk and state obligations", () => {
  const local = analyzeDynamicRegisterBlock(wasmLocalRegisterAccessMode);
  const memory = analyzeDynamicRegisterBlock(wasmMemoryRegisterAccessMode);

  strictEqual(dynamicLoad(local).width, 32);
  strictEqual(dynamicLoad(memory).width, 8);
  deepStrictEqual(onlyObligation(local).write, {
    target: { kind: "reg", reg: registerAlias("eax") },
    value: exprInsertBits(exprInput({ kind: "reg", reg: "eax" }), exprConst(5), 0, 8)
  });
  deepStrictEqual(onlyObligation(memory).write, {
    target: { kind: "reg", reg: registerAlias("al") },
    value: exprConst(5)
  });
});

function analyzeDynamicRegisterBlock(registerAccessMode: RegisterAccessMode): ReturnType<typeof analyzeWasmBlock> {
  return analyzeWasmBlock({
    block: dynamicRegisterBlock(),
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(modRmSelector(exprConst(4)), 8),
        dynamicRegBinding(modRmSelector(exprConst(4)), 32)
      ]
    }),
    registerAccessMode
  });
}

function dynamicRegisterBlock(): IrBlock {
  return [
    { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 8 },
    { op: "set", target: { kind: "reg", reg: "al" }, value: c(5), accessWidth: 8 },
    { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 },
    { op: "next" }
  ];
}

function dynamicLoad(input: ReturnType<typeof analyzeWasmBlock>): Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }> {
  const site = input.walked.timeline.find((candidate) =>
    candidate.kind === "definition" &&
    candidate.definition.kind === "dynamicRegisterLoad"
  );

  strictEqual(site?.kind, "definition");
  strictEqual(site.definition.kind, "dynamicRegisterLoad");
  return site.definition;
}

function onlyObligation(input: ReturnType<typeof analyzeWasmBlock>): StateObligation {
  strictEqual(input.obligations.obligations.length, 1);
  return input.obligations.obligations[0]!;
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32", value };
}
