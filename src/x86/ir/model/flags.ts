import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";
import type { X86ArithmeticFlag } from "#x86/isa/flags.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { FlagProducerName, IrConstValueRef, IrFlagSetOp, ValueRef } from "./types.js";

export type FlagName = X86ArithmeticFlag;

export type ValueExpr<T = ValueRef> =
  | Readonly<{ kind: "leaf"; value: T }>
  | IrConstValueRef
  | Readonly<{ kind: "and"; a: ValueExpr<T>; b: ValueExpr<T> }>
  | Readonly<{ kind: "xor"; a: ValueExpr<T>; b: ValueExpr<T> }>;

export type FlagExpr<T = ValueRef> =
  | Readonly<{ kind: "constFlag"; value: 0 | 1 }>
  | Readonly<{ kind: "undefFlag" }>
  | Readonly<{ kind: "eqz"; value: ValueExpr<T> }>
  | Readonly<{ kind: "ne0"; value: ValueExpr<T> }>
  | Readonly<{ kind: "uLt"; a: ValueExpr<T>; b: ValueExpr<T> }>
  | Readonly<{ kind: "bit"; value: ValueExpr<T>; bit: number }>
  | Readonly<{ kind: "parity8"; value: ValueExpr<T> }>
  | Readonly<{ kind: "signBit"; value: ValueExpr<T>; width: 8 | 16 | 32 }>;

export type FlagDefs<T = ValueRef> = Readonly<Partial<Record<FlagName, FlagExpr<T>>>>;

export const FLAG_PRODUCER_INPUTS = {
  add: ["left", "right", "result"],
  sub: ["left", "right", "result"],
  logic: ["result"],
  inc: ["left", "result"],
  dec: ["left", "result"]
} as const satisfies Readonly<Record<FlagProducerName, readonly string[]>>;

type FlagProducerInputSchema = typeof FLAG_PRODUCER_INPUTS;

export type FlagProducerInputNames<Producer extends FlagProducerName = FlagProducerName> =
  FlagProducerInputSchema[Producer];

export type FlagProducerInputs<
  T,
  Producer extends FlagProducerName = FlagProducerName
> = Producer extends FlagProducerName
  ? Readonly<{ [Name in FlagProducerInputName<Producer>]: T }>
  : never;

export type FlagProducerInputName<Producer extends FlagProducerName = FlagProducerName> =
  FlagProducerInputNames<Producer>[number];

export type FlagProducer<Producer extends FlagProducerName> = Readonly<{
  inputs: FlagProducerInputNames<Producer>;
  // Masks are explicit metadata so analysis can reason about partial writers
  // without inspecting every symbolic expression. The define() result must
  // still provide expressions for every written bit.
  writtenMask: number;
  undefMask: number;
  define<T>(
    inputs: FlagProducerInputs<T, Producer>,
    width?: OperandWidth
  ): FlagDefs<T>;
}>;

export const leaf = <T>(value: T): ValueExpr<T> => ({ kind: "leaf", value });
export const constFlag = <T = ValueRef>(value: 0 | 1): FlagExpr<T> => ({ kind: "constFlag", value });
export const undefFlag = <T = ValueRef>(): FlagExpr<T> => ({ kind: "undefFlag" });
export const eqz = <T>(value: ValueExpr<T>): FlagExpr<T> => ({ kind: "eqz", value });
export const ne0 = <T>(value: ValueExpr<T>): FlagExpr<T> => ({ kind: "ne0", value });
export const uLt = <T>(a: ValueExpr<T>, b: ValueExpr<T>): FlagExpr<T> => ({ kind: "uLt", a, b });
export const bit = <T>(value: ValueExpr<T>, bitIndex: number): FlagExpr<T> => ({
  kind: "bit",
  value,
  bit: bitIndex
});
export const parity8 = <T>(value: ValueExpr<T>): FlagExpr<T> => ({ kind: "parity8", value });
export const signBit = <T>(value: ValueExpr<T>, width: 8 | 16 | 32): FlagExpr<T> => ({
  kind: "signBit",
  value,
  width
});

export const and = <T>(a: ValueExpr<T>, b: ValueExpr<T>): ValueExpr<T> => ({ kind: "and", a, b });
export const xor = <T>(a: ValueExpr<T>, b: ValueExpr<T>): ValueExpr<T> => ({ kind: "xor", a, b });
export const xor3 = <T>(a: ValueExpr<T>, b: ValueExpr<T>, c: ValueExpr<T>): ValueExpr<T> =>
  xor(xor(a, b), c);

