import type { IntegerWidth } from "./types.js";
import type { ValueDefinition } from "./definition.js";
import { truncateInteger } from "./integer-width.js";
import type { ValueId, ValueType } from "./types.js";
import { fitsUnsigned } from "./width-bounds.js";

// Truncation always produces an i32. An i64 input is wrapped to i32 first;
// both input types are then masked to the requested meaningful width.
type TruncateArgs = Readonly<{
  inputType: ValueType;
  width: IntegerWidth;
  value: ValueId;
}>;

type TruncateNode = Readonly<TruncateArgs & { kind: "truncate" }>;

export const truncateValue: ValueDefinition<TruncateArgs, TruncateNode> = {
  create: ({ inputType, width, value }) => ({ kind: "truncate", inputType, width, value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.inputType, node.width, node.value]
  },
  inputs: (node) => [{ value: node.value, type: node.inputType }],
  resultType: () => "i32",
  widthBounds: (node, context) => {
    switch (node.inputType) {
      case "i32":
        return fitsUnsigned(
          Math.min(node.width, context.widthBounds(node.value).unsignedBits)
        );
      case "i64":
        return fitsUnsigned(node.width);
    }
  },
  fold: (node, context) => {
    switch (node.inputType) {
      case "i32": {
        const constant = context.constValue(node.value);

        if (constant !== undefined) {
          return context.constant(truncateInteger(node.width, constant));
        }

        return node.width === 32 || context.widthBounds(node.value).unsignedBits <= node.width
          ? node.value
          : undefined;
      }
      case "i64": {
        // Truncating an extension back to its source width discards every bit
        // added by the extension, so its signedness no longer matters.
        const source = context.extension(node.value);

        if (source !== undefined && source.resultType === "i64" && source.width === node.width) {
          return context.truncate(node.width, source.value);
        }

        return undefined;
      }
    }
  },
  captureMode: "compute"
};
