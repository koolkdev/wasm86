import type { OperandWidth } from "./types.js";

type AddFlagSource<TValue extends number = number> = Readonly<{
  kind: "add";
  width: OperandWidth;
  left: TValue;
  right: TValue;
  result: TValue;
}>;

type SubFlagSource<TValue extends number = number> = Readonly<{
  kind: "sub";
  width: OperandWidth;
  left: TValue;
  right: TValue;
  result: TValue;
}>;

type LogicFlagSource<TValue extends number = number> = Readonly<{
  kind: "logic";
  width: OperandWidth;
  result: TValue;
}>;

export type SimpleFlagSource<TValue extends number = number> =
  | AddFlagSource<TValue>
  | SubFlagSource<TValue>
  | LogicFlagSource<TValue>;
