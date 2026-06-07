import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import { modRmSelector } from "#ir/block/modrm-selector.js";
import type { BlockExit, BlockExitId } from "#ir/block/exits.js";
import type { BlockActionSite, Placement } from "#ir/block/timeline.js";
import {
  type BlockLayout,
  type ExprRecipe,
  type ExprRecipeId,
  type LayoutRegion,
  type LayoutRegionId,
  type LayoutTimelineInput,
  type LayoutValueUseId,
  type PlannedStateWrite,
  type RecipeRegistry,
  type StateWriteId,
  type StateWritePlan,
  type ValuePlan
} from "#ir/block/planning/index.js";
import { initialBlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import { exprBinary, exprConst } from "#ir/expr/builders.js";
import { exprChildren } from "#ir/expr/children.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBlock,
  IrMemoryAccessKind,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { WasmFunctionBodyEncoder, type WasmBranchHint } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  type WasmValueType
} from "#wasm/encoder/types.js";
import {
  emitWasmBlockLayout,
  type WasmActionEffectEmitInput,
  type WasmActionEmitter,
  type WasmActionInputRole,
  type WasmActionInputsEmitInput,
  type WasmExitEmitter,
  type WasmStateWriteEmitter
} from "#wasm/emit/block/layout.js";
import { createWasmValueCache } from "#wasm/emit/cache/locals/index.js";
import {
  planWasmCache,
  type WasmCacheEntry,
  type WasmCacheEntryId,
  type WasmCachePlan,
  type WasmCacheReason
} from "#wasm/emit/cache/plan/index.js";
import {
  analyzeWasmBlock,
  wasmLocalRegisterAccessMode,
  type WasmBlockAnalysisInput
} from "#wasm/emit/block/analysis.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";
import type { WasmRecipeEmitter } from "#wasm/emit/values/recipes.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type { OperandWidth } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";

test("Wasm layout driver emits branch edge regions inside the owning if and else arms", () => {
  const branch = branchLayoutFixture();
  const { ops, scratch } = emitFixture({
    layout: branch.layout,
    stateWrites: branch.stateWrites,
    values: branch.values,
    cachePlan: branch.cachePlan
  });

  const ifIndex = indexOf(ops, "if");
  const elseIndex = indexOf(ops, "else");
  const endIndex = indexOf(ops, "end");
  const takenWrite = indexOf(ops, "state-write", "eax");
  const notTakenWrite = indexOf(ops, "state-write", "ebx");
  const takenExit = indexOf(ops, "exit", "branchTaken");
  const notTakenExit = indexOf(ops, "exit", "branchNotTaken");
  const notTakenPayload = indexOf(ops, "inline", "branch:exit:target:1");

  strictEqual(ifIndex >= 0, true);
  strictEqual(elseIndex > ifIndex, true);
  strictEqual(endIndex > elseIndex, true);
  strictEqual(takenWrite > ifIndex && takenWrite < elseIndex, true);
  strictEqual(takenExit > takenWrite && takenExit < elseIndex, true);
  strictEqual(notTakenPayload > elseIndex && notTakenPayload < endIndex, true);
  strictEqual(notTakenWrite > notTakenPayload && notTakenWrite < endIndex, true);
  strictEqual(notTakenExit > notTakenWrite && notTakenExit < endIndex, true);
  strictEqual(ops.findIndex((op, index) => op.kind === "state-write" && index > endIndex), -1);

  deepStrictEqual(ops.filter((op) => op.kind === "inline").map((op) => op.label), [
    "branch:action-input:condition",
    "branch:exit:target:0",
    "branch:exit:target:1"
  ]);
  deepStrictEqual(ops.filter((op) => op.kind === "get").map((op) => op.local), [0, 0]);
  scratch.assertClear();
});

