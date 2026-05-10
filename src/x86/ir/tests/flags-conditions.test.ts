import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { irVar } from "#x86/ir/build/builder.js";
import { CONDITIONS } from "#x86/ir/model/conditions.js";
import {
  canUseFlagProducerCondition,
  flagProducerConditionInputNames,
  flagProducerConditionKind
} from "#x86/ir/model/flag-conditions.js";
import {
  conditionFlagReadMask,
  flagProducerEffect,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS,
  maskIrAluFlags
} from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS, leaf } from "#x86/ir/model/flags.js";
import type { ConditionCode, FlagProducerName, IrFlagSetOp } from "#x86/ir/model/types.js";

const left = irVar(0);
const right = irVar(1);
const result = irVar(2);
const leftExpr = leaf(left);
const rightExpr = leaf(right);
const resultExpr = leaf(result);
const oneExpr = { kind: "const", type: "i32", value: 1 } as const;
const sign32Expr = { kind: "const", type: "i32", value: 0x8000_0000 } as const;

test("add producer defines aluFlags symbolically", () => {
  deepStrictEqual(FLAG_PRODUCERS.add.inputs, ["left", "right", "result"]);
  deepStrictEqual(FLAG_PRODUCERS.add.writtenMask, IR_ALU_FLAG_MASK);
  deepStrictEqual(FLAG_PRODUCERS.add.undefMask, 0);
  deepStrictEqual(FLAG_PRODUCERS.add.define({ left, right, result }), {
    ZF: { kind: "eqz", value: resultExpr },
    SF: { kind: "signBit", value: resultExpr, width: 32 },
    PF: { kind: "parity8", value: resultExpr },
    CF: { kind: "uLt", a: resultExpr, b: leftExpr },
    AF: {
      kind: "bit",
      value: {
        kind: "xor",
        a: { kind: "xor", a: leftExpr, b: rightExpr },
        b: resultExpr
      },
      bit: 4
    },
    OF: {
      kind: "ne0",
      value: {
        kind: "and",
        a: {
          kind: "and",
          a: { kind: "xor", a: leftExpr, b: resultExpr },
          b: { kind: "xor", a: rightExpr, b: resultExpr }
        },
        b: sign32Expr
      }
    }
  });
});

test("sub producer defines borrow and overflow symbolically", () => {
  deepStrictEqual(FLAG_PRODUCERS.sub.inputs, ["left", "right", "result"]);
  deepStrictEqual(FLAG_PRODUCERS.sub.define({ left, right, result }).CF, {
    kind: "uLt",
    a: leftExpr,
    b: rightExpr
  });
  deepStrictEqual(FLAG_PRODUCERS.sub.define({ left, right, result }).OF, {
    kind: "ne0",
    value: {
      kind: "and",
      a: {
        kind: "and",
        a: { kind: "xor", a: leftExpr, b: rightExpr },
        b: { kind: "xor", a: leftExpr, b: resultExpr }
      },
      b: sign32Expr
    }
  });
});

test("logic producer defines logical flags and keeps AF undefined", () => {
  deepStrictEqual(FLAG_PRODUCERS.logic.inputs, ["result"]);
  deepStrictEqual(FLAG_PRODUCERS.logic.writtenMask, IR_ALU_FLAG_MASK);
  deepStrictEqual(FLAG_PRODUCERS.logic.undefMask, IR_ALU_FLAG_MASKS.AF);
  deepStrictEqual(FLAG_PRODUCERS.logic.define({ result }), {
    ZF: { kind: "eqz", value: resultExpr },
    SF: { kind: "signBit", value: resultExpr, width: 32 },
    PF: { kind: "parity8", value: resultExpr },
    CF: { kind: "constFlag", value: 0 },
    OF: { kind: "constFlag", value: 0 },
    AF: { kind: "undefFlag" }
  });
});

test("inc and dec producers write all arithmetic flags except CF", () => {
  const writtenMask = maskIrAluFlags(["PF", "AF", "ZF", "SF", "OF"]);

  deepStrictEqual(FLAG_PRODUCERS.inc.inputs, ["left", "result"]);
  deepStrictEqual(FLAG_PRODUCERS.inc.writtenMask, writtenMask);
  deepStrictEqual(FLAG_PRODUCERS.inc.undefMask, 0);
  deepStrictEqual(FLAG_PRODUCERS.inc.define({ left, result }).CF, undefined);
  deepStrictEqual(FLAG_PRODUCERS.inc.define({ left, result }).OF, {
    kind: "ne0",
    value: {
      kind: "and",
      a: {
        kind: "and",
        a: { kind: "xor", a: leftExpr, b: resultExpr },
        b: { kind: "xor", a: oneExpr, b: resultExpr }
      },
      b: sign32Expr
    }
  });

  deepStrictEqual(FLAG_PRODUCERS.dec.inputs, ["left", "result"]);
  deepStrictEqual(FLAG_PRODUCERS.dec.writtenMask, writtenMask);
  deepStrictEqual(FLAG_PRODUCERS.dec.undefMask, 0);
  deepStrictEqual(FLAG_PRODUCERS.dec.define({ left, result }).CF, undefined);
  deepStrictEqual(FLAG_PRODUCERS.dec.define({ left, result }).OF, {
    kind: "ne0",
    value: {
      kind: "and",
      a: {
        kind: "and",
        a: { kind: "xor", a: leftExpr, b: oneExpr },
        b: { kind: "xor", a: leftExpr, b: resultExpr }
      },
      b: sign32Expr
    }
  });
});

