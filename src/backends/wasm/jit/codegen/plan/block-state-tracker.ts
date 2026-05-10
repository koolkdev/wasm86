import { reg32 } from "#x86/isa/types.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type {
  JitExitSnapshotKind,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import { JitValueTracker } from "#backends/wasm/jit/ir/value-tracker.js";
import {
  jitFlagProducerValue,
  jitValueForStorage,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  jitStorageRegisterAccess,
  type JitRegisterValueMap
} from "#backends/wasm/jit/ir/register-prefix-values.js";
import {
  createJitValueState,
  type JitValueStateSnapshot
} from "#backends/wasm/jit/state/value-state.js";

export class JitBlockStateTracker {
  private readonly valueState = createJitValueState();
  private readonly values = new JitValueTracker();
  private effectVisibleValueState: JitValueStateSnapshot = this.valueState.snapshot();
  private committedFlagsMask = IR_ALU_FLAG_MASK;
  private speculativeFlagsMask = 0;
  private instructionCountDelta = 0;

  beginInstruction(): void {
    this.values.clear();
    this.effectVisibleValueState = this.valueState.snapshot();
  }

  snapshot(kind: JitExitSnapshotKind, eip: number): JitStateSnapshot {
    return {
      kind,
      eip,
      instructionCountDelta: this.instructionCountDelta,
      valueState: this.valueState.snapshot(),
      committedFlags: { mask: this.committedFlagsMask },
      speculativeFlags: { mask: this.speculativeFlagsMask }
    };
  }

  snapshotPostInstruction(eip: number): JitStateSnapshot {
    return {
      kind: "postInstruction",
      eip,
      instructionCountDelta: this.instructionCountDelta + 1,
      valueState: this.valueState.snapshot(),
      committedFlags: { mask: this.committedFlagsMask },
      speculativeFlags: { mask: this.speculativeFlagsMask }
    };
  }

  effectVisiblePreInstructionSnapshot(entry: JitStateSnapshot): JitStateSnapshot {
    return {
      ...entry,
      valueState: this.effectVisibleValueState,
      committedFlags: { mask: this.committedFlagsMask }
    };
  }

  advanceEffectVisibleSnapshot(): void {
    this.effectVisibleValueState = this.valueState.snapshot();
  }

  pendingFlags(mask: number): number {
    return mask & this.speculativeFlagsMask;
  }

  recordOp(
    op: JitIrOp,
    instruction: JitIrBlockInstruction,
    _instructionIndex: number,
    _opIndex: number
  ): void {
    switch (op.op) {
      case "get":
        this.values.record(op.dst.id, jitValueForStorage(
          op.source,
          instruction.operands,
          this.currentRegisterValues(),
          op.accessWidth ?? 32,
          op.signed === true
        ));
        return;
      case "address":
      case "value.const":
      case "value.binary":
      case "value.unary":
      case "value.select":
        this.values.recordOp(op, instruction, this.currentRegisterValues());
        return;
      case "aluFlags.condition":
        this.values.record(op.dst.id, this.valueState.flags.condition(op.cc));
        return;
      case "set":
        this.recordSet(op, instruction);
        return;
      case "flags.set":
        this.recordFlagSet(op);
        return;
      case "flags.materialize":
      case "flags.boundary":
      case "flagProducer.condition":
      case "next":
      case "jump":
      case "conditionalJump":
      case "hostTrap":
        return;
    }
  }

  markSpeculativeFlags(mask: number): void {
    this.speculativeFlagsMask |= mask;
    this.committedFlagsMask &= ~mask;
  }

  commitFlags(mask: number): void {
    const committedMask = mask & this.speculativeFlagsMask;

    this.speculativeFlagsMask &= ~mask;
    this.committedFlagsMask |= committedMask;
  }

  commitInstruction(): void {
    this.instructionCountDelta += 1;
  }

  private recordSet(op: Extract<JitIrOp, { op: "set" }>, instruction: JitIrBlockInstruction): void {
    const value = this.values.valueFor(op.value);
    const access = jitStorageRegisterAccess(op.target, instruction.operands, op.accessWidth ?? 32);

    if (access === undefined) {
      return;
    }

    if (value === undefined) {
      // 3B only needs the legacy exit bridge to know that the target register
      // changed. The concrete produced/store-source value is handled in 3C.
      this.valueState.regs.writeReg32(access.reg, { kind: "reg", reg: access.reg });
      return;
    }

    if (access.width === 32 && access.bitOffset === 0) {
      this.valueState.regs.writeReg32(access.reg, value);
    } else {
      this.valueState.regs.writeRegPart(access.reg, access.bitOffset, access.width, value);
    }
  }

  private recordFlagSet(op: Extract<JitIrOp, { op: "flags.set" }>): void {
    const producer = this.flagProducerValue(op);
    const mask = (op.writtenMask | op.undefMask) >>> 0;

    if (producer !== undefined && mask !== 0) {
      this.valueState.flags.writeFlagBits(mask, producer);
    }
  }

  private flagProducerValue(
    op: Extract<JitIrOp, { op: "flags.set" }>
  ): JitValue | undefined {
    const inputs = this.flagProducerInputs(op.inputs);

    return inputs === undefined
      ? undefined
      : jitFlagProducerValue(op.producer, inputs, {
          ...(op.width === undefined ? {} : { width: op.width }),
          mask: op.writtenMask | op.undefMask
        });
  }

  private flagProducerInputs(inputs: Readonly<Record<string, ValueRef>>): Readonly<Record<string, JitValue>> | undefined {
    const values: Record<string, JitValue> = {};

    for (const [name, ref] of Object.entries(inputs)) {
      const value = this.values.valueFor(ref);

      if (value === undefined) {
        return undefined;
      }

      values[name] = value;
    }

    return values;
  }

  private currentRegisterValues(): JitRegisterValueMap {
    return new Map(reg32.map((reg) => [reg, this.valueState.regs.readReg32(reg)]));
  }
}
