import { reg32 } from "#x86/isa/types.js";
import type { IrOp } from "#x86/ir/model/types.js";
import {
  instructionExit,
  type JitBoundaryRef,
  type JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { JitValueTracker } from "#backends/wasm/jit/ir/value-tracker.js";
import {
  jitStorageRegisterAccess,
  type JitRegisterValueMap
} from "#backends/wasm/jit/ir/register-prefix-values.js";
import {
  createJitValueState,
} from "#backends/wasm/jit/state/value-state.js";
import {
  jitFlagSetProducerValue,
  jitFlagSetWrittenMask
} from "./flag-values.js";

export class JitBlockStateTracker {
  #valueState = createJitValueState();
  #values = new JitValueTracker();
  #instructionCountDelta = 0;

  beginInstruction(): void {
    this.#values.clear();
  }

  snapshot(boundary: JitBoundaryRef): JitStateSnapshot {
    return {
      boundary,
      instructionCountDelta: this.#instructionCountDelta,
      valueState: this.#valueState.snapshot()
    };
  }

  snapshotPostInstruction(
    instructionIndex: number,
    instruction: JitIrBlockInstruction
  ): JitStateSnapshot {
    return {
      boundary: instructionExit(instructionIndex, instruction),
      instructionCountDelta: this.#instructionCountDelta + 1,
      valueState: this.#valueState.snapshot()
    };
  }

  recordOp(
    op: IrOp,
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number
  ): void {
    switch (op.op) {
      case "get":
      case "address":
      case "value.const":
      case "value.binary":
      case "value.unary":
      case "value.select":
        this.#values.recordOp(
          op,
          instruction,
          this.#currentRegisterValues(),
          {
            location: { instructionIndex, opIndex }
          }
        );
        return;
      case "flags.condition":
        this.#values.record(op.dst.id, this.#valueState.flags.condition(op.cc));
        return;
      case "set":
        this.#recordSet(op, instruction);
        return;
      case "flags.set":
        this.#recordFlagSet(op);
        return;
      case "next":
      case "jump":
      case "conditionalJump":
      case "hostTrap":
        return;
    }
  }

  commitInstruction(): void {
    this.#instructionCountDelta += 1;
  }

  #recordSet(
    op: Extract<IrOp, { op: "set" }>,
    instruction: JitIrBlockInstruction
  ): void {
    const value = this.#values.valueFor(op.value);
    const access = jitStorageRegisterAccess(op.target, instruction.operands, op.accessWidth ?? 32);

    if (access === undefined) {
      return;
    }

    if (value === undefined) {
      throw new Error("could not resolve JIT block-state register write");
    }

    if (access.width === 32 && access.bitOffset === 0) {
      this.#valueState.regs.writeReg32(access.reg, value);
    } else {
      this.#valueState.regs.writeRegPart(access.reg, access.bitOffset, access.width, value);
    }
  }

  #recordFlagSet(op: Extract<IrOp, { op: "flags.set" }>): void {
    const mask = jitFlagSetWrittenMask(op);

    if (mask === 0) {
      return;
    }

    const producer = jitFlagSetProducerValue(op, this.#values.inputRecordFor(op.inputs));
    this.#valueState.flags.writeFlagBits(mask, producer);
  }

  #currentRegisterValues(): JitRegisterValueMap {
    return new Map(reg32.map((reg) => [reg, this.#valueState.regs.readReg32(reg)]));
  }
}
