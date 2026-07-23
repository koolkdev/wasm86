import { assert } from "#common/assert.js";
import type { IntegerWidth } from "./types.js";
import type { ValueDefinition } from "./definition.js";
import {
  emitSignedWidth,
  emitUnsignedWidth,
  signExtendInteger,
  truncateInteger
} from "./integer-width.js";
import type { ValueId, ValueType } from "./types.js";
import { fitsUnsigned, signExtended } from "./width-bounds.js";

// Every extension starts with an i32 whose meaningful source width is `width`.
// It is normalized signed or unsigned at that width, then either stays i32 or
// is promoted to i64 according to resultType.
type ExtendArgs = Readonly<{
  resultType: ValueType;
  width: IntegerWidth;
  value: ValueId;
  signed: boolean;
}>;

type ExtendNode = Readonly<ExtendArgs & { kind: "extend" }>;

export const extendValue: ValueDefinition<ExtendArgs, ExtendNode> = {
  create: ({ resultType, width, value, signed }) => ({
    kind: "extend",
    resultType,
    width,
    value,
    signed
  }),
  identity: {
    kind: "scoped",
    key: (node) => [node.resultType, node.width, node.signed, node.value]
  },
  inputs: (node) => [{ value: node.value, type: "i32" }],
  resultType: (node) => node.resultType,
  widthBounds: (node, context) => {
    switch (node.resultType) {
      case "i32": {
        const child = context.widthBounds(node.value);

        return node.signed
          ? signExtended(Math.min(node.width, child.signedBits))
          : fitsUnsigned(Math.min(node.width, child.unsignedBits));
      }
      case "i64":
        assert(false, "width bounds requested for i64 extension value");
    }
  },
  fold: (node, context) => {
    switch (node.resultType) {
      case "i32": {
        const constant = context.constValue(node.value);

        if (constant !== undefined) {
          return context.constant(
            node.signed
              ? signExtendInteger(node.width, constant)
              : truncateInteger(node.width, constant)
          );
        }

        const bounds = context.widthBounds(node.value);
        const knownBits = node.signed ? bounds.signedBits : bounds.unsignedBits;

        return node.width === 32 || knownBits <= node.width
          ? node.value
          : undefined;
      }
      case "i64":
        // The fold context currently creates i32 constants only.
        return undefined;
    }
  },
  captureMode: "compute",
  emit: (_id, node, target) => {
    if (node.signed) {
      emitSignedWidth(target.body, node.width);
    } else {
      emitUnsignedWidth(target.body, node.width);
    }

    switch (node.resultType) {
      case "i32":
        break;
      case "i64":
        if (node.signed) {
          target.body.i64ExtendI32S();
        } else {
          target.body.i64ExtendI32U();
        }
        break;
    }
  }
};
