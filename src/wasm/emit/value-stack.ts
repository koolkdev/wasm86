import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { ReadMemoryAction, ReadStateAction } from "#ir/actions.js";
import type { EdgeRegion } from "#ir/block.js";
import { isDynamicSlot, type StateSlot } from "#ir/slots.js";
import type {
  BinaryValueNode,
  CompareValueNode,
  ExtendValueNode,
  HelperCallValueNode,
  TruncateValueNode,
  SelectValueNode,
  UnaryValueNode,
  ValueId,
  ValueType,
  ValueTable
} from "#ir/values.js";
import type { OperandWidth } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType, type WasmValueType } from "#wasm/encoder/types.js";
import { helperFunctionName, type WasmHelperRegistry } from "#wasm/helpers/module.js";
import { edgeValues, type BlockValueAnalysis } from "./values.js";

// Turns analysis + the value graph into stack code. emitUse pushes exactly
// one use of a value; anything needed more than once is captured into a
// refcounted scratch local and replayed until its last counted use. The
// registry below is the only scratch-local mechanism in the emitter.

export type ValueStackContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  analysis: BlockValueAnalysis;
  // External id -> the wasm local the embedding bound it to.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  // Pushes the slot's current value; the driver wires this to the state
  // access layer — the value stack never sees offsets. A dynamic slot's
  // index value is consumed through the given emitter.
  loadSlot(slot: StateSlot, signed: boolean, emitUse: (id: ValueId) => void): void;
  // Loads guest memory at the address already on the stack.
  loadGuest(width: OperandWidth, signed: boolean): void;
  helpers?: WasmHelperRegistry | undefined;
}>;

export type ValueStack = Readonly<{
  // The driver calls this at each readState action point, in action order.
  readState(action: ReadStateAction): void;
  // The driver calls this at each readMemory action point, in action order.
  readMemory(action: ReadMemoryAction): void;
  // Pushes one use of the value onto the stack.
  emitUse(id: ValueId): void;
  // Called before any branch into the edge: its body is emitted later but
  // executes here, so anything it consumes must be replayable from a local.
  captureForEdge(edge: EdgeRegion): void;
  // Every captured value fully consumed, every scratch local returned.
  assertClear(): void;
}>;

type CompoundValueNode =
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | TruncateValueNode
  | ExtendValueNode
  | HelperCallValueNode;

