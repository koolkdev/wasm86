import { assert } from "#common/assert.js";
import type { X86StatusFlag } from "#core/flags/definitions.js";
import {
  flagChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "#ir/slots.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type {
  OperationDefinition,
  OperationResult
} from "./definition.js";

type ResolveFlagArgs = Readonly<{ flag: X86StatusFlag }>;

export const resolveFlag: OperationDefinition<
  "cpu.resolveFlag",
  ResolveFlagArgs,
  OperationResult
> = {
  kind: "cpu.resolveFlag",

  create(op) {
    return {
      kind: "cpu.resolveFlag",
      flag: op.flag,
      inputs: [],
      result: booleanResult,
      effects: {
        reads: [
          { space: "state", slot: flagChannel(op.flag) },
          { space: "state", slot: lazyFlagsKindChannel },
          { space: "state", slot: lazyFlagsAChannel },
          { space: "state", slot: lazyFlagsBChannel }
        ],
        writes: []
      },
      helper: { kind: "lazyFlag", flag: op.flag }
    };
  },

  emit(operation, { body, helperFunctionIndex }) {
    const helper = operation.helper;

    assert(helper !== undefined, "flag resolution is missing its helper");
    body.callFunction(helperFunctionIndex(helper));
  }
};

const booleanResult: OperationResult = { type: "i32", bounds: fitsUnsigned(1) };