test("condition registry records flag reads and boolean formulas", () => {
  deepStrictEqual(CONDITIONS.NE, {
    reads: ["ZF"],
    expr: { kind: "not", value: { kind: "flag", flag: "ZF" } }
  });
  deepStrictEqual(CONDITIONS.LE, {
    reads: ["ZF", "SF", "OF"],
    expr: {
      kind: "or",
      a: { kind: "flag", flag: "ZF" },
      b: {
        kind: "xor",
        a: { kind: "flag", flag: "SF" },
        b: { kind: "flag", flag: "OF" }
      }
    }
  });
});

test("flag effect helpers expose condition reads and producer effects", () => {
  strictEqual(conditionFlagReadMask("E"), IR_ALU_FLAG_MASKS.ZF);
  strictEqual(conditionFlagReadMask("BE"), maskIrAluFlags(["CF", "ZF"]));
  strictEqual(conditionFlagReadMask("G"), maskIrAluFlags(["ZF", "SF", "OF"]));
  deepStrictEqual(flagProducerEffect("add"), {
    reads: 0,
    writes: IR_ALU_FLAG_MASK,
    undefines: 0
  });
  deepStrictEqual(flagProducerEffect("logic"), {
    reads: 0,
    writes: IR_ALU_FLAG_MASK,
    undefines: IR_ALU_FLAG_MASKS.AF
  });
  deepStrictEqual(flagProducerEffect("inc"), {
    reads: 0,
    writes: IR_ALU_FLAG_MASK & ~IR_ALU_FLAG_MASKS.CF,
    undefines: 0
  });
});

test("sub flag producers support direct comparison condition emission", () => {
  const cases: readonly [ConditionCode, NonNullable<ReturnType<typeof flagProducerConditionKind>>][] = [
    ["E", "eq"],
    ["NE", "ne"],
    ["B", "uLt"],
    ["AE", "uGe"],
    ["L", "sLt"],
    ["GE", "sGe"],
    ["LE", "sLe"],
    ["G", "sGt"]
  ];

  deepStrictEqual(
    cases.map(([cc]) => flagProducerConditionKind({ producer: "sub", cc })),
    cases.map(([, kind]) => kind)
  );
  deepStrictEqual(canUseFlagProducerCondition(createDescriptor("sub"), "E"), true);
  deepStrictEqual(flagProducerConditionKind({ producer: "sub", cc: "P" }), "parity8");
  deepStrictEqual(flagProducerConditionKind({ producer: "sub", width: 8, cc: "L" }), "sLt");
});

test("result flag producers support direct result condition emission", () => {
  const cases: readonly [ConditionCode, NonNullable<ReturnType<typeof flagProducerConditionKind>>][] = [
    ["E", "zero"],
    ["NE", "nonZero"],
    ["S", "sign"],
    ["NS", "notSign"],
    ["P", "parity8"],
    ["NP", "notParity8"]
  ];

  for (const producer of ["add", "logic", "inc", "dec"] as const) {
    deepStrictEqual(
      cases.map(([cc]) => flagProducerConditionKind({ producer, cc })),
      cases.map(([, kind]) => kind)
    );
    deepStrictEqual(canUseFlagProducerCondition(createDescriptor(producer), "E"), true);
  }

  deepStrictEqual(
    cases.map(([cc]) => flagProducerConditionKind({ producer: "sub", cc, inputs: { result } })),
    cases.map(([, kind]) => kind)
  );
  deepStrictEqual(flagProducerConditionKind({ producer: "sub", cc: "E" }), "eq");
  deepStrictEqual(flagProducerConditionKind({ producer: "sub", cc: "E", inputs: { result } }), "zero");
  deepStrictEqual(flagProducerConditionKind({ producer: "add", width: 16, cc: "S" }), "sign");
  deepStrictEqual(canUseFlagProducerCondition(createDescriptor("inc"), "B"), false);
});

test("logic producer folds conditions that depend on cleared carry and overflow", () => {
  const cases: readonly [ConditionCode, NonNullable<ReturnType<typeof flagProducerConditionKind>>][] = [
    ["O", "constFalse"],
    ["B", "constFalse"],
    ["NO", "constTrue"],
    ["AE", "constTrue"],
    ["BE", "zero"],
    ["A", "nonZero"],
    ["L", "sign"],
    ["GE", "notSign"],
    ["LE", "zeroOrSign"],
    ["G", "nonZeroAndNotSign"]
  ];

  deepStrictEqual(
    cases.map(([cc]) => flagProducerConditionKind({ producer: "logic", cc })),
    cases.map(([, kind]) => kind)
  );
  deepStrictEqual(flagProducerConditionInputNames({ producer: "logic", cc: "B" }), []);
  deepStrictEqual(flagProducerConditionInputNames({ producer: "logic", cc: "LE" }), ["result"]);
  deepStrictEqual(canUseFlagProducerCondition(createDescriptor("logic"), "B"), true);
});

function createDescriptor(producer: FlagProducerName): Pick<IrFlagSetOp, "producer" | "writtenMask" | "undefMask" | "inputs"> {
  return {
    producer,
    writtenMask: FLAG_PRODUCERS[producer].writtenMask,
    undefMask: FLAG_PRODUCERS[producer].undefMask,
    inputs: {}
  };
}
