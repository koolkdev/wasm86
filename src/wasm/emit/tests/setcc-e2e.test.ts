import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, regBinding } from "#ir/operands.js";
import { gprChannel } from "#ir/slots.js";
import { CONDITIONS, type FlagBoolExpr } from "#core/conditions.js";
import type { X86StatusFlag } from "#core/flags.js";
import type { ConditionCode } from "#core/conditions.js";

import { cmpSemantic } from "#x86/semantics/cmp.js";
import { setccSemantic } from "#x86/semantics/setcc.js";
import { readWasmCpuStateChannel, writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { isStateRead } from "#ir/tests/storage-op-helpers.js";

// cmp + setcc consumes source-derived cmp conditions, and standalone setcc
// rebuilds the condition through lazy flag helper calls.

const comparePredicates: ReadonlyArray<
  readonly [ConditionCode, (left: number, right: number) => boolean]
> = [
  ["E", (a, b) => (a >>> 0) === (b >>> 0)],
  ["NE", (a, b) => (a >>> 0) !== (b >>> 0)],
  ["B", (a, b) => (a >>> 0) < (b >>> 0)],
  ["AE", (a, b) => (a >>> 0) >= (b >>> 0)],
  ["BE", (a, b) => (a >>> 0) <= (b >>> 0)],
  ["A", (a, b) => (a >>> 0) > (b >>> 0)],
  ["L", (a, b) => (a | 0) < (b | 0)],
  ["GE", (a, b) => (a | 0) >= (b | 0)],
  ["LE", (a, b) => (a | 0) <= (b | 0)],
  ["G", (a, b) => (a | 0) > (b | 0)]
];

const operandPairs: ReadonlyArray<readonly [number, number]> = [
  [5, 5],
  [3, 5],
  [5, 3],
  [0x8000_0000, 1],
  [1, 0x8000_0000],
  [0xffff_ffff, 1],
  [0x7fff_ffff, 0xffff_ffff]
];

for (const [cc, predicate] of comparePredicates) {
  test(`cmp ebx, imm + set${cc.toLowerCase()} al matches the predicate`, async () => {
    for (const [left, right] of operandPairs) {
      const builder = createIrBlockBuilder();

      builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(right)], loc(0x1000, 0x1006));
      builder.addInstruction(setccSemantic(cc), [regBinding("al")], loc(0x1006, 0x1009));

      const block = builder.finish();

      // Source-derived cmp conditions serve setcc: no flag byte is read back.
      strictEqual(
        block.body.actions.some(
          (action) => isStateRead(action) && action.op.slot.kind === "flag"
        ),
        false
      );

      const { stateView, run } = await instantiateIrBlock(block);
      const label = `set${cc.toLowerCase()} with ${left}, ${right}`;

      writeWasmCpuStateSnapshot(stateView, { ebx: left, eax: 0xdeadbeaa });
      strictEqual(run(), irBlockCompleted, label);

      // setcc writes the low byte only; the rest of eax is untouched.
      const expected = 0xdeadbe00 + (predicate(left, right) ? 1 : 0);

      strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), expected, label);
    }
  });
}

function evaluateCondition(expr: FlagBoolExpr, flags: ReadonlySet<X86StatusFlag>): boolean {
  switch (expr.kind) {
    case "flag":
      return flags.has(expr.flag);
    case "not":
      return !evaluateCondition(expr.value, flags);
    case "and":
      return evaluateCondition(expr.a, flags) && evaluateCondition(expr.b, flags);
    case "or":
      return evaluateCondition(expr.a, flags) || evaluateCondition(expr.b, flags);
    case "xor":
      return evaluateCondition(expr.a, flags) !== evaluateCondition(expr.b, flags);
  }
}

for (const cc of Object.keys(CONDITIONS) as ConditionCode[]) {
  test(`standalone set${cc.toLowerCase()} al evaluates every flag combination`, async () => {
    const condition = CONDITIONS[cc];
    const builder = createIrBlockBuilder();

    builder.addInstruction(setccSemantic(cc), [regBinding("al")], loc(0x1000, 0x1003));

    const { stateView, run } = await instantiateIrBlock(builder.finish());

    for (let combo = 0; combo < 1 << condition.reads.length; combo += 1) {
      const flags = new Set(condition.reads.filter((_, index) => (combo >> index) & 1));
      const flagFields = Object.fromEntries([...flags].map((flag) => [flag, 1]));
      const label = `set${cc.toLowerCase()} with ${[...flags].join("+") || "no flags"}`;

      writeWasmCpuStateSnapshot(stateView, { eax: 0x55aa55aa, ...flagFields });
      strictEqual(run(), irBlockCompleted, label);

      const expected = 0x55aa5500 + (evaluateCondition(condition.expr, flags) ? 1 : 0);

      strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), expected, label);
    }
  });
}
