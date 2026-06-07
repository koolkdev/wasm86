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
  analyzePlacementPlan,
  analyzeStateObligations,
  analyzeStateWrites,
  analyzeValuePlan,
  buildBlockLayout,
  buildTimelineGeometry,
  buildTimelineValueUseIndex,
  type BlockLayout,
  type LayoutRegion,
  type ValuePlan
} from "#ir/block/planning/index.js";
import {
  type BlockWalkInput,
  walkExpressionBlock
} from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import type {
  IrBlock,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { createWasmValueCache } from "#wasm/emit/cache/locals/index.js";
import { planWasmCache } from "#wasm/emit/cache/plan/index.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";

test("same-point dynamic-register-store value input establishes its snapshot with local.tee", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 }
  ], dynamicOperand());
  const { body, scratch } = emitMainLayout(layout, values);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "input:dynamicRegisterStore:index" },
    { kind: "inline", label: "input:dynamicRegisterStore:value" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "tee", local: 0 },
    { kind: "effect", label: "dynamicRegisterStore" },
    { kind: "inline", label: "input:memoryStore:address" },
    { kind: "get", local: 0 },
    { kind: "effect", label: "memoryStore" },
    { kind: "free", local: 0 }
  ]);
  strictEqual(body.ops.some((op) => op.kind === "set"), false);
  scratch.assertClear();
});

test("same-point snapshot without an earlier input use emits local.set before the store effect", () => {
  const { layout, values } = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x11), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 }
  ], dynamicOperand());
  const { body, scratch } = emitMainLayout(layout, values);

  deepStrictEqual(body.ops, [
    { kind: "inline", label: "input:dynamicRegisterStore:index" },
    { kind: "inline", label: "input:dynamicRegisterStore:value" },
    { kind: "inline", label: "establish-snapshot" },
    { kind: "alloc", local: 0, type: wasmValueType.i32 },
    { kind: "set", local: 0 },
    { kind: "effect", label: "dynamicRegisterStore" },
    { kind: "inline", label: "input:memoryStore:address" },
    { kind: "get", local: 0 },
    { kind: "effect", label: "memoryStore" },
    { kind: "free", local: 0 }
  ]);
  strictEqual(indexOf(body.ops, "set") < indexOf(body.ops, "effect", "dynamicRegisterStore"), true);
  scratch.assertClear();
});

type RecordedOp =
  | Readonly<{ kind: "inline"; label: string }>
  | Readonly<{ kind: "effect"; label: string }>
  | Readonly<{ kind: "alloc"; local: number; type: WasmValueType }>
  | Readonly<{ kind: "free"; local: number }>
  | Readonly<{ kind: "get"; local: number }>
  | Readonly<{ kind: "set"; local: number }>
  | Readonly<{ kind: "tee"; local: number }>;

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly ops: RecordedOp[] = [];

  override localGet(index: number): this {
    this.ops.push({ kind: "get", local: index });
    return this;
  }

  override localSet(index: number): this {
    this.ops.push({ kind: "set", local: index });
    return this;
  }

  override localTee(index: number): this {
    this.ops.push({ kind: "tee", local: index });
    return this;
  }
}

class RecordingScratch extends WasmLocalScratchAllocator {
  readonly #ops: RecordedOp[];

  constructor(body: RecordingBody) {
    super(body);
    this.#ops = body.ops;
  }

  override allocLocal(type: WasmValueType): number {
    const local = super.allocLocal(type);

    this.#ops.push({ kind: "alloc", local, type });
    return local;
  }

  override freeLocal(index: number): void {
    super.freeLocal(index);
    this.#ops.push({ kind: "free", local: index });
  }
}

function emitMainLayout(
  layout: BlockLayout,
  values: ValuePlan
): Readonly<{
  body: RecordingBody;
  scratch: RecordingScratch;
}> {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const cache = createWasmValueCache({
    plan: planWasmCache({ layout, values }),
    values,
    body,
    scratch
  });
  const main = mainRegion(layout);

  cache.enterRegion(main);

  for (const step of main.steps) {
    switch (step.kind) {
      case "definition":
        for (const input of step.inputs) {
          cache.emitUse(input, inline(body, `input:${step.kind}:${input.use.role}`));
        }
        break;
      case "action-inputs":
        for (const input of step.inputs) {
          cache.emitUse(input, inline(body, `input:${step.site.action.kind}:${input.use.role}`));
        }
        break;
      case "establish-snapshot":
        cache.ensureSnapshot(step.snapshot, step.recipe, inline(body, "establish-snapshot"));
        break;
      case "write-state":
        if (step.value !== undefined) {
          cache.emitUse(step.value, inline(body, "write-state"));
        }
        break;
      case "action":
        body.ops.push({ kind: "effect", label: step.site.action.kind });
        break;
      case "exit":
        body.ops.push({ kind: "effect", label: step.exit.kind });
        break;
    }
  }

  cache.leaveRegion(main);
  return { body, scratch };
}

function analyzeBlock(
  block: IrBlock,
  input: Omit<BlockWalkInput, "block"> = {}
): Readonly<{
  layout: BlockLayout;
  values: ValuePlan;
}> {
  const walked = walkExpressionBlock({ ...input, block });
  const geometry = buildTimelineGeometry(walked);
  const timelineUses = buildTimelineValueUseIndex({ walked, geometry });
  const obligations = analyzeStateObligations({ walked, geometry });
  const needs = analyzeExpressionNeeds({ timelineUses, obligations });
  const facts = analyzeBarrierFacts({ walked, geometry });
  const values = analyzeValuePlan({ needs: needs.needs, geometry, facts });
  const stateWrites = analyzeStateWrites({
    obligations,
    valueNeeds: needs.valueNeedByObligation,
    values
  });
  const placement = analyzePlacementPlan({ geometry, facts, values, stateWrites });

  return {
    values,
    layout: buildBlockLayout({
      walked,
      geometry,
      timelineUses,
      timelineNeedByUse: needs.timelineNeedByUse,
      values,
      stateWrites,
      placement
    })
  };
}

function inline(body: RecordingBody, label: string): () => WasmEmittedValue {
  return () => {
    body.ops.push({ kind: "inline", label });
    return wasmI32(32);
  };
}

function mainRegion(layout: BlockLayout): LayoutRegion {
  return layout.regions.find((region) => region.path.kind === "main")!;
}

function dynamicOperand(): Omit<BlockWalkInput, "block"> {
  return {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(exprConst(3), 32)]
    })
  };
}

function indexOf(ops: readonly RecordedOp[], kind: RecordedOp["kind"], label?: string): number {
  return ops.findIndex((op) =>
    op.kind === kind &&
    (label === undefined || ("label" in op && op.label === label))
  );
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