test("Wasm layout driver owns selected branch payload locals by edge region", () => {
  const branch = sharedPayloadBranchLayoutFixture();
  const { ops, scratch } = emitFixture({
    layout: branch.layout,
    stateWrites: branch.stateWrites,
    values: branch.values,
    cachePlan: branch.cachePlan
  });
  const elseIndex = indexOf(ops, "else");
  const takenPayload = indexOf(ops, "inline", "branch:exit:target:0");
  const notTakenPayload = indexOf(ops, "inline", "branch:exit:target:1");
  const takenTee = ops.findIndex((op, index) => op.kind === "tee" && index > takenPayload && index < elseIndex);
  const notTakenTee = ops.findIndex((op, index) => op.kind === "tee" && index > notTakenPayload);

  strictEqual(takenPayload >= 0, true);
  strictEqual(takenTee > takenPayload, true);
  strictEqual(notTakenPayload > elseIndex, true);
  strictEqual(notTakenTee > notTakenPayload, true);
  strictEqual(ops.some((op) => op.kind === "get"), false);
  scratch.assertClear();
});

test("Wasm layout driver emits memory-fault edge regions inside the guard fault path", () => {
  const guard = memoryGuardLayoutFixture();
  const { ops, scratch } = emitFixture({
    layout: guard.layout,
    stateWrites: guard.stateWrites,
    values: guard.values,
    cachePlan: guard.cachePlan
  });

  const guardIf = indexOf(ops, "if");
  const guardEnd = indexOf(ops, "end");
  const faultPayload = ops.findIndex((op, index) =>
    op.kind === "inline" &&
    index > guardIf &&
    index < guardEnd
  );
  const faultWrite = indexOf(ops, "state-write", "eax");
  const faultExit = indexOf(ops, "exit", "memoryFault");

  strictEqual(guardIf >= 0, true);
  strictEqual(faultPayload > guardIf && faultPayload < guardEnd, true);
  strictEqual(faultWrite > faultPayload && faultWrite < guardEnd, true);
  strictEqual(faultExit > faultWrite && faultExit < guardEnd, true);
  scratch.assertClear();
});

test("Wasm layout driver uses cache snapshot calls between same-point inputs and effects", () => {
  const analyzed = analyzeBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "set", target: { kind: "operand", index: 0 }, value: c(0x11), accessWidth: 32 },
    { op: "set", target: { kind: "mem", address: c(0x1000) }, value: v(0), accessWidth: 32 }
  ], dynamicOperand());
  const { ops, scratch } = emitFixture({
    layout: analyzed.layout,
    stateWrites: analyzed.stateWrites,
    values: analyzed.values,
    cachePlan: planWasmCache({
      layout: analyzed.layout,
      values: analyzed.values
    })
  });

  const indexInput = indexOf(ops, "input", "dynamicRegisterStore:action-input:index");
  const valueInput = indexOf(ops, "input", "dynamicRegisterStore:action-input:value");
  const snapshotSet = indexOf(ops, "set");
  const dynamicEffect = indexOf(ops, "effect", "dynamicRegisterStore");
  const memoryValueGet = lastIndexOf(ops, "get");

  strictEqual(valueInput >= 0, true);
  strictEqual(snapshotSet > valueInput, true);
  strictEqual(dynamicEffect > snapshotSet, true);
  strictEqual(indexInput > dynamicEffect, true);
  strictEqual(memoryValueGet > indexInput, true);
  strictEqual(ops.some((op) => op.kind === "recipe-establish"), false);
  scratch.assertClear();
});

