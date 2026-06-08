import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { BlockExit, BlockExitId } from "#ir/block/exits.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  ExprRecipe,
  LayoutTimelineInput,
  LayoutValueUseId,
  TimelineValueUseId
} from "#ir/block/planning/index.js";
import type { BlockActionSite, Placement } from "#ir/block/timeline.js";
import { initialBlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import { modRmSelector } from "#ir/block/modrm-selector.js";
import { exprConst } from "#ir/expr/builders.js";
import {
  stateOffset,
  wasmImport,
  wasmMemoryIndex
} from "#wasm/abi.js";
import { WasmFunctionBodyEncoder, type WasmBranchHint } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import {
  wasmOpcode,
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { createWasmActionOperands } from "#wasm/emit/block/action-inputs.js";
import { createWasmActionEmitter } from "#wasm/emit/block/actions.js";
import { createWasmExitRegionContext } from "#wasm/emit/block/exits.js";
import { createStateMemoryRegisterTargetStorage } from "#wasm/emit/targets/memory/registers.js";
import type {
  WasmActionEffectEmitInput,
  WasmActionEmitter,
  WasmActionOperands,
  WasmLayoutActionEdge,
  WasmLayoutExitPayload
} from "#wasm/emit/block/layout.js";
import type {
  WasmValueCacheLocalEmission
} from "#wasm/emit/cache/locals/index.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";
import { wasmBodyMemoryAccesses } from "#wasm/tests/body-opcodes.js";

test("action inputs emit operands in layout order and memoryStore consumes stack operands", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const emitter = createWasmActionEmitter({
    body,
    exitRegions: createWasmExitRegionContext(),
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const site = actionSite({
    kind: "memoryStore",
    at: opSite(0),
    address: exprConst(0x1000),
    value: exprConst(0x12),
    width: 8
  });
  const inputs = [
    actionInput(0, site, "address"),
    actionInput(1, site, "value")
  ];
  const operands = testActionOperands(site, inputs, body, events);

  emitter.emitActionInputs({ site, inputs, operands });
  emitActionEffect(emitter, {
    site,
    operands,
    edges: [],
    emitEdge: (edge) => events.push(`edge:${edge.edge}`)
  });
  body.end();

  deepStrictEqual(events, [
    "input:action-input:address",
    "input:action-input:value"
  ]);
  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [
    { opcode: wasmOpcode.i32Store8, memoryIndex: wasmMemoryIndex.guest, offset: 0 }
  ]);
});

test("branch emits distinct taken and not-taken edge regions in matching arms", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const emitter = createWasmActionEmitter({
    body,
    exitRegions: createWasmExitRegionContext(),
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const taken = blockExit(0, "branchTaken", { kind: "branch", direction: "taken", target: exprConst(0x40) });
  const notTaken = blockExit(1, "branchNotTaken", {
    kind: "branch",
    direction: "notTaken"
  });
  const site = actionSite({
    kind: "branch",
    at: opSite(0),
    condition: exprConst(1),
    takenTarget: exprConst(0x40),
    continuation: { kind: "continuation", value: exprConst(0x44) },
    taken,
    notTaken
  });
  const takenEdge = edgeId(7);
  const notTakenEdge = edgeId(8);
  const inputs = [actionInput(0, site, "condition")];
  const operands = testActionOperands(site, inputs, body, events);

  emitter.emitActionInputs({ site, inputs, operands });
  emitActionEffect(emitter, {
    site,
    operands,
    edges: [
      actionEdge(takenEdge, taken, exitPayload(1, takenEdge, "target")),
      actionEdge(notTakenEdge, notTaken, exitPayload(2, notTakenEdge, "target"))
    ],
    emitEdge: (edge) => events.push(`edge:${edge.edge}`)
  });

  deepStrictEqual(events, [
    "input:action-input:condition",
    "if",
    "edge:7",
    "else",
    "edge:8",
    "end"
  ]);
});

test("memoryGuard emits its fault edge region inside the guarded fault arm", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const emitter = createWasmActionEmitter({
    body,
    exitRegions: createWasmExitRegionContext(),
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const fault = blockExit(0, "memoryFault", {
    kind: "memoryFault",
    address: exprConst(0x2000),
    byteLength: 4,
    access: "write"
  });
  const site = actionSite({
    kind: "memoryGuard",
    at: opSite(0),
    address: exprConst(0x2000),
    byteLength: 4,
    access: "write",
    faultExit: fault
  });
  const faultEdge = edgeId(3);
  const inputs = [actionInput(0, site, "address")];
  const operands = testActionOperands(site, inputs, body, events);

  emitter.emitActionInputs({ site, inputs, operands });
  emitActionEffect(emitter, {
    site,
    operands,
    edges: [actionEdge(faultEdge, fault, exitPayload(1, faultEdge, "address"))],
    emitEdge: (edge) => events.push(`edge:${edge.edge}`)
  });

  const ifIndex = events.indexOf("if");
  const edgeIndex = events.indexOf("edge:3");
  const endIndex = events.indexOf("end");

  strictEqual(ifIndex >= 0, true);
  strictEqual(edgeIndex > ifIndex, true);
  strictEqual(endIndex > edgeIndex, true);
});

test("action emitter marks edge exits with payload shape and control depth", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const exitRegions = createWasmExitRegionContext();
  const emitter = createWasmActionEmitter({
    body,
    exitRegions,
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const taken = blockExit(0, "branchTaken", { kind: "branch", direction: "taken", target: exprConst(0x40) });
  const notTaken = blockExit(1, "branchNotTaken", { kind: "branch", direction: "notTaken" });
  const site = actionSite({
    kind: "branch",
    at: opSite(0),
    condition: exprConst(1),
    takenTarget: exprConst(0x40),
    continuation: { kind: "continuation" },
    taken,
    notTaken
  });
  const takenEdge = edgeId(1);
  const notTakenEdge = edgeId(2);

  emitActionEffect(emitter, {
    site,
    operands: testActionOperands(site, [], body, events),
    edges: [
      actionEdge(takenEdge, taken, exitPayload(0, takenEdge, "target")),
      actionEdge(notTakenEdge, notTaken)
    ],
    emitEdge: (edge) => {
      const exit = edge.edge === takenEdge ? taken : notTaken;
      const region = exitRegions.currentExitRegion(exit);

      events.push(`edge:${edge.edge}:payload:${region.payload.kind}:depth:${region.controlDepth}`);
    }
  });

  deepStrictEqual(events, [
    "if",
    "edge:1:payload:stack:depth:1",
    "else",
    "edge:2:payload:constant:depth:1",
    "end"
  ]);
});

test("dynamicRegisterStore dispatches state-register aliases by runtime ModRM selector", async () => {
  const state = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(state.buffer);
  const instance = await instantiateDynamicRegisterStore(state, 32);
  const store = readStoreFunction(instance);

  store(3, 0x1122_3344);
  store(7, 0x5566_7788);
  store(99, 0x0bad_f00d);

  strictEqual(view.getUint32(stateOffset.ebx, true), 0x1122_3344);
  strictEqual(view.getUint32(stateOffset.edi, true), 0x5566_7788);
  strictEqual(view.getUint32(stateOffset.eax, true), 0);
});

test("dynamicRegisterStore honors high-byte aliases", async () => {
  const state = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(state.buffer);
  const instance = await instantiateDynamicRegisterStore(state, 8);
  const store = readStoreFunction(instance);

  view.setUint32(stateOffset.eax, 0x1234_5678, true);
  store(4, 0xab);

  strictEqual(view.getUint32(stateOffset.eax, true), 0x1234_ab78);
});

test("dynamicRegisterStore reuses selected operand locals without scratch copies", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const valueLocal = body.addLocal(wasmValueType.i32);
  const indexLocal = body.addLocal(wasmValueType.i32);
  const scratch = new TrackingScratch(body);
  const emitter = createWasmActionEmitter({
    body,
    exitRegions: createWasmExitRegionContext(),
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const site = actionSite({
    kind: "dynamicRegisterStore",
    at: opSite(0),
    selector: modRmSelector(exprConst(0)),
    value: exprConst(1),
    width: 32,
    stateBefore: initialBlockState()
  });
  const inputs = [
    actionInput(0, site, "index"),
    actionInput(1, site, "value")
  ];
  let indexEmitCount = 0;
  const operands = testActionOperands(site, inputs, body, events, scratch, {
    emitStackInput: (input) => {
      if (input.use.kind !== "action-input" || input.use.role !== "index") {
        throw new Error(`unexpected deferred dynamic register input ${input.use.kind}`);
      }

      indexEmitCount += 1;
      body.localGet(indexLocal);
      return wasmI32(32);
    },
    emitLocalInput: (input) => {
      if (input.use.kind !== "action-input" || input.use.role !== "value") {
        throw new Error("dynamic register value should be the only local operand");
      }

      return localEmission(wasmI32(32), valueLocal);
    }
  });

  emitter.emitActionInputs({
    site,
    inputs,
    operands
  });

  emitActionEffect(emitter, {
    site,
    operands,
    edges: [],
    emitEdge: (edge) => {
      throw new Error(`dynamic register store should not emit edge ${edge.edge}`);
    }
  });

  strictEqual(indexEmitCount, 1);
  strictEqual(scratch.allocCount, 0);
  strictEqual(body.events.includes("drop"), false);
  scratch.assertClear();
});

type RecordedOp =
  | "if"
  | "else"
  | "end"
  | "drop";

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly events: RecordedOp[] = [];
  readonly log: string[];

  constructor(log: string[]) {
    super();
    this.log = log;
  }

  override ifBlock(hint?: WasmBranchHint, result?: WasmValueType): this {
    super.ifBlock(hint, result);
    this.events.push("if");
    this.log.push("if");
    return this;
  }

  override elseBlock(): this {
    super.elseBlock();
    this.events.push("else");
    this.log.push("else");
    return this;
  }

  override endBlock(): this {
    super.endBlock();
    this.events.push("end");
    this.log.push("end");
    return this;
  }

  override drop(): this {
    super.drop();
    this.events.push("drop");
    return this;
  }
}

class TrackingScratch extends WasmLocalScratchAllocator {
  allocCount = 0;

  override allocLocal(type: WasmValueType): number {
    this.allocCount += 1;
    return super.allocLocal(type);
  }
}

function emitInput(
  body: WasmFunctionBodyEncoder,
  events: string[]
): (input: LayoutTimelineInput) => WasmEmittedValue {
  return (input) => {
    const edge = input.use.kind === "exit-payload"
      ? `:${input.use.edge}`
      : "";

    events.push(`input:${input.use.kind}:${input.use.role}${edge}`);
    body.i32Const(input.id);
    return wasmI32(32);
  };
}

function emitActionEffect(emitter: WasmActionEmitter, input: WasmActionEffectEmitInput): void {
  try {
    emitter.emitActionEffect(input);
  } finally {
    input.operands.release();
  }
}

function testActionOperands(
  site: BlockActionSite,
  inputs: readonly LayoutTimelineInput[],
  body: WasmFunctionBodyEncoder,
  events: string[],
  scratch = new WasmLocalScratchAllocator(body),
  emitters: Partial<Readonly<{
    emitStackInput(input: LayoutTimelineInput): WasmEmittedValue;
    emitLocalInput(input: LayoutTimelineInput): WasmValueCacheLocalEmission;
  }>> = {}
): WasmActionOperands {
  const emitStackInput = emitters.emitStackInput ?? emitInput(body, events);

  return createWasmActionOperands({
    site,
    inputs,
    emitStackInput,
    emitLocalInput: emitters.emitLocalInput ?? ((input) => {
      const value = emitStackInput(input);
      const local = scratch.allocLocal(wasmValueType.i32);

      body.localSet(local);
      return localEmission(value, local, () => scratch.freeLocal(local));
    })
  });
}

function localEmission(
  value: ReturnType<typeof wasmI32>,
  local: number,
  release: () => void = () => {}
): WasmValueCacheLocalEmission {
  return {
    value,
    local,
    release
  };
}

function actionSite(action: BlockActionSite["action"]): BlockActionSite {
  return Object.freeze({
    kind: "action",
    at: placement(action.at.opIndex),
    action: Object.freeze(action)
  });
}

function blockExit(
  id: number,
  kind: BlockExit["kind"],
  payload: BlockExit["payload"]
): BlockExit {
  return Object.freeze({
    id: id as BlockExitId,
    at: opSite(0),
    kind,
    snapshot: initialBlockState(),
    payload
  });
}

function actionInput(
  id: number,
  site: BlockActionSite,
  role: Extract<LayoutTimelineInput["use"], { kind: "action-input" }>["role"]
): LayoutTimelineInput {
  return Object.freeze({
    id: id as LayoutValueUseId,
    recipe: exprRecipe(id),
    use: Object.freeze({
      id: id as TimelineValueUseId,
      kind: "action-input",
      site,
      role,
      expr: exprConst(id),
      point: Object.freeze({
        path: Object.freeze({ kind: "main" }),
        at: placement(0),
        phase: "at"
      })
    })
  });
}

function exitPayload(
  id: number,
  edge: BlockEdgeId,
  role: Extract<LayoutTimelineInput["use"], { kind: "exit-payload" }>["role"]
): LayoutTimelineInput {
  return Object.freeze({
    id: id as LayoutValueUseId,
    recipe: exprRecipe(id),
    use: Object.freeze({
      id: id as TimelineValueUseId,
      kind: "exit-payload",
      edge,
      role,
      expr: exprConst(id),
      point: Object.freeze({
        path: Object.freeze({ kind: "edge", edge }),
        at: placement(0),
        phase: "at"
      })
    })
  });
}

function actionEdge(
  edge: BlockEdgeId,
  exit: BlockExit,
  exitPayloadInput?: LayoutTimelineInput
): WasmLayoutActionEdge {
  return Object.freeze({
    edge,
    exit,
    exitPayload: exitPayloadInput === undefined
      ? Object.freeze({ kind: "none" } satisfies WasmLayoutExitPayload)
      : Object.freeze({ kind: "input", input: exitPayloadInput } satisfies WasmLayoutExitPayload)
  });
}

function exprRecipe(value: number): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr: exprConst(value),
    children: Object.freeze([])
  });
}

function placement(opIndex: number): Placement {
  return Object.freeze({ opIndex, epoch: 0 });
}

function edgeId(id: number): BlockEdgeId {
  return id as BlockEdgeId;
}

async function instantiateDynamicRegisterStore(
  state: WebAssembly.Memory,
  width: 8 | 16 | 32
): Promise<WebAssembly.Instance> {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: []
  });
  const body = new WasmFunctionBodyEncoder(2);
  const emitter = createWasmActionEmitter({
    body,
    exitRegions: createWasmExitRegionContext(),
    registers: createStateMemoryRegisterTargetStorage(body)
  });
  const site = actionSite({
    kind: "dynamicRegisterStore",
    at: opSite(0),
    selector: modRmSelector(exprConst(0)),
    value: exprConst(1),
    width,
    stateBefore: initialBlockState()
  });
  const inputs = [
    actionInput(0, site, "index"),
    actionInput(1, site, "value")
  ];
  const scratch = new WasmLocalScratchAllocator(body);
  const emitDynamicInput = (input: LayoutTimelineInput): WasmEmittedValue => {
    if (input.use.kind !== "action-input") {
      throw new Error(`unexpected dynamic register store input kind ${input.use.kind}`);
    }

    switch (input.use.role) {
      case "index":
        body.localGet(0);
        return wasmI32(32);
      case "value":
        body.localGet(1);
        return wasmI32(32);
      case "address":
      case "condition":
        throw new Error(`unexpected dynamic register store input role ${input.use.role}`);
    }
  };
  const operands = createWasmActionOperands({
    site,
    inputs,
    emitStackInput: emitDynamicInput,
    emitLocalInput: (input) => {
      const value = emitDynamicInput(input);
      const local = scratch.allocLocal(wasmValueType.i32);

      body.localSet(local);
      return localEmission(value, local, () => scratch.freeLocal(local));
    }
  });

  emitter.emitActionInputs({ site, inputs, operands });
  emitActionEffect(emitter, {
    site,
    operands,
    edges: [],
    emitEdge: (edge) => {
      throw new Error(`dynamic register store should not emit edge ${edge.edge}`);
    }
  });
  scratch.assertClear();
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("store", functionIndex);

  return WebAssembly.instantiate(await WebAssembly.compile(module.encode()), {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: state
    }
  });
}

function readStoreFunction(instance: WebAssembly.Instance): (index: number, value: number) => void {
  const value = instance.exports.store;

  if (typeof value !== "function") {
    throw new Error("expected exported function store");
  }

  return value as (index: number, value: number) => void;
}