export const signMask = <T>(width: 8 | 16 | 32): ValueExpr<T> => ({
  kind: "const",
  type: "i32",
  value: width === 32 ? 0x8000_0000 : width === 16 ? 0x8000 : 0x80
});

export const widthMask = <T>(width: 8 | 16 | 32): ValueExpr<T> => ({
  kind: "const",
  type: "i32",
  value: width === 32 ? 0xffff_ffff : width === 16 ? 0xffff : 0xff
});

export function truncateToWidth<T>(width: 8 | 16 | 32, value: ValueExpr<T>): ValueExpr<T> {
  return width === 32 ? value : and(value, widthMask(width));
}

export function zspFlags<T>(width: 8 | 16 | 32, result: ValueExpr<T>): FlagDefs<T> {
  return {
    ZF: eqz(result),
    SF: signBit(result, width),
    PF: parity8(result)
  };
}

export function addCarryFlags<T>(
  width: 8 | 16 | 32,
  left: ValueExpr<T>,
  right: ValueExpr<T>,
  result: ValueExpr<T>
): FlagDefs<T> {
  return {
    CF: uLt(result, left),
    AF: bit(xor3(left, right, result), 4),
    OF: ne0(and(and(xor(left, result), xor(right, result)), signMask(width)))
  };
}

export function subCarryFlags<T>(
  width: 8 | 16 | 32,
  left: ValueExpr<T>,
  right: ValueExpr<T>,
  result: ValueExpr<T>
): FlagDefs<T> {
  return {
    CF: uLt(left, right),
    AF: bit(xor3(left, right, result), 4),
    OF: ne0(and(and(xor(left, right), xor(left, result)), signMask(width)))
  };
}

export function logicFlags<T>(width: 8 | 16 | 32, result: ValueExpr<T>): FlagDefs<T> {
  return {
    ...zspFlags(width, result),
    CF: constFlag(0),
    OF: constFlag(0),
    AF: undefFlag()
  };
}

export function flagProducer<const Producer extends FlagProducerName>(
  producer: Producer,
  writtenFlags: readonly FlagName[],
  undefFlags: readonly FlagName[],
  define: <T>(
    inputs: FlagProducerInputs<ValueExpr<T>, Producer>,
    width: OperandWidth
  ) => FlagDefs<T>
): FlagProducer<Producer> {
  return {
    inputs: FLAG_PRODUCER_INPUTS[producer],
    writtenMask: maskFlags(writtenFlags),
    undefMask: maskFlags(undefFlags),
    define: (inputValues, width = 32) => define(flagProducerInputLeaves(producer, inputValues), width)
  };
}

const arithmeticFlagNames = ["CF", "PF", "AF", "ZF", "SF", "OF"] as const satisfies readonly FlagName[];
const incDecWrittenFlagNames = ["PF", "AF", "ZF", "SF", "OF"] as const satisfies readonly FlagName[];

export const FLAG_PRODUCERS = {
  add: flagProducer("add", arithmeticFlagNames, [], ({ left, right, result }, width) => {
    const truncatedResult = truncateToWidth(width, result);

    return {
      ...zspFlags(width, truncatedResult),
      ...addCarryFlags(width, left, right, truncatedResult)
    };
  }),

  sub: flagProducer("sub", arithmeticFlagNames, [], ({ left, right, result }, width) => {
    const truncatedResult = truncateToWidth(width, result);

    return {
      ...zspFlags(width, truncatedResult),
      ...subCarryFlags(width, left, right, truncatedResult)
    };
  }),

  logic: flagProducer("logic", arithmeticFlagNames, ["AF"], ({ result }, width) =>
    logicFlags(width, truncateToWidth(width, result))
  ),

  // INC/DEC intentionally omit CF from writtenMask. Consumers of CF after INC/DEC
  // must keep using the previous CF source.
  inc: flagProducer("inc", incDecWrittenFlagNames, [], ({ left, result }, width) => {
    const truncatedResult = truncateToWidth(width, result);
    const carry = addCarryFlags(width, left, i32Const(1), truncatedResult);

    return {
      ...zspFlags(width, truncatedResult),
      AF: requiredFlagExpr(carry, "AF", "inc"),
      OF: requiredFlagExpr(carry, "OF", "inc")
    };
  }),

  dec: flagProducer("dec", incDecWrittenFlagNames, [], ({ left, result }, width) => {
    const truncatedResult = truncateToWidth(width, result);
    const carry = subCarryFlags(width, left, i32Const(1), truncatedResult);

    return {
      ...zspFlags(width, truncatedResult),
      AF: requiredFlagExpr(carry, "AF", "dec"),
      OF: requiredFlagExpr(carry, "OF", "dec")
    };
  })
} as const satisfies { readonly [Producer in FlagProducerName]: FlagProducer<Producer> };