type RecordedOp =
  | Readonly<{ kind: "input"; label: string; use: LayoutTimelineInput }>
  | Readonly<{ kind: "inline"; label: string }>
  | Readonly<{ kind: "recipe-establish"; snapshot: number }>
  | Readonly<{ kind: "effect"; label: string }>
  | Readonly<{ kind: "state-write"; label: string; write: StateWriteId }>
  | Readonly<{ kind: "exit"; label: string }>
  | Readonly<{ kind: "if" }>
  | Readonly<{ kind: "else" }>
  | Readonly<{ kind: "end" }>
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

  override ifBlock(hint?: WasmBranchHint, result?: WasmValueType): this {
    void hint;
    void result;
    this.ops.push({ kind: "if" });
    return this;
  }

  override elseBlock(): this {
    this.ops.push({ kind: "else" });
    return this;
  }

  override endBlock(): this {
    this.ops.push({ kind: "end" });
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

class RecordingRecipeEmitter implements WasmRecipeEmitter {
  readonly #ops: RecordedOp[];

  constructor(ops: RecordedOp[]) {
    this.#ops = ops;
  }

  emitRecipe(recipe: ExprRecipe): WasmEmittedValue {
    return this.emitRecipeBody(recipe);
  }

  emitRecipeBody(recipe: ExprRecipe): WasmEmittedValue {
    this.#ops.push({ kind: "inline", label: recipeLabel(recipe) });
    return wasmI32(32);
  }

  establishSnapshot(snapshot: import("#ir/block/planning/index.js").ValueSnapshotId, recipe: ExprRecipe): void {
    void recipe;
    this.#ops.push({ kind: "recipe-establish", snapshot });
  }
}

class RecordingActionEmitter implements WasmActionEmitter {
  readonly #ops: RecordedOp[];
  readonly #body: RecordingBody;
  readonly #inputs = new Map<BlockActionSite, readonly LayoutTimelineInput[]>();

  constructor(ops: RecordedOp[], body: RecordingBody) {
    this.#ops = ops;
    this.#body = body;
  }

  emitActionInputs(input: WasmActionInputsEmitInput): void {
    this.#inputs.set(input.site, input.inputs);

    switch (input.site.action.kind) {
      case "memoryGuard":
        this.#emitInput(input, "address", "local");
        return;
      case "memoryStore":
        this.#emitInput(input, "address", "stack");
        this.#emitInput(input, "value", "stack");
        return;
      case "dynamicRegisterStore":
        this.#emitInput(input, "value", "local");
        return;
      case "branch":
        this.#emitInput(input, "condition", "stack");
        return;
      case "jump":
      case "hostTrap":
      case "fallthrough":
        return;
    }
  }

  emitActionEffect(input: WasmActionEffectEmitInput): void {
    this.#ops.push({ kind: "effect", label: input.site.action.kind });

    switch (input.site.action.kind) {
      case "branch":
        this.#emitBranch(input);
        return;
      case "memoryGuard":
        this.#emitMemoryGuard(input);
        return;
      case "jump":
      case "hostTrap":
      case "fallthrough":
        input.emitEdge(edgeForExit(input, input.site.action.exit));
        return;
      case "memoryStore":
        return;
      case "dynamicRegisterStore":
        ok(input.operands.has("index"), "dynamic register store effect should see its index input");
        ok(input.operands.has("value"), "dynamic register store effect should see its value input");
        this.#emitInput(input, "index", "stack");
        return;
    }
  }

  #emitBranch(input: WasmActionEffectEmitInput): void {
    ok(input.site.action.kind === "branch", "branch action input expected");

    const taken = edgeForExit(input, input.site.action.taken);
    const notTaken = edgeForExit(input, input.site.action.notTaken);

    this.#body.ifBlock();
    input.emitEdge(taken);
    this.#body.elseBlock();
    input.emitEdge(notTaken);
    this.#body.endBlock();
  }

  #emitMemoryGuard(input: WasmActionEffectEmitInput): void {
    ok(input.site.action.kind === "memoryGuard", "memory guard action input expected");

    const fault = edgeForExit(input, input.site.action.faultExit);

    this.#body.ifBlock();
    input.emitEdge(fault);
    this.#body.endBlock();
  }

  #emitInput(
    input: WasmActionInputsEmitInput | WasmActionEffectEmitInput,
    role: WasmActionInputRole,
    output: "stack" | "local"
  ): void {
    const layoutInput = this.#actionInput(input.site, role);
    const prefix = input.site.action.kind;
    const label = `${prefix}:${layoutInput.use.kind}:${role}`;

    this.#ops.push({ kind: "input", label, use: layoutInput });
    recipeLabels.set(layoutInput.recipe, label);

    switch (output) {
      case "stack":
        input.operands.emitStack(role);
        return;
      case "local":
        input.operands.emitLocal(role);
        return;
    }
  }

  #actionInput(site: BlockActionSite, role: WasmActionInputRole): LayoutTimelineInput {
    const layoutInput = this.#inputs.get(site)?.find((input) =>
      input.use.kind === "action-input" &&
      input.use.role === role
    );

    ok(layoutInput !== undefined, `missing test action input ${role} for ${site.action.kind}`);
    return layoutInput;
  }
}

function edgeForExit(
  input: WasmActionEffectEmitInput,
  exit: BlockExit
): WasmActionEffectEmitInput["edges"][number] {
  const edge = input.edges.find((edge) => edge.exit === exit);

  ok(edge !== undefined, `missing test edge for exit ${exit.id}`);
  return edge;
}

