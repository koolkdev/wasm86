export type FloatWidth = 32 | 64;

export type FloatBits<Width extends FloatWidth> = Width extends 32 ? number : bigint;

export type FloatBinaryOperator = "add" | "sub" | "mul" | "div";

export type FloatCompareOperator = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
