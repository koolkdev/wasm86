import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { StorageWidth, StoredIntegerWidth } from "#compiler/function/resource.js";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Type extends true> = Type;

export type StorageWidthContract = Expect<Equal<StorageWidth, 8 | 16 | 32 | 64>>;
export type StoredByteContract = Expect<Equal<StoredIntegerWidth<8>, 1 | 8>>;
export type StoredWordContract = Expect<Equal<StoredIntegerWidth<16>, 1 | 8 | 16>>;
export type StoredDwordContract = Expect<Equal<StoredIntegerWidth<32>, 1 | 8 | 16 | 32>>;
export type StoredQwordContract = Expect<Equal<StoredIntegerWidth<64>, IntegerWidth>>;
export type UnionStoredIntegerContract = Expect<Equal<StoredIntegerWidth<8 | 16>, 1 | 8 | 16>>;
