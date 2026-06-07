import {
  deepStrictEqual,
  strictEqual,
  throws
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
import { exprConst } from "#ir/expr/builders.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder, type WasmBranchHint } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import {
  wasmOpcode,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { createWasmActionEmitter } from "#wasm/emit/block/actions.js";
import { createWasmExitRegionContext } from "#wasm/emit/block/exits.js";
import type {
  WasmActionInputsEmitInput,
  WasmLayoutActionEdge,
  WasmLayoutExitPayload
} from "#wasm/emit/block/layout.js";
import {
  wasmI32
} from "#wasm/emit/values/types.js";
import { wasmBodyMemoryAccesses } from "#wasm/tests/body-opcodes.js";

test("action inputs emit operands in layout order and memoryStore consumes stack operands", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const emitter = createWasmActionEmitter({
    body,
    scratch: new WasmLocalScratchAllocator(body),
    exitRegions: createWasmExitRegionContext()
  });
  const site = actionSite({
    kind: "memoryStore",
    at: opSite(0),
    address: exprConst(0x1000),
    value: exprConst(0x12),
    width: 8
  });
  emitter.emitActionInputs({
    site,
    inputs: [
      actionInput(0, site, "address"),
      actionInput(1, site, "value")
    ],
    emitInput: emitInput(body, events)
  });
  emitter.emitActionEffect({
    site,
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
    scratch: new WasmLocalScratchAllocator(body),
    exitRegions: createWasmExitRegionContext()
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
  emitter.emitActionInputs({
    site,
    inputs: [actionInput(0, site, "condition")],
    emitInput: emitInput(body, events)
  });
  emitter.emitActionEffect({
    site,
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
    scratch: new WasmLocalScratchAllocator(body),
    exitRegions: createWasmExitRegionContext()
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
  emitter.emitActionInputs({
    site,
    inputs: [actionInput(0, site, "address")],
    emitInput: emitInput(body, events)
  });
  emitter.emitActionEffect({
    site,
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
    scratch: new WasmLocalScratchAllocator(body),
    exitRegions
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

  emitter.emitActionEffect({
    site,
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

test("dynamicRegisterStore does not silently drop index and value operands", () => {
  const events: string[] = [];
  const body = new RecordingBody(events);
  const emitter = createWasmActionEmitter({
    body,
    scratch: new WasmLocalScratchAllocator(body),
    exitRegions: createWasmExitRegionContext()
  });
  const site = actionSite({
    kind: "dynamicRegisterStore",
    at: opSite(0),
    index: exprConst(2),
    value: exprConst(0x1234),
    width: 32,
    stateBefore: initialBlockState()
  });
  emitter.emitActionInputs({
    site,
    inputs: [
      actionInput(0, site, "index"),
      actionInput(1, site, "value")
    ],
    emitInput: emitInput(body, events)
  });

  throws(
    () => emitter.emitActionEffect({
      site,
      edges: [],
      emitEdge: (edge) => events.push(`edge:${edge.edge}`)
    }),
    /dynamicRegisterStore action lowering is unsupported/
  );
  deepStrictEqual(events, [
    "input:action-input:index",
    "input:action-input:value"
  ]);
  strictEqual(body.events.includes("drop"), false);
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

function emitInput(
  body: RecordingBody,
  events: string[]
): WasmActionInputsEmitInput["emitInput"] {
  return (input) => {
    const edge = input.use.kind === "exit-payload"
      ? `:${input.use.edge}`
      : "";

    events.push(`input:${input.use.kind}:${input.use.role}${edge}`);
    body.i32Const(input.id);
    return wasmI32(32);
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
