import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/value.js";

export type ValueNodeBase = Readonly<{ kind: string }>;
export type ValueKey = string | number | bigint | boolean;

export type ValueIdentity<Node> =
  | Readonly<{ kind: "occurrence" }>
  | Readonly<{ kind: "canonical"; key(node: Node): readonly ValueKey[] }>
  | Readonly<{ kind: "scoped"; key(node: Node): readonly ValueKey[] }>;

export type ValueQuery = Readonly<{
  bitWidth(id: ValueId): IntegerWidth;
  constant(id: ValueId): bigint | undefined;
}>;

export type ValueFoldContext = ValueQuery &
  Readonly<{
    constantValue(width: IntegerWidth, value: number | bigint): ValueId;
    unreachable(width: IntegerWidth): ValueId;
    eqz(value: ValueId): ValueId;
    nonzero(value: ValueId): ValueId;
  }>;

export type ValueDefinition<Args, Node extends ValueNodeBase> = Readonly<{
  create(args: Args): Node;
  identity: ValueIdentity<Node>;
  children?(node: Node): readonly ValueId[];
  bitWidth(node: Node, context: ValueQuery): IntegerWidth;
  validate?(node: Node, context: ValueQuery): void;
  fold?(node: Node, context: ValueFoldContext): ValueId | undefined;
  constant?(node: Node): bigint | undefined;
}>;
