import {
  exprBits,
  exprInsertBits,
  exprProject,
  exprSelect
} from "#ir/expr/builders.js";
import {
  modRmBaseSelector,
  modRmHighByteBit,
  type ModRmSelector
} from "#ir/block/modrm-selector.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { RegisterAccessMode } from "#ir/block/state/register-materialization.js";
import type { OperandWidth } from "#x86/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { RegisterAccessValidator } from "./register-access-validator.js";
import type { RegisterWalkState } from "./registers.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class DynamicRegisterWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #registers: RegisterWalkState;
  readonly #validator: RegisterAccessValidator;
  readonly #site: () => OpSite;
  readonly #snapshot: () => BlockState;
  readonly #mode: RegisterAccessMode;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    registers: RegisterWalkState;
    validator: RegisterAccessValidator;
    site: () => OpSite;
    snapshot: () => BlockState;
    mode: RegisterAccessMode;
  }>) {
    this.#recorder = input.recorder;
    this.#registers = input.registers;
    this.#validator = input.validator;
    this.#site = input.site;
    this.#snapshot = input.snapshot;
    this.#mode = input.mode;
  }

  load(selector: ModRmSelector, width: OperandWidth): ExprRef {
    const at = this.#site();
    this.#validator.dynamicLoad(at);

    if (this.#mode === "exact-alias" || width === 32) {
      return this.#recorder.dynamicRegisterLoad(at, selector, width);
    }

    switch (width) {
      case 8: {
        const baseSelector = modRmBaseSelector(selector);
        const base = this.#recorder.dynamicRegisterLoad(at, baseSelector, 32);
        const low = canonicalizeExpr(exprProject(8, base));
        const high = canonicalizeExpr(exprBits(base, 8, 8));

        return canonicalizeExpr(exprSelect(modRmHighByteBit(selector), high, low));
      }
      case 16:
        return canonicalizeExpr(exprProject(16, this.#recorder.dynamicRegisterLoad(at, selector, 32)));
    }
  }

  store(selector: ModRmSelector, value: ExprRef, width: OperandWidth): void {
    const at = this.#site();
    const stateBefore = this.#snapshot();
    const store = this.#mode === "exact-alias"
      ? { selector, value, width }
      : this.#fullBaseStore(at, selector, value, width);

    this.#validator.dynamicStore(at);
    this.#recorder.action(Object.freeze({
      kind: "dynamicRegisterStore",
      at,
      selector: store.selector,
      value: store.value,
      width: store.width,
      stateBefore
    }));
    this.#registers.resetForDynamicRegisterStore();
  }

  #fullBaseStore(
    at: OpSite,
    selector: ModRmSelector,
    value: ExprRef,
    width: OperandWidth
  ): Readonly<{ selector: ModRmSelector; value: ExprRef; width: OperandWidth }> {
    if (width === 32) {
      return { selector, value, width };
    }

    switch (width) {
      case 8: {
        const baseSelector = modRmBaseSelector(selector);
        const base = this.#recorder.dynamicRegisterLoad(at, baseSelector, 32);
        const low = canonicalizeExpr(exprInsertBits(base, value, 0, 8));
        const high = canonicalizeExpr(exprInsertBits(base, value, 8, 8));

        return {
          selector: baseSelector,
          value: canonicalizeExpr(exprSelect(modRmHighByteBit(selector), high, low)),
          width: 32
        };
      }
      case 16:
        return {
          selector,
          value: canonicalizeExpr(exprInsertBits(
            this.#recorder.dynamicRegisterLoad(at, selector, 32),
            value,
            0,
            16
          )),
          width: 32
        };
    }
  }
}
