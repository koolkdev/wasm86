import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  type OperationDefinition,
  type OperationResult
} from "./definition.js";

type VarReadArgs = Readonly<{ variable: number }>;

export const varRead: OperationDefinition<"var.read", VarReadArgs, OperationResult> = {
  kind: "var.read",

  create(op) {
    assert(
      Number.isInteger(op.variable) && op.variable >= 0,
      "var.read op has an invalid semantic var index"
    );
    return {
      kind: "var.read",
      variable: op.variable,
      inputs: [],
      result: i32Result,
      effects: {
        reads: [{ space: "var", variable: op.variable }],
        writes: []
      }
    };
  },

  emit(operation, { body, variableLocal }) {
    body.localGet(variableLocal(operation.variable));
  }
};

type VarWriteArgs = Readonly<{
  variable: number;
  value: ValueId;
}>;

export const varWrite: OperationDefinition<"var.write", VarWriteArgs, undefined> = {
  kind: "var.write",

  create(op) {
    assert(
      Number.isInteger(op.variable) && op.variable >= 0,
      "var.write op has an invalid semantic var index"
    );
    return {
      kind: "var.write",
      variable: op.variable,
      value: op.value,
      inputs: [{ value: op.value, type: "i32" }],
      result: undefined,
      effects: {
        reads: [],
        writes: [{ space: "var", variable: op.variable }]
      }
    };
  },

  emit(operation, { body, variableLocal }, inputs) {
    inputs.use(0);
    body.localSet(variableLocal(operation.variable));
  }
};

const i32Result: OperationResult = { type: "i32" };
