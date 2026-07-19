declare const valueBrand: unique symbol;

export type ValueId = number & { readonly [valueBrand]: "compiler-value" };
export type ExternalValueId = number;
export type ValueType = "i32" | "i64";
export type IntegerWidth = 8 | 16 | 32;

// What is provably known about an i32 value: the smallest width it fits
// unsigned and the smallest width it equals its own sign-extension from.
export type WidthBounds = Readonly<{ unsignedBits: number; signedBits: number }>;

export type ValueInput = Readonly<{ value: ValueId; type: ValueType }>;