class RecordingStateWriteEmitter implements WasmStateWriteEmitter {
  readonly #ops: RecordedOp[];

  constructor(ops: RecordedOp[]) {
    this.#ops = ops;
  }

  emitStateWrite(input: Parameters<WasmStateWriteEmitter["emitStateWrite"]>[0]): void {
    if (input.write.value !== undefined) {
      input.emitValue();
    }

    this.#ops.push({
      kind: "state-write",
      label: stateWriteLabel(input.write),
      write: input.write.id
    });
  }
}

class RecordingExitEmitter implements WasmExitEmitter {
  readonly #ops: RecordedOp[];

  constructor(ops: RecordedOp[]) {
    this.#ops = ops;
  }

  emitExit(input: Parameters<WasmExitEmitter["emitExit"]>[0]): void {
    this.#ops.push({ kind: "exit", label: input.exit.kind });
  }
}

function emitFixture(input: Readonly<{
  layout: BlockLayout;
  stateWrites: StateWritePlan;
  values: Pick<ValuePlan, "recipes">;
  cachePlan: WasmCachePlan;
}>): Readonly<{
  ops: readonly RecordedOp[];
  scratch: RecordingScratch;
}> {
  const body = new RecordingBody();
  const scratch = new RecordingScratch(body);
  const cache = createWasmValueCache({
    plan: input.cachePlan,
    values: input.values,
    body,
    scratch
  });

  recipeLabels = new WeakMap<ExprRecipe, string>();
  labelLayoutInputs(input.layout);

  emitWasmBlockLayout({
    layout: input.layout,
    stateWrites: input.stateWrites,
    cache,
    recipes: new RecordingRecipeEmitter(body.ops),
    actions: new RecordingActionEmitter(body.ops, body),
    stateWriteEmitter: new RecordingStateWriteEmitter(body.ops),
    exits: new RecordingExitEmitter(body.ops)
  });

  return {
    ops: body.ops,
    scratch
  };
}

function labelLayoutInputs(layout: BlockLayout): void {
  for (const region of layout.regions) {
    for (const step of region.steps) {
      switch (step.kind) {
        case "action-inputs":
        case "action":
          for (const input of step.inputs) {
            recipeLabels.set(input.recipe, layoutInputLabel(step.site.action.kind, input));
          }
          break;
        case "establish-snapshot":
        case "write-state":
        case "exit":
          break;
      }
    }
  }
}

function layoutInputLabel(prefix: string, input: LayoutTimelineInput): string {
  return input.use.kind === "exit-payload"
    ? `${prefix}:exit:${input.use.role}:${input.use.edge}`
    : `${prefix}:${input.use.kind}:${input.use.role}`;
}

type ManualLayoutFixture = Readonly<{
  layout: BlockLayout;
  stateWrites: StateWritePlan;
  values: Pick<ValuePlan, "recipes">;
  cachePlan: WasmCachePlan;
}>;

