import type { IntegerWidth, WidthsAtLeast, WidthsAtMost } from "../width.js";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Type extends true> = Type;

export type IntegerWidthContract = Expect<Equal<IntegerWidth, 1 | 8 | 16 | 32 | 64>>;
export type UnionAtMostContract = Expect<Equal<WidthsAtMost<16 | 32>, 1 | 8 | 16>>;
export type UnionAtLeastContract = Expect<Equal<WidthsAtLeast<16 | 32>, 32 | 64>>;
