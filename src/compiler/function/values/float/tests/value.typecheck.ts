import {
  f32,
  f64,
  i32,
  select,
  type BitValue,
  type Float,
  type ValueRef
} from "#compiler/function/values.js";

export function floatValueContract(condition: BitValue): void {
  const single = f32(1);
  const double = f64(1);
  const sum: Float<32> = single.add(2);
  const difference: Float<32> = single.sub(2);
  const product: Float<64> = double.mul(2);
  const quotient: Float<64> = double.div(2);
  const equal: BitValue = single.eq(2);
  const unequal: BitValue = single.ne(2);
  const less: BitValue = single.lt(2);
  const atMost: BitValue = single.le(2);
  const greater: BitValue = single.gt(2);
  const atLeast: BitValue = single.ge(2);
  const selected: Float<32> = select(condition, single, f32(2));
  const valueRef: ValueRef = single;

  // @ts-expect-error float arithmetic requires matching widths.
  single.add(double);
  // @ts-expect-error float comparison requires matching widths.
  single.eq(double);
  // @ts-expect-error integer values are not float operands.
  single.add(i32(2));
  // @ts-expect-error select alternatives must have one float width.
  select(condition, single, double);
  // @ts-expect-error select alternatives must belong to one value family.
  select(condition, single, i32(2));
  // @ts-expect-error semantic values cannot be forged from their public fields.
  const forged: ValueRef = { kind: "float", width: 32 };

  void [
    sum,
    difference,
    product,
    quotient,
    equal,
    unequal,
    less,
    atMost,
    greater,
    atLeast,
    selected,
    valueRef,
    forged
  ];
}