function branchLayoutFixture(): ManualLayoutFixture {
  const placement = pointPlacement(0);
  const taken = blockExit(0, "branchTaken", { kind: "branch", direction: "taken", target: ce(0x40) });
  const notTaken = blockExit(1, "branchNotTaken", { kind: "branch", direction: "notTaken" });
  const site: BlockActionSite = Object.freeze({
    kind: "action",
    at: placement,
    action: Object.freeze({
      kind: "branch",
      at: opSite(0),
      condition: ce(1),
      takenTarget: ce(0x40),
      continuation: Object.freeze({ kind: "continuation", value: ce(0x44) }),
      taken,
      notTaken
    })
  });
  const condition = exprRecipe(exprConst(1));
  const takenTarget = exprRecipe(exprConst(0x40));
  const notTakenTarget = exprRecipe(exprConst(0x44));
  const takenWrite = plannedWrite(0, "eax", condition);
  const notTakenWrite = plannedWrite(1, "ebx", condition);
  const takenEdge = edgeId(0);
  const notTakenEdge = edgeId(1);
  const conditionInput = timelineInput(0, condition, actionInputUse(0, site, "condition"));
  const takenInput = timelineInput(1, takenTarget, exitPayloadUse(1, takenEdge, "target"));
  const notTakenInput = timelineInput(2, notTakenTarget, exitPayloadUse(2, notTakenEdge, "target"));
  const layout = blockLayout([
    region(0, { kind: "main" }, [
      Object.freeze({ kind: "action-inputs", site, inputs: Object.freeze([conditionInput]) }),
      Object.freeze({ kind: "action", site, inputs: Object.freeze([takenInput, notTakenInput]) })
    ]),
    region(1, { kind: "edge", edge: takenEdge }, [
      Object.freeze({
        kind: "write-state",
        emit: takenWrite.id,
        satisfies: Object.freeze([takenWrite.id]),
        value: Object.freeze({ id: useId(3), recipe: condition })
      }),
      Object.freeze({ kind: "exit", exit: taken })
    ]),
    region(2, { kind: "edge", edge: notTakenEdge }, [
      Object.freeze({
        kind: "write-state",
        emit: notTakenWrite.id,
        satisfies: Object.freeze([notTakenWrite.id]),
        value: Object.freeze({ id: useId(4), recipe: condition })
      }),
      Object.freeze({ kind: "exit", exit: notTaken })
    ])
  ]);

  return {
    layout,
    stateWrites: stateWritePlan([takenWrite, notTakenWrite]),
    values: recipeValues([condition, takenTarget, notTakenTarget]),
    cachePlan: cachePlan([cacheEntry(0, condition)])
  };
}

function sharedPayloadBranchLayoutFixture(): ManualLayoutFixture {
  const placement = pointPlacement(0);
  const taken = blockExit(0, "branchTaken", { kind: "branch", direction: "taken", target: ce(0x40) });
  const notTaken = blockExit(1, "branchNotTaken", { kind: "branch", direction: "notTaken" });
  const site: BlockActionSite = Object.freeze({
    kind: "action",
    at: placement,
    action: Object.freeze({
      kind: "branch",
      at: opSite(0),
      condition: ce(1),
      takenTarget: ce(0x40),
      continuation: Object.freeze({ kind: "continuation", value: ce(0x40) }),
      taken,
      notTaken
    })
  });
  const condition = exprRecipe(exprConst(1));
  const takenTarget = exprRecipe(exprBinary("add", exprConst(0x20), exprConst(0x20)));
  const notTakenTarget = exprRecipe(exprBinary("add", exprConst(0x20), exprConst(0x20)));
  const takenEdge = edgeId(0);
  const notTakenEdge = edgeId(1);
  const conditionInput = timelineInput(0, condition, actionInputUse(0, site, "condition"));
  const takenInput = timelineInput(1, takenTarget, exitPayloadUse(1, takenEdge, "target"));
  const notTakenInput = timelineInput(2, notTakenTarget, exitPayloadUse(2, notTakenEdge, "target"));
  const layout = blockLayout([
    region(0, { kind: "main" }, [
      Object.freeze({ kind: "action-inputs", site, inputs: Object.freeze([conditionInput]) }),
      Object.freeze({ kind: "action", site, inputs: Object.freeze([takenInput, notTakenInput]) })
    ]),
    region(1, { kind: "edge", edge: takenEdge }, [
      Object.freeze({ kind: "exit", exit: taken })
    ]),
    region(2, { kind: "edge", edge: notTakenEdge }, [
      Object.freeze({ kind: "exit", exit: notTaken })
    ])
  ]);

  return {
    layout,
    stateWrites: stateWritePlan([]),
    values: recipeValues([condition, takenTarget, notTakenTarget]),
    cachePlan: cachePlan([cacheEntry(0, takenTarget)])
  };
}

