import type { IrMemoryAccessKind } from "#ir/model/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class MemoryWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #site: () => OpSite;
  readonly #snapshot: () => BlockState;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    site: () => OpSite;
    snapshot: () => BlockState;
  }>) {
    this.#recorder = input.recorder;
    this.#site = input.site;
    this.#snapshot = input.snapshot;
  }

  guard(address: ExprRef, byteLength: number, access: IrMemoryAccessKind): void {
    const at = this.#site();
    const faultExit = this.#recorder.exit(
      at,
      this.#snapshot(),
      "memoryFault",
      Object.freeze({
        kind: "memoryFault",
        address,
        byteLength,
        access
      })
    );

    this.#recorder.action(Object.freeze({
      kind: "memoryGuard",
      at,
      address,
      byteLength,
      access,
      faultExit
    }));
  }

  load(address: ExprRef, width: OperandWidth): ExprRef {
    return this.#recorder.memoryLoad(this.#site(), address, width);
  }

  store(address: ExprRef, value: ExprRef, width: OperandWidth): void {
    this.#recorder.action(Object.freeze({
      kind: "memoryStore",
      at: this.#site(),
      address,
      value,
      width
    }));
  }
}
