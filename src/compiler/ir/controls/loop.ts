import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body } from "#ir/block.js";
import type {
  BodyCompletionContext,
  NestedBody,
  ValueUseEmitter
} from "#ir/node.js";
import {
  ControlBase,
  TerminalControlBase,
  type ControlEmitTarget
} from "./definition.js";

// One loop-carried local, seeded at loop entry and read inside the body through
// its scoped `loopInput` value.
export type LoopCarriedCell = Readonly<{
  seed: ValueId;
  loopInput: ValueId;
}>;

// Runs its body until the body falls through. A loopContinue inside the body
// rewrites the carried cells and takes the back edge.
export type LoopControlArgs = Readonly<{
  carried: readonly LoopCarriedCell[];
  body: Body;
}>;

export class LoopControl extends ControlBase {
  static readonly kind = "loop";
  readonly kind = LoopControl.kind;
  readonly operands: readonly ValueId[];
  readonly nestedBodies: readonly [NestedBody];
  readonly outputs: readonly [] = [];

  private constructor(
    readonly carried: readonly LoopCarriedCell[],
    readonly body: Body
  ) {
    super();
    this.operands = carried.map((cell) => cell.seed);
    this.nestedBodies = [
      {
        body,
        role: "body",
        scope: {
          kind: "loop",
          inputs: carried.map((cell) => cell.loopInput)
        }
      }
    ];
  }

  static create({ carried, body }: LoopControlArgs): LoopControl {
    return new LoopControl(carried, body);
  }

  completes(_context: BodyCompletionContext): false {
    return false;
  }

  mapBodies(map: (body: Body) => Body): LoopControl {
    return LoopControl.create({ carried: this.carried, body: map(this.body) });
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    const carriedLocals = this.carried.map((cell) => {
      const local = target.valueLocal(cell.loopInput);

      values.emitUse(cell.seed);
      target.body.localSet(local);
      return local;
    });

    target.emitCaptures();
    target.body.loop();
    target.withLoopBody(carriedLocals, () => target.emitBody(this.body));
    target.body.endBlock();
  }
}

export const loopControl = LoopControl;

export type LoopContinueControlArgs = Readonly<{
  updates: readonly ValueId[];
}>;

export class LoopContinueControl extends TerminalControlBase {
  static readonly kind = "loopContinue";
  readonly kind = LoopContinueControl.kind;
  readonly operands: readonly ValueId[];

  private constructor(readonly updates: readonly ValueId[]) {
    super();
    this.operands = updates;
  }

  static create({ updates }: LoopContinueControlArgs): LoopContinueControl {
    return new LoopContinueControl(updates);
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    const carriedLocals = target.currentLoopLocals();

    assert(
      this.updates.length === carriedLocals.length,
      "loopContinue updates do not align with the loop's cells"
    );
    // Compute every update before overwriting any carried cell.
    for (const update of this.updates) {
      values.emitUse(update);
    }
    for (let index = carriedLocals.length - 1; index >= 0; index -= 1) {
      target.body.localSet(carriedLocals[index]!);
    }
    target.emitLoopBranch();
  }
}

export const loopContinueControl = LoopContinueControl;