export function createValueStack(context: ValueStackContext): ValueStack {
  const { body, values, analysis } = context;
  const registry = createLocalRegistry(body, context.scratch);
  // Unpinned readState outputs reload from their channel at every use.
  const reads = new Map<ValueId, ReadStateAction>();

  function emitUse(id: ValueId): void {
    if (registry.replay(id)) {
      return;
    }

    const node = values.node(id);

    switch (node.kind) {
      case "const":
        body.i32Const(node.value);
        return;
      case "external": {
        const local = context.externalLocals.get(node.external);

        assert(local !== undefined, `no local bound for external value ${node.external}`);
        body.localGet(local);
        return;
      }
      case "actionOutput": {
        const read = reads.get(id);

        assert(read !== undefined, `action output ${id} has no readState source`);
        context.loadSlot(read.slot, read.signed === true, emitUse);
        return;
      }
      default: {
        emitCompute(node);

        const uses = analysis.useCount(id);

        if (uses > 1) {
          registry.captureTee(id, uses - 1, wasmTypeForValue(values.valueType(id)));
        }

        return;
      }
    }
  }

  function emitCompute(node: CompoundValueNode): void {
    switch (node.kind) {
      case "binary":
        emitUse(node.a);
        emitUse(node.b);
        emitBinaryOperator(body, node);
        return;
      case "unary":
        emitUse(node.value);
        emitUnaryOperator(body, node);
        return;
      case "compare": {
        // eq against zero is wasm's eqz; the other zero compares have no
        // dedicated opcode.
        const eqzOperand = node.type === "i32" ? zeroEqualityOperand(node) : undefined;

        if (eqzOperand !== undefined) {
          emitUse(eqzOperand);
          body.i32Eqz();
          return;
        }

        emitUse(node.a);
        emitUse(node.b);
        emitCompareOperator(body, node);
        return;
      }
      case "select":
        emitUse(node.whenTrue);
        emitUse(node.whenFalse);
        emitUse(node.condition);
        body.select();
        return;
      case "truncate":
        emitUse(node.value);
        emitTruncate(body, node);
        return;
      case "extend":
        emitUse(node.value);
        emitExtend(body, node);
        return;
      case "helperCall": {
        const displayName = helperFunctionName(node.helper);

        assert(context.helpers !== undefined, `missing Wasm helper ${displayName} in module registry`);
        body.callFunction(context.helpers.requireFunctionIndex(node.helper, displayName));
        return;
      }
    }
  }

  function zeroEqualityOperand(node: CompareValueNode): ValueId | undefined {
    if (node.operator !== "eq") {
      return undefined;
    }

    if (isConstZero(node.a)) {
      return node.b;
    }

    return isConstZero(node.b) ? node.a : undefined;
  }

  function isConstZero(id: ValueId): boolean {
    const node = values.node(id);

    return node.kind === "const" && node.value === 0;
  }

  function captureValue(id: ValueId): void {
    if (registry.has(id)) {
      return;
    }

    const node = values.node(id);

    switch (node.kind) {
      case "const":
      case "external":
        // Re-emittable anywhere.
        return;
      case "actionOutput":
        // Unpinned reads reload their untouched channel; pinned reads and
        // loaded values sit in the registry.
        assert(reads.has(id), `action output ${id} has no replay source`);
        return;
      default: {
        // Not in the registry means nothing consumed it yet (the pending
        // edge use keeps a consumed multi-use compound captured), so every
        // counted use is still to come.
        emitCompute(node);
        registry.captureSet(id, analysis.useCount(id), wasmTypeForValue(values.valueType(id)));
        return;
      }
    }
  }

  return {
    readState(action: ReadStateAction): void {
      const uses = analysis.useCount(action.output);

      if (uses === 0) {
        return;
      }

      // Dynamic slots follow the guest-load policy and pin at their action
      // point, so the index is consumed exactly once per address push and
      // may be any expression. Static channels reload at use unless a later
      // overlapping store would corrupt the load.
      if (!isDynamicSlot(action.slot) && !analysis.isPinned(action.output)) {
        reads.set(action.output, action);
        return;
      }

      context.loadSlot(action.slot, action.signed === true, emitUse);
      registry.captureSet(action.output, uses, wasmTypeForValue(values.valueType(action.output)));
    },
    readMemory(action: ReadMemoryAction): void {
      const uses = analysis.useCount(action.output);

      if (uses === 0) {
        return;
      }

      // Boring policy: every loaded value pins at its action point.
      emitUse(action.address);
      context.loadGuest(action.width, action.signed === true);
      registry.captureSet(action.output, uses, wasmTypeForValue(values.valueType(action.output)));
    },
    captureForEdge(edge: EdgeRegion): void {
      for (const id of edgeValues(edge)) {
        captureValue(id);
      }
    },
    emitUse,
    assertClear: () => registry.assertClear()
  };
}

// All scratch-local bookkeeping in one place: which local replays a value,
// how many uses remain, freeing at the last one. Captures take the value on
// top of the stack, so the walk above never sees a local index and stays
// policy-only.
type LocalRegistry = Readonly<{
  // Pops the stack top into a fresh local.
  captureSet(id: ValueId, remainingUses: number, type: WasmValueType): void;
  // Copies the stack top into a fresh local, leaving it pushed as one use.
  captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void;
  replay(id: ValueId): boolean;
  has(id: ValueId): boolean;
  assertClear(): void;
}>;