function memoryGuardLayoutFixture(): ManualLayoutFixture {
  const placement = pointPlacement(0);
  const fault = blockExit(0, "memoryFault", {
    kind: "memoryFault",
    address: ce(0x1000),
    byteLength: 4,
    access: "read" satisfies IrMemoryAccessKind
  });
  const site: BlockActionSite = Object.freeze({
    kind: "action",
    at: placement,
    action: Object.freeze({
      kind: "memoryGuard",
      at: opSite(0),
      address: ce(0x1000),
      byteLength: 4,
      access: "read",
      faultExit: fault
    })
  });
  const address = exprRecipe(exprConst(0x1000));
  const writeValue = exprRecipe(exprConst(0x33));
  const faultEdge = edgeId(0);
  const guardAddress = timelineInput(0, address, actionInputUse(0, site, "address"));
  const faultAddress = timelineInput(1, address, exitPayloadUse(1, faultEdge, "address"));
  const write = plannedWrite(0, "eax", writeValue);
  const layout = blockLayout([
    region(0, { kind: "main" }, [
      Object.freeze({ kind: "action-inputs", site, inputs: Object.freeze([guardAddress]) }),
      Object.freeze({ kind: "action", site, inputs: Object.freeze([faultAddress]) })
    ]),
    region(1, { kind: "edge", edge: faultEdge }, [
      Object.freeze({
        kind: "write-state",
        emit: write.id,
        satisfies: Object.freeze([write.id]),
        value: Object.freeze({ id: useId(2), recipe: writeValue })
      }),
      Object.freeze({ kind: "exit", exit: fault })
    ])
  ]);

  return {
    layout,
    stateWrites: stateWritePlan([write]),
    values: recipeValues([address, writeValue]),
    cachePlan: cachePlan([])
  };
}

function analyzeBlock(
  block: IrBlock,
  input: Omit<WasmBlockAnalysisInput, "block" | "registerAccessMode"> = {}
): Readonly<{
  layout: BlockLayout;
  stateWrites: StateWritePlan;
  values: ValuePlan;
}> {
  const { layout, stateWrites, values } = analyzeWasmBlock({
    ...input,
    block,
    registerAccessMode: wasmLocalRegisterAccessMode
  });

  return {
    values,
    stateWrites,
    layout
  };
}

let recipeLabels = new WeakMap<ExprRecipe, string>();

function recipeLabel(recipe: ExprRecipe): string {
  return recipeLabels.get(recipe) ?? recipeKindLabel(recipe);
}

function recipeKindLabel(recipe: ExprRecipe): string {
  switch (recipe.kind) {
    case "expr":
      return `expr:${recipe.expr.kind}`;
    case "definition":
      return `definition:${recipe.definition}`;
    case "snapshot":
      return `snapshot:${recipe.snapshot}`;
  }
}

function stateWriteLabel(write: PlannedStateWrite): string {
  switch (write.target.kind) {
    case "reg":
      return write.target.reg.base;
    case "flag":
      return write.target.flag;
  }
}

function blockLayout(regions: readonly LayoutRegion[]): BlockLayout {
  return Object.freeze({
    regions: Object.freeze([...regions])
  });
}

function region(id: number, path: LayoutRegion["path"], steps: LayoutRegion["steps"]): LayoutRegion {
  return Object.freeze({
    id: id as LayoutRegionId,
    path: Object.freeze(path),
    steps: Object.freeze([...steps])
  });
}

function stateWritePlan(writes: readonly PlannedStateWrite[]): StateWritePlan {
  return Object.freeze({
    writes: Object.freeze([...writes]),
    groups: Object.freeze(writes.map((write) => Object.freeze({
      representative: write,
      writes: Object.freeze([write])
    })))
  });
}

function plannedWrite(id: number, reg: "eax" | "ebx", recipe: ExprRecipe): PlannedStateWrite {
  return Object.freeze({
    id: id as StateWriteId,
    obligation: id as import("#ir/block/planning/index.js").StateObligationId,
    point: Object.freeze({
      path: Object.freeze({ kind: "main" }),
      at: pointPlacement(0),
      phase: "at"
    }),
    target: Object.freeze({ kind: "reg", reg: registerAlias(reg) }),
    value: recipe,
    valueRecipeId: id as ExprRecipeId,
    reason: "exit-state"
  } satisfies PlannedStateWrite);
}

function blockExit(id: number, kind: BlockExit["kind"], payload: BlockExit["payload"]): BlockExit {
  return Object.freeze({
    id: id as BlockExitId,
    at: opSite(0),
    kind,
    snapshot: initialBlockState(),
    payload
  });
}

function timelineInput(
  id: number,
  recipe: ExprRecipe,
  use: LayoutTimelineInput["use"]
): LayoutTimelineInput {
  return Object.freeze({
    id: useId(id),
    use,
    recipe
  });
}

