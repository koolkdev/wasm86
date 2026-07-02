import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { OpAction } from "#ir/actions.js";
import type { CpuResolveFlagOp, MemoryCheckOp, MemoryReadOp } from "#ir/ops.js";
import type { Body } from "#ir/block.js";
import { isDynamicSlot, type StateSlot } from "#ir/slots.js";
import type {
  BinaryValueNode,
  CompareValueNode,
  ExtendValueNode,
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
import { bodyInputValues, type BlockValueAnalysis } from "./values.js";

// Turns analysis + the value graph into stack code. emitUse pushes exactly
// one use of a value; anything needed more than once is captured into a
// refcounted scratch local and replayed until its last counted use. A
// lowering that observes one operand several times borrows it instead of
// consuming extra uses. The registry below is the only scratch-local
// mechanism in the emitter; borrows pin its locals rather than copy them.

// A borrowed operand: the first push() takes its one counted use; later
// pushes replay it for free until release().
export type BorrowedUse = Readonly<{
  push(): void;
  release(): void;
}>;

// How lowerings consume operands: push each one exactly once (emitUse) or
// borrow it for repeated observation (borrowUse).
export type OperandUses = Readonly<{
  emitUse(id: ValueId): void;
  borrowUse(id: ValueId): BorrowedUse;
}>;

export type ValueStackContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  analysis: BlockValueAnalysis;
  // External id -> the wasm local the embedding bound it to.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  // Pushes the slot's current value; the driver wires this to the state
  // access layer — the value stack never sees offsets. A dynamic slot's
  // index value is consumed through the given operand uses.
  loadSlot(slot: StateSlot, signed: boolean, operands: OperandUses): void;
  // Loads guest memory at the address already on the stack.
  loadGuest(width: OperandWidth, signed: boolean): void;
  // Checks guest memory bounds for an address already on the stack.
  checkGuest(byteLength: number): void;
  helpers?: WasmHelperRegistry | undefined;
}>;

export type ValueStack = Readonly<{
  // The driver calls this at each output-producing op action point, in action order.
  scheduledProducer(action: OpAction): void;
  // Pushes one use of the value onto the stack.
  emitUse(id: ValueId): void;
  // Borrows one counted use of the value for repeated observation.
  borrowUse(id: ValueId): BorrowedUse;
  // Called before entering a nested body: its actions are emitted later but
  // executes here, so anything it consumes must be replayable from a local.
  captureForBody(body: Body): void;
  // Every captured value fully consumed, every scratch local returned.
  assertClear(): void;
}>;

type CompoundValueNode =
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | TruncateValueNode
  | ExtendValueNode;

