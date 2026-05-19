import { jitLoadResultValue } from "#backends/wasm/jit/ir/values/builders.js";
import type { JitLoadResultValue } from "#backends/wasm/jit/ir/values/types.js";
import type { IrValueType } from "#x86/ir/model/types.js";

export class LoadResultRegistry {
  #nextId = 0;

  createLoadResultValue(type: IrValueType): JitLoadResultValue {
    const id = this.#nextId;

    this.#nextId += 1;
    return jitLoadResultValue(id, type);
  }
}
