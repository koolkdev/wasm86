import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import type { JitExitStateSnapshot } from "#backends/wasm/jit/codegen/plan/types.js";
import {
  JitSourceValueMap,
  JitValueStateBuilder
} from "./value-state-builder.js";

export class JitExitStateBuilder {
  readonly #valueState = new JitValueStateBuilder();
  readonly #values = new JitSourceValueMap();
  #instructionCountDelta = 0;

  beginInstruction(): void {
    this.#values.clear();
  }

  instructionCountDelta(): number {
    return this.#instructionCountDelta;
  }

  valueStateSnapshot(): JitExitStateSnapshot["valueState"] {
    return this.#valueState.snapshot();
  }

  exitStateSnapshot(): JitExitStateSnapshot {
    return {
      instructionCountDelta: this.#instructionCountDelta,
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
          this.#valueState.currentRegisterValues(),
          {
            location: { instructionIndex, opIndex }
          }
        );
        return;
      case "flags.condition":
        this.#values.record(op.dst.id, this.#valueState.condition(op.cc));
        return;
      case "set":
        this.#recordSet(op, instruction);
        return;
      case "flags.set":
        this.#valueState.recordFlagSet(op, () => this.#values.inputRecordFor(op.inputs));
        return;
      case "next":
      case "jump":
      case "conditionalJump":
      case "hostTrap":
      case "memory.guard":
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
    this.#valueState.recordSourceSet(op, instruction, this.#values.valueFor(op.value));
  }
}