export function createValueStack(context: ValueStackContext): ValueStack {
  const { body, values, analysis } = context;
  const registry = createLocalRegistry(body, context.scratch);
  // Unpinned state.read outputs reload from their channel at every use.
  const reads = new Map<ValueId, StateRead>();
  // Open borrows per value; assertClear reports leaks.
  const borrows = new Map<ValueId, number>();
  const operands: OperandUses = { emitUse, borrowUse };

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

        assert(read !== undefined, `action output ${id} has no reloadable state.read source`);
        context.loadSlot(read.slot, read.signed, operands);
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
        // Unpinned state reads reload their untouched channel; pinned reads and
        // loaded values sit in the registry.
        assert(reads.has(id), `action output ${id} has no replay source`);
        return;
      default: {
        // Not in the registry means nothing consumed it yet (the pending
        // nested-body use keeps a consumed multi-use compound captured, so every
        // counted use is still to come.
        emitCompute(node);
        registry.captureSet(id, analysis.useCount(id), wasmTypeForValue(values.valueType(id)));
        return;
      }
    }
  }

  function borrowUse(id: ValueId): BorrowedUse {
    const node = values.node(id);

    // Consts and externals re-emit freely; the borrow holds nothing.
    if (node.kind === "const" || node.kind === "external") {
      const reemit = () => emitUse(id);

      return createBorrow(id, { first: reemit, repeat: reemit });
    }

    // Everything else consumes its counted use at the first push and pins
    // the registry local it lands in until release.
    return createBorrow(id, {
      first: () => emitPinnedUse(id),
      repeat: () => registry.peek(id),
      close: () => registry.unpin(id)
    });
  }

  // Tracks the borrow and enforces the push/release order; the policy says
  // what to emit.
  function createBorrow(
    id: ValueId,
    policy: Readonly<{ first(): void; repeat(): void; close?(): void }>
  ): BorrowedUse {
    let pushed = false;
    let released = false;

    borrows.set(id, (borrows.get(id) ?? 0) + 1);

    return {
      push(): void {
        assert(!released, `borrowed value ${id} pushed after release`);
        pushed ? policy.repeat() : policy.first();
        pushed = true;
      },
      release(): void {
        assert(!released, `borrowed value ${id} released twice`);
        assert(pushed, `borrowed value ${id} released without a push`);
        released = true;

        const remaining = borrows.get(id)! - 1;

        remaining === 0 ? borrows.delete(id) : borrows.set(id, remaining);
        policy.close?.();
      }
    };
  }

  // Emits one counted use of the value and pins its registry local.
  function emitPinnedUse(id: ValueId): void {
    // Pin first: the replay below may consume the last counted use.
    if (registry.has(id)) {
      registry.pin(id);
      emitUse(id);
      return;
    }

    // A multi-use value tees itself into the registry when computed; a
    // single-use one is captured under the pin alone.
    emitUse(id);

    if (registry.has(id)) {
      registry.pin(id);
    } else {
      registry.capturePinned(id, wasmTypeForValue(values.valueType(id)));
    }
  }

  return {
    scheduledProducer(action: OpAction): void {
      switch (action.op.kind) {
        case "state.read": {
          const output = action.output;

          assert(output !== undefined, "state.read op action is missing its output");
          captureStateRead({ output, slot: action.op.slot, signed: action.op.signed === true });
          return;
        }
        case "memory.read": {
          const output = action.output;

          assert(output !== undefined, "memory.read op action is missing its output");
          captureMemoryRead({ output, op: action.op });
          return;
        }
        case "memory.check": {
          const output = action.output;

          assert(output !== undefined, "memory.check op action is missing its output");
          captureMemoryCheck({ output, op: action.op });
          return;
        }
        case "cpu.resolveFlag": {
          const output = action.output;

          assert(output !== undefined, "cpu.resolveFlag op action is missing its output");
          captureResolveFlag({ output, op: action.op });
          return;
        }
        case "state.write":
        case "memory.write":
          assert(false, `${action.op.kind} op action does not produce an output`);
          return;
      }
    },
    captureForBody(body: Body): void {
      for (const id of bodyInputValues(body)) {
        captureValue(id);
      }
    },
    emitUse,
    borrowUse,
    assertClear(): void {
      assert(
        borrows.size === 0,
        `borrowed values never released: ${[...borrows.keys()].join(", ")}`
      );
      registry.assertClear();
    }
  };

  function captureStateRead(read: StateRead): void {
    const uses = analysis.useCount(read.output);

    if (uses === 0) {
      return;
    }

    // Dynamic slots follow the guest-load policy and pin at their action
    // point: a reload at use would consume the index a second time.
    // Static channels reload at use unless a later overlapping store
    // would corrupt the load.
    if (!isDynamicSlot(read.slot) && !analysis.isPinned(read.output)) {
      reads.set(read.output, read);
      return;
    }

    captureAtProducer(read.output, () => context.loadSlot(read.slot, read.signed, operands));
  }

  function captureMemoryRead(action: MemoryReadProducer): void {
    // Boring policy: every loaded value pins at its action point.
    captureAtProducer(action.output, () => {
      emitUse(action.op.address);
      context.loadGuest(action.op.width, action.op.signed === true);
    });
  }

  function captureMemoryCheck(action: MemoryCheckProducer): void {
    captureAtProducer(action.output, () => {
      emitUse(action.op.address);
      context.checkGuest(action.op.byteLength);
    });
  }

  function captureResolveFlag(action: ResolveFlagProducer): void {
    const helper = { kind: "lazyFlag", flag: action.op.flag } as const;
    const displayName = helperFunctionName(helper);

    captureAtProducer(action.output, () => {
      assert(context.helpers !== undefined, `missing Wasm helper ${displayName} in module registry`);
      body.callFunction(context.helpers.requireFunctionIndex(helper, displayName));
    });
  }

  function captureAtProducer(output: ValueId, emitValue: () => void): void {
    const uses = analysis.useCount(output);

    if (uses === 0) {
      return;
    }

    emitValue();
    registry.captureSet(output, uses, wasmTypeForValue(values.valueType(output)));
  }
}

