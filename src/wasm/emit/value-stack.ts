import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { OpAction } from "#ir/actions.js";
import { opAccess } from "#ir/ops.js";
import type { Body } from "#ir/block.js";
import { nestedBodies } from "#ir/traverse.js";
import type { StateSlot } from "#ir/slots.js";
import type {
  BinaryValueNode,
  CompareValueNode,
  ExtendValueNode,
  TruncateValueNode,
  SelectValueNode,
  UnreachableValueNode,
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
import { bodyInputValues, type BlockValueAnalysis, type ScheduledEmission } from "./values.js";

// Turns analysis + the value graph into stack code. emitUse pushes exactly
// one use of a value; anything needed more than once is captured into a
// refcounted scratch local and replayed until its last counted use. An
// emission that observes one operand several times borrows it instead of
// consuming extra uses. The registry below is the only scratch-local
// mechanism in the emitter; borrows pin its locals rather than copy them.

// A borrowed operand: the first push() takes its one counted use; later
// pushes replay it for free until release().
export type BorrowedUse = Readonly<{
  push(): void;
  release(): void;
}>;

// How op emissions consume operands: push each one exactly once (emitUse)
// or borrow it for repeated observation (borrowUse).
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
  | UnreachableValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | TruncateValueNode
  | ExtendValueNode;

// A deferred producer op awaiting its scheduled emissions, consumed in
// emission order.
type PendingProducer = { action: OpAction; emissions: ScheduledEmission[] };

function bodyContains(root: Body, target: Body): boolean {
  if (root === target) {
    return true;
  }

  for (const action of root.actions) {
    for (const nested of nestedBodies(action)) {
      if (bodyContains(nested, target)) {
        return true;
      }
    }
  }

  return false;
}

export function createValueStack(context: ValueStackContext): ValueStack {
  const { body, values, analysis } = context;
  const registry = createLocalRegistry(body, context.scratch);
  // Deferred producer ops, recorded at their action point: each scope
  // that itself demands the value emits the op once — at its first use
  // there or at a subtree's entry — and every use replays that local.
  const pending = new Map<ValueId, PendingProducer>();
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
      // A deferred producer executes here, at its scope's first use, and
      // tees for the rest of that scope's uses.
      case "actionOutput": {
        const uses = emitPendingProducer(id);

        if (uses > 1) {
          registry.captureTee(id, uses - 1, wasmTypeForValue(values.valueType(id)));
        }

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

  // Executes one use-anchored emission of a deferred producer and returns
  // the counted uses it covers.
  function emitPendingProducer(id: ValueId): number {
    const deferred = pending.get(id);

    assert(deferred !== undefined, `action output ${id} has no deferred producer to emit`);

    const emission = deferred.emissions.shift();

    assert(emission !== undefined, `deferred producer ${id} has no scheduled emissions left`);
    assert(
      emission.anchor === "use",
      `deferred producer ${id} reached a use before its scheduled body entry`
    );
    if (deferred.emissions.length === 0) {
      pending.delete(id);
    }

    emitProducer(deferred.action);
    return emission.uses;
  }

  // The one per-kind producer emission: executes the op, consuming its
  // value inputs, and leaves the output on the stack. Placement decides
  // when this runs — at the action point or at the first use — never how.
  function emitProducer(action: OpAction): void {
    const op = action.op;

    switch (op.kind) {
      case "state.read":
        context.loadSlot(op.slot, op.signed === true, operands);
        return;
      case "memory.read":
        emitUse(op.address);
        context.loadGuest(op.width, op.signed === true);
        return;
      case "memory.check":
        emitUse(op.address);
        context.checkGuest(op.byteLength);
        return;
      case "cpu.resolveFlag": {
        const helper = { kind: "lazyFlag", flag: op.flag } as const;
        const displayName = helperFunctionName(helper);

        assert(context.helpers !== undefined, `missing Wasm helper ${displayName} in module registry`);
        body.callFunction(context.helpers.requireFunctionIndex(helper, displayName));
        return;
      }
      default:
        assert(false, `${op.kind} op action does not produce an output`);
    }
  }

  function emitCompute(node: CompoundValueNode): void {
    switch (node.kind) {
      case "unreachable":
        body.unreachable();
        return;
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

  function captureValue(id: ValueId, forBody: Body): void {
    if (registry.has(id)) {
      return;
    }

    const node = values.node(id);

    switch (node.kind) {
      case "const":
      case "external":
        // Re-emittable anywhere.
        return;
      case "actionOutput": {
        const deferred = pending.get(id);

        assert(deferred !== undefined, `action output ${id} has no replay source`);

        const index = deferred.emissions.findIndex((entry) => bodyContains(forBody, entry.body));

        // No emission under this body: an earlier one on the enclosing
        // flow serves its uses before the body runs.
        if (index === -1) {
          return;
        }

        const emission = deferred.emissions[index]!;

        if (emission.anchor === "bodyEntry" && emission.body === forBody) {
          // The scope's emission is anchored here: execute the op on the
          // enclosing flow, before the owning control action, and let
          // every use replay the local.
          deferred.emissions.splice(index, 1);
          if (deferred.emissions.length === 0) {
            pending.delete(id);
          }

          emitProducer(deferred.action);
          registry.captureSet(id, emission.uses, wasmTypeForValue(values.valueType(id)));
          return;
        }

        // The emission lands inside the body: capture what re-emitting
        // the op there needs — its transitive input closure — never the
        // output itself.
        for (const input of opAccess(deferred.action.op).valueInputs) {
          captureValue(input, forBody);
        }

        return;
      }
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
      const output = action.output;

      assert(output !== undefined, `${action.op.kind} op action is missing its output`);

      const uses = analysis.useCount(output);
      const placement = analysis.outputPlacement(output);

      switch (placement.kind) {
        case "deferToUse":
          // Each demanding scope emits the op once; a dead pure op never
          // executes.
          if (uses > 0) {
            pending.set(output, { action, emissions: [...placement.emissions] });
          }

          return;
        case "captureAtProducer":
          emitProducer(action);
          registry.captureSet(output, uses, wasmTypeForValue(values.valueType(output)));
          return;
      }
    },
    captureForBody(body: Body): void {
      for (const id of bodyInputValues(body)) {
        captureValue(id, body);
      }
    },
    emitUse,
    borrowUse,
    assertClear(): void {
      assert(
        borrows.size === 0,
        `borrowed values never released: ${[...borrows.keys()].join(", ")}`
      );
      assert(
        pending.size === 0,
        `deferred producers never emitted: ${[...pending.keys()].join(", ")}`
      );
      registry.assertClear();
    }
  };
}

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
