import type { ValueDefinition } from "./definition.js";
import type { ValueId } from "./types.js";
import { joinWidthBounds } from "./width-bounds.js";

type SelectArgs = Readonly<{
  condition: ValueId;
  whenTrue: ValueId;
  whenFalse: ValueId;
}>;

type SelectNode = Readonly<SelectArgs & { kind: "select" }>;

export const selectValue: ValueDefinition<SelectArgs, SelectNode> = {
  create: ({ condition, whenTrue, whenFalse }) => ({
    kind: "select",
    condition,
    whenTrue,
    whenFalse
  }),
  internKey: (node) => [node.condition, node.whenTrue, node.whenFalse],
  // Wasm select consumes its two alternatives before its condition.
  inputs: (node) => [
    { value: node.whenTrue, type: "i32" },
    { value: node.whenFalse, type: "i32" },
    { value: node.condition, type: "i32" }
  ],
  resultType: () => "i32",
  widthBounds: (node, context) => joinWidthBounds([
    context.widthBounds(node.whenTrue),
    context.widthBounds(node.whenFalse)
  ]),
  fold: (node, context) => {
    if (node.whenTrue === node.whenFalse) {
      return node.whenTrue;
    }

    const condition = context.constValue(node.condition);

    if (condition === undefined) {
      return undefined;
    }

    return condition === 0 ? node.whenFalse : node.whenTrue;
  },
  captureMode: "compute",
  emit: (_id, _node, target) => target.body.select()
};
