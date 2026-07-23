import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "#compiler/ir/region.js";
import type {
  RegionCompletionContext,
  NestedRegion
} from "#compiler/ir/node.js";
import {
  ControlBase,
  TerminalControlBase
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
  body: Region;
}>;

export class LoopControl extends ControlBase {
  static readonly kind = "loop";
  readonly kind = LoopControl.kind;
  readonly operands: readonly ValueId[];
  readonly nestedBodies: readonly [NestedRegion];
  readonly outputs: readonly [] = [];

  private constructor(
    readonly carried: readonly LoopCarriedCell[],
    readonly body: Region
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

  completes(_context: RegionCompletionContext): false {
    return false;
  }

  mapBodies(map: (body: Region) => Region): LoopControl {
    return LoopControl.create({ carried: this.carried, body: map(this.body) });
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
}

export const loopContinueControl = LoopContinueControl;