type StateRead = Readonly<{ output: ValueId; slot: StateSlot; signed: boolean }>;
type MemoryReadProducer = Readonly<{ output: ValueId; op: MemoryReadOp }>;
type MemoryCheckProducer = Readonly<{ output: ValueId; op: MemoryCheckOp }>;
type ResolveFlagProducer = Readonly<{ output: ValueId; op: CpuResolveFlagOp }>;

// All scratch-local bookkeeping in one place: which local replays a value,
// how many uses remain, freeing at the last one — deferred while pins hold
// the local for a borrow. Captures take the value on top of the stack, so
// the walk above never sees a local index and stays policy-only.
type LocalRegistry = Readonly<{
  // Pops the stack top into a fresh local.
  captureSet(id: ValueId, remainingUses: number, type: WasmValueType): void;
  // Copies the stack top into a fresh local, leaving it pushed as one use.
  captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void;
  // Copies the stack top into a fresh local held only by a pin.
  capturePinned(id: ValueId, type: WasmValueType): void;
  replay(id: ValueId): boolean;
  // Replays without consuming a counted use; only sound under a pin.
  peek(id: ValueId): void;
  // Pins keep an entry alive past its last counted use until unpinned.
  pin(id: ValueId): void;
  unpin(id: ValueId): void;
  has(id: ValueId): boolean;
  assertClear(): void;
}>;

type RegistryEntry = { local: number; remainingUses: number; pins: number };

function createLocalRegistry(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator
): LocalRegistry {
  const entries = new Map<ValueId, RegistryEntry>();

  function capture(id: ValueId, remainingUses: number, pins: number, type: WasmValueType): number {
    assert(remainingUses > 0 || pins > 0, `cannot capture value ${id} without uses or pins`);
    assert(!entries.has(id), `value ${id} is already captured`);

    const local = scratch.allocLocal(type);

    entries.set(id, { local, remainingUses, pins });
    return local;
  }

  function getEntry(id: ValueId): RegistryEntry {
    const entry = entries.get(id);

    assert(entry !== undefined, `value ${id} is not captured`);
    return entry;
  }

  function maybeFree(id: ValueId, entry: RegistryEntry): void {
    if (entry.remainingUses === 0 && entry.pins === 0) {
      entries.delete(id);
      scratch.freeLocal(entry.local);
    }
  }

  return {
    captureSet(id: ValueId, remainingUses: number, type: WasmValueType): void {
      body.localSet(capture(id, remainingUses, 0, type));
    },
    captureTee(id: ValueId, remainingUses: number, type: WasmValueType): void {
      body.localTee(capture(id, remainingUses, 0, type));
    },
    capturePinned(id: ValueId, type: WasmValueType): void {
      body.localTee(capture(id, 0, 1, type));
    },
    replay(id: ValueId): boolean {
      const entry = entries.get(id);

      if (entry === undefined) {
        return false;
      }

      assert(entry.remainingUses > 0, `no counted uses of value ${id} remain`);
      body.localGet(entry.local);
      entry.remainingUses -= 1;
      maybeFree(id, entry);
      return true;
    },
    peek(id: ValueId): void {
      body.localGet(getEntry(id).local);
    },
    pin(id: ValueId): void {
      getEntry(id).pins += 1;
    },
    unpin(id: ValueId): void {
      const entry = getEntry(id);

      assert(entry.pins > 0, `value ${id} is not pinned`);
      entry.pins -= 1;
      maybeFree(id, entry);
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
    case "div_u":
      body.i32DivU();
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