function createLocalRegistry(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator
): LocalRegistry {
  const entries = new Map<ValueId, { local: number; remainingUses: number }>();

  function capture(id: ValueId, remainingUses: number, type: WasmValueType): number {
    assert(remainingUses > 0, `cannot capture value ${id} without remaining uses`);
    assert(!entries.has(id), `value ${id} is already captured`);

    const local = scratch.allocLocal(type);

    entries.set(id, { local, remainingUses });
    return local;
  }

  return {
    captureSet(id: ValueId, remainingUses: number, type: WasmValueType): void {
      body.localSet(capture(id, remainingUses, type));
    },
    captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void {
      body.localTee(capture(id, remainingUses, type));
    },
    replay(id: ValueId): boolean {
      const entry = entries.get(id);

      if (entry === undefined) {
        return false;
      }

      body.localGet(entry.local);
      entry.remainingUses -= 1;

      if (entry.remainingUses === 0) {
        entries.delete(id);
        scratch.freeLocal(entry.local);
      }

      return true;
    },
    has: (id) => entries.has(id),
    assertClear(): void {
      assert(
        entries.size === 0,
        `captured values with unconsumed uses: ${[...entries.keys()].join(", ")}`
      );
    }
  };
}

function emitBinaryOperator(body: WasmFunctionBodyEncoder, node: BinaryValueNode): void {
  if (node.type === "i64") {
    switch (node.operator) {
      case "mul":
        body.i64Mul();
        return;
      case "rem_u":
        body.i64RemU();
        return;
      case "or":
        body.i64Or();
        return;
      case "shl":
        body.i64Shl();
        return;
      case "shr_s":
        body.i64ShrS();
        return;
      case "shr_u":
        body.i64ShrU();
        return;
    }

    assert(false, `unsupported i64 binary operator ${node.operator}`);
  }

  switch (node.operator) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "mul":
      body.i32Mul();
      return;
    case "rem_u":
      body.i32RemU();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "or":
      body.i32Or();
      return;
    case "and":
      body.i32And();
      return;
    case "shl":
      body.i32Shl();
      return;
    case "rotl":
      body.i32Rotl();
      return;
    case "rotr":
      body.i32Rotr();
      return;
    case "shr_s":
      body.i32ShrS();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

function emitUnaryOperator(body: WasmFunctionBodyEncoder, node: UnaryValueNode): void {
  switch (node.operator) {
    case "popcnt":
      body.i32Popcnt();
      return;
  }
}

function emitExtend(body: WasmFunctionBodyEncoder, node: ExtendValueNode): void {
  if (!node.signed) {
    emitTruncateFromI32(body, node.width);

    if (node.type === "i64") {
      body.i64ExtendI32U();
    }

    return;
  }

  switch (node.width) {
    case 8:
      body.i32Extend8S();
      break;
    case 16:
      body.i32Extend16S();
      break;
    case 32:
      break;
  }

  if (node.type === "i64") {
    body.i64ExtendI32S();
  }
}

function wasmTypeForValue(type: ValueType): WasmValueType {
  switch (type) {
    case "i32":
      return wasmValueType.i32;
    case "i64":
      return wasmValueType.i64;
  }
}

function emitCompareOperator(body: WasmFunctionBodyEncoder, node: CompareValueNode): void {
  if (node.type === "i64") {
    switch (node.operator) {
      case "ne":
        body.i64Ne();
        return;
    }

    assert(false, `unsupported i64 compare operator ${node.operator}`);
  }

  switch (node.operator) {
    case "eq":
      body.i32Eq();
      return;
    case "ne":
      body.i32Ne();
      return;
    case "lt_u":
      body.i32LtU();
      return;
    case "le_u":
      body.i32LeU();
      return;
    case "gt_u":
      body.i32GtU();
      return;
    case "ge_u":
      body.i32GeU();
      return;
    case "lt_s":
      body.i32LtS();
      return;
    case "le_s":
      body.i32LeS();
      return;
    case "gt_s":
      body.i32GtS();
      return;
    case "ge_s":
      body.i32GeS();
      return;
  }
}

function emitTruncate(body: WasmFunctionBodyEncoder, node: TruncateValueNode): void {
  if (node.sourceType === "i64") {
    body.i32WrapI64();
  }

  emitTruncateFromI32(body, node.width);
}

function emitTruncateFromI32(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  switch (width) {
    case 32:
      // A full-width truncation is the value itself.
      return;
    case 16:
      body.i32Const(0xffff).i32And();
      return;
    case 8:
      body.i32Const(0xff).i32And();
      return;
  }
}