export function flagProducerInputNames<const Producer extends FlagProducerName>(
  producer: Producer
): FlagProducerInputNames<Producer> {
  return FLAG_PRODUCER_INPUTS[producer];
}

export function flagProducerInputsFromRecord<T, Producer extends FlagProducerName>(
  producer: Producer,
  inputs: Readonly<Record<string, T>>
): FlagProducerInputs<T, Producer> {
  const inputNames = flagProducerInputNames(producer);
  const inputNameSet = new Set<string>(inputNames);
  const typedInputs: Record<string, T> = {};
  const unexpected = Object.keys(inputs).find((name) => !inputNameSet.has(name));

  if (unexpected !== undefined) {
    throw new Error(`${producer} flag producer has unexpected input '${unexpected}'`);
  }

  for (const inputName of inputNames) {
    const input = inputs[inputName];

    if (input === undefined) {
      throw new Error(`${producer} flag producer is missing input '${inputName}'`);
    }

    typedInputs[inputName] = input;
  }

  return typedInputs as FlagProducerInputs<T, Producer>;
}

export function flagProducerInputsToRecord<T, Producer extends FlagProducerName>(
  producer: Producer,
  inputs: FlagProducerInputs<T, Producer>
): Readonly<Record<FlagProducerInputName<Producer>, T>> {
  void producer;
  return inputs as Readonly<Record<FlagProducerInputName<Producer>, T>>;
}

export function requiredFlagProducerInput<T>(
  producer: FlagProducerName,
  inputs: FlagProducerInputs<T>,
  name: string
): T {
  if (!new Set<string>(flagProducerInputNames(producer)).has(name)) {
    throw new Error(`${producer} flag producer has no '${name}' input`);
  }

  const input = (inputs as Readonly<Record<string, T>>)[name];

  if (input === undefined) {
    throw new Error(`${producer} flag producer is missing input '${name}'`);
  }

  return input;
}

export function createIrFlagSetOp(
  producer: FlagProducerName,
  inputs: Readonly<Record<string, ValueRef>>,
  width?: OperandWidth
): IrFlagSetOp {
  const flagProducer = FLAG_PRODUCERS[producer];
  const typedInputs = flagProducerInputsFromRecord(producer, inputs);
  const op = {
    op: "flags.set",
    producer,
    writtenMask: flagProducer.writtenMask,
    undefMask: flagProducer.undefMask,
    inputs: flagProducerInputsToRecord(producer, typedInputs)
  } as const satisfies IrFlagSetOp;

  return width === undefined || width === 32 ? op : { ...op, width };
}

type AnyFlagProducer = Readonly<{
  define<T>(
    inputs: FlagProducerInputs<T>,
    width?: OperandWidth
  ): FlagDefs<T>;
}>;

export function defineFlagProducer<T>(
  producer: FlagProducerName,
  inputs: FlagProducerInputs<T>,
  width?: OperandWidth
): FlagDefs<T> {
  return (FLAG_PRODUCERS[producer] as AnyFlagProducer).define(inputs, width);
}

function i32Const<T>(value: number): ValueExpr<T> {
  return { kind: "const", type: "i32", value };
}

function maskFlags(flags: readonly FlagName[]): number {
  return flags.reduce((mask, flag) => mask | x86ArithmeticFlagMask[flag], 0);
}

function requiredFlagExpr<T>(
  defs: FlagDefs<T>,
  flag: FlagName,
  producer: FlagProducerName
): FlagExpr<T> {
  const expr = defs[flag];

  if (expr === undefined) {
    throw new Error(`${producer} missing generated ${flag} expression`);
  }

  return expr;
}

function flagProducerInputLeaves<T, Producer extends FlagProducerName>(
  producer: Producer,
  inputs: FlagProducerInputs<T, Producer>
): FlagProducerInputs<ValueExpr<T>, Producer> {
  const inputRecord = flagProducerInputsFromRecord(producer, flagProducerInputsToRecord(producer, inputs));
  const leaves: Record<string, ValueExpr<T>> = {};

  for (const inputName of flagProducerInputNames(producer)) {
    leaves[inputName] = leaf(requiredFlagProducerInput(producer, inputRecord, inputName));
  }

  return flagProducerInputsFromRecord(producer, leaves);
}