function actionInputUse(
  id: number,
  site: BlockActionSite,
  role: Extract<LayoutTimelineInput["use"], { kind: "action-input" }>["role"]
): Extract<LayoutTimelineInput["use"], { kind: "action-input" }> {
  return Object.freeze({
    id: id as import("#ir/block/planning/index.js").TimelineValueUseId,
    kind: "action-input",
    site,
    role,
    expr: ce(id),
    point: Object.freeze({
      path: Object.freeze({ kind: "main" }),
      at: site.at,
      phase: "at"
    })
  });
}

function exitPayloadUse(
  id: number,
  edge: BlockEdgeId,
  role: Extract<LayoutTimelineInput["use"], { kind: "exit-payload" }>["role"]
): Extract<LayoutTimelineInput["use"], { kind: "exit-payload" }> {
  return Object.freeze({
    id: id as import("#ir/block/planning/index.js").TimelineValueUseId,
    kind: "exit-payload",
    edge,
    role,
    expr: ce(id),
    point: Object.freeze({
      path: Object.freeze({ kind: "edge", edge }),
      at: pointPlacement(0),
      phase: "at"
    })
  });
}

function recipeValues(recipes: readonly ExprRecipe[]): Pick<ValuePlan, "recipes"> {
  const recipeList: ExprRecipe[] = [];
  const idByKey = new Map<string, ExprRecipeId>();

  for (const recipe of recipes) {
    recordRecipe(recipe, recipeList, idByKey);
  }

  return {
    recipes: Object.freeze({
      recipeForNeed: () => undefined,
      recipeIdForNeed: () => undefined,
      recipeId: (recipe) => idByKey.get(JSON.stringify(recipe)),
      recipe: (id) => {
        const recipe = recipeList[id];

        ok(recipe !== undefined, `unknown recipe ${id}`);
        return recipe;
      }
    } satisfies RecipeRegistry)
  };
}

function recordRecipe(
  recipe: ExprRecipe,
  recipeList: ExprRecipe[],
  idByKey: Map<string, ExprRecipeId>
): void {
  switch (recipe.kind) {
    case "expr":
      for (const child of recipe.children) {
        recordRecipe(child, recipeList, idByKey);
      }
      break;
    case "definition":
      recordRecipe(recipe.input, recipeList, idByKey);
      break;
    case "snapshot":
      break;
  }

  const key = JSON.stringify(recipe);

  if (idByKey.has(key)) {
    return;
  }

  idByKey.set(key, recipeList.length as ExprRecipeId);
  recipeList.push(recipe);
}

function exprRecipe(expr: ExprRef): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr,
    children: Object.freeze(exprChildren(expr).map(exprRecipe))
  } satisfies ExprRecipe);
}

function cachePlan(entries: readonly WasmCacheEntry[]): WasmCachePlan {
  return Object.freeze({
    entries: Object.freeze([...entries])
  } satisfies WasmCachePlan);
}

function cacheEntry(
  id: number,
  recipe: ExprRecipe,
  reasons: readonly WasmCacheReason[] = []
): WasmCacheEntry {
  return Object.freeze({
    id: id as WasmCacheEntryId,
    recipe,
    reasons: Object.freeze([...reasons]),
    uses: Object.freeze([])
  } satisfies WasmCacheEntry);
}

function indexOf(ops: readonly RecordedOp[], kind: RecordedOp["kind"], label?: string): number {
  return ops.findIndex((op) =>
    op.kind === kind &&
    (label === undefined || ("label" in op && op.label === label))
  );
}

function lastIndexOf(ops: readonly RecordedOp[], kind: RecordedOp["kind"]): number {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    if (ops[index]!.kind === kind) {
      return index;
    }
  }

  return -1;
}

function pointPlacement(opIndex: number): Placement {
  return Object.freeze({ opIndex, epoch: 0 });
}

function edgeId(id: number): BlockEdgeId {
  return id as BlockEdgeId;
}

function useId(id: number): LayoutValueUseId {
  return id as LayoutValueUseId;
}

function dynamicOperand(): Omit<WasmBlockAnalysisInput, "block" | "registerAccessMode"> {
  return {
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(modRmSelector(exprConst(3)), 32)]
    })
  };
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number, width: OperandWidth = 32): ValueRef {
  return { kind: "const", type: `i${width}` as IrValueType, value };
}

function ce(value: number): ExprRef {
  return exprConst(value);
}
