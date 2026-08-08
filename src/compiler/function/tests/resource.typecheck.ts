import type { StorageWidth, ValueWidthForStorage } from "#compiler/function/resource.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Type extends true> = Type;

export type StorageWidthContract = Expect<Equal<StorageWidth, 8 | 16 | 32 | 64>>;
export type ByteValueWidthContract = Expect<Equal<ValueWidthForStorage<8>, 1 | 8>>;
export type WordValueWidthContract = Expect<Equal<ValueWidthForStorage<16>, 1 | 8 | 16>>;
export type DwordValueWidthContract = Expect<Equal<ValueWidthForStorage<32>, 1 | 8 | 16 | 32>>;
export type QwordValueWidthContract = Expect<Equal<ValueWidthForStorage<64>, IntegerWidth>>;
export type UnionValueWidthContract = Expect<Equal<ValueWidthForStorage<8 | 16>, 1 | 8 | 16>>;
