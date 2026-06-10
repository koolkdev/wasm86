import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/action/operands.js";
import type { ReadStateAction, StateSlot } from "#ir/action/types.js";
import type {
  BinaryValueNode,
  CompareValueNode,
  ProjectValueNode,
  SelectValueNode,
  UnaryValueNode,
  ValueId,
  ValueTable
} from "#ir/action/values.js";
import type { IrBinaryOperator, IrCompareOperator, IrUnaryOperator } from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import type { RegionValueAnalysis } from "./values.js";

// Turns analysis + the value graph into stack code. emitUse pushes exactly
// one use of a value; anything needed more than once is captured into a
// refcounted scratch local and replayed until its last counted use. The
// registry below is the only scratch-local mechanism in the emitter.

export type ValueStackContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  analysis: RegionValueAnalysis;
  // External id -> the wasm local the embedding bound it to.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  // Pushes the channel's current value; the driver wires this to the state
  // access layer — the value stack never sees offsets.
  loadSlot(slot: StateSlot, signed: boolean): void;
}>;

export type ValueStack = Readonly<{
  // The driver calls this at each readState action point, in action order.
  readState(action: ReadStateAction): void;
  // Pushes one use of the value onto the stack.
  emitUse(id: ValueId): void;
  // Every captured value fully consumed, every scratch local returned.
  assertClear(): void;
}>;

type CompoundValueNode =
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | ProjectValueNode;

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
        context.loadSlot(read.slot, read.signed === true);
        return;
      }
      default: {
        emitCompute(node);

        const uses = analysis.useCount(id);

        if (uses > 1) {
          body.localTee(registry.capture(id, uses - 1));
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
        emitBinaryOperator(body, node.operator);
        return;
      case "unary":
        emitUse(node.value);
        emitUnaryOperator(body, node.operator);
        return;
      case "compare": {
        // eq against zero is wasm's eqz; the other zero compares have no
        // dedicated opcode.
        const eqzOperand = zeroEqualityOperand(node);

        if (eqzOperand !== undefined) {
          emitUse(eqzOperand);
          body.i32Eqz();
          return;
        }

        emitUse(node.a);
        emitUse(node.b);
        emitCompareOperator(body, node.operator);
        return;
      }
      case "select":
        emitUse(node.whenTrue);
        emitUse(node.whenFalse);
        emitUse(node.condition);
        body.select();
        return;
      case "project":
        emitUse(node.value);
        emitProjection(body, node.width);
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

  return {
    readState(action: ReadStateAction): void {
      const uses = analysis.useCount(action.output);

      if (uses === 0) {
        return;
      }

      if (!analysis.isPinned(action.output)) {
        reads.set(action.output, action);
        return;
      }

      // A later overlapping store would corrupt a load at use: capture now.
      context.loadSlot(action.slot, action.signed === true);
      body.localSet(registry.capture(action.output, uses));
    },
    emitUse,
    assertClear: () => registry.assertClear()
  };
}

// All scratch-local bookkeeping in one place: which local replays a value,
// how many uses remain, freeing at the last one. The walk above stays
// policy-only.
type LocalRegistry = Readonly<{
  capture(id: ValueId, remainingUses: number): number;
  replay(id: ValueId): boolean;
  assertClear(): void;
}>;

function createLocalRegistry(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator
): LocalRegistry {
  const entries = new Map<ValueId, { local: number; remainingUses: number }>();

  return {
    capture(id: ValueId, remainingUses: number): number {
      assert(remainingUses > 0, `cannot capture value ${id} without remaining uses`);
      assert(!entries.has(id), `value ${id} is already captured`);

      const local = scratch.allocLocal(wasmValueType.i32);

      entries.set(id, { local, remainingUses });
      return local;
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
    assertClear(): void {
      assert(
        entries.size === 0,
        `captured values with unconsumed uses: ${[...entries.keys()].join(", ")}`
      );
    }
  };
}

function emitBinaryOperator(body: WasmFunctionBodyEncoder, operator: IrBinaryOperator): void {
  switch (operator) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
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
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

function emitUnaryOperator(body: WasmFunctionBodyEncoder, operator: IrUnaryOperator): void {
  switch (operator) {
    case "extend8_s":
      body.i32Extend8S();
      return;
    case "extend16_s":
      body.i32Extend16S();
      return;
    case "popcnt":
      body.i32Popcnt();
      return;
  }
}

function emitCompareOperator(body: WasmFunctionBodyEncoder, operator: IrCompareOperator): void {
  switch (operator) {
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

function emitProjection(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  switch (width) {
    case 32:
      // A full-width projection is the value itself.
      return;
    case 16:
      body.i32Const(0xffff).i32And();
      return;
    case 8:
      body.i32Const(0xff).i32And();
      return;
  }
}
