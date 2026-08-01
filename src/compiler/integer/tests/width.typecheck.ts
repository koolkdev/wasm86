import type {
  IntegerWidth,
  StorageValueWidth,
  StorageWidth,
  WidthsAtLeast,
  WidthsAtMost
} from "#compiler/integer/width.js";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Type extends true> = Type;

export type StorageWidthContract = Expect<Equal<StorageWidth, 8 | 16 | 32 | 64>>;
export type IntegerWidthContract = Expect<Equal<IntegerWidth, 1 | 8 | 16 | 32 | 64>>;
export type ByteStorageValueContract = Expect<Equal<StorageValueWidth<8>, 1 | 8>>;
export type WordStorageValueContract = Expect<Equal<StorageValueWidth<16>, 1 | 8 | 16>>;
export type DwordStorageValueContract = Expect<Equal<StorageValueWidth<32>, 1 | 8 | 16 | 32>>;
export type QwordStorageValueContract = Expect<Equal<StorageValueWidth<64>, IntegerWidth>>;
export type UnionStorageValueContract = Expect<Equal<StorageValueWidth<8 | 16>, 1 | 8>>;
export type UnionAtMostContract = Expect<Equal<WidthsAtMost<16 | 32>, 1 | 8 | 16>>;
export type UnionAtLeastContract = Expect<Equal<WidthsAtLeast<16 | 32>, 32 | 64>>;
