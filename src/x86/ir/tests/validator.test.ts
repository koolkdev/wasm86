import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { aluSemantic } from "#x86/isa/semantics/alu.js";
import { jccSemantic } from "#x86/isa/semantics/control.js";
import { cmpSemantic } from "#x86/isa/semantics/cmp.js";
import { leaSemantic } from "#x86/isa/semantics/lea.js";
import { intSemantic } from "#x86/isa/semantics/misc.js";
import { cmovSemantic, movSemantic } from "#x86/isa/semantics/mov.js";
import { buildIr, const32, operand, irVar } from "#x86/ir/build/builder.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { validateIrBlock } from "#x86/ir/passes/validator.js";

const regOperands = (count: number) => ({
  operandInfo: Array.from({ length: count }, () => ({ storage: "reg" as const }))
});

test("validator accepts representative generated semantic templates", () => {
  doesNotThrow(() => validateIrBlock(buildIr(movSemantic(), regOperands(2)), { operandCount: 2 }));
  doesNotThrow(() => validateIrBlock(buildIr(cmovSemantic("E"), regOperands(2)), { operandCount: 2 }));
  doesNotThrow(() => validateIrBlock(buildIr(leaSemantic()), { operandCount: 2 }));
  doesNotThrow(() => validateIrBlock(buildIr(aluSemantic("add", 32), regOperands(2)), { operandCount: 2 }));
  doesNotThrow(() => validateIrBlock(buildIr(cmpSemantic(), regOperands(2)), { operandCount: 2 }));
  doesNotThrow(() => validateIrBlock(buildIr(jccSemantic("NE")), { operandCount: 1 }));
  doesNotThrow(() => validateIrBlock(buildIr(intSemantic()), { operandCount: 1 }));
});

test("validator rejects missing terminator and ops after terminator", () => {
  throws(() => validateIrBlock([{ op: "get", dst: irVar(0), source: operand(0) }]), /exactly one terminator/);

  throws(
    () =>
      validateIrBlock([
        { op: "next" },
        { op: "jump", target: const32(0) }
      ]),
    /after terminator/
  );
});

test("validator rejects duplicate vars, use before definition, and missing operands", () => {
  throws(
    () =>
      validateIrBlock([
        { op: "get", dst: irVar(0), source: operand(0) },
        { op: "value.binary", type: "i32", operator: "add", dst: irVar(0), a: irVar(0), b: const32(1) },
        { op: "next" }
      ]),
    /assigned more than once/
  );

  throws(
    () =>
      validateIrBlock([
        { op: "value.binary", type: "i32", operator: "add", dst: irVar(0), a: irVar(1), b: const32(1) },
        { op: "next" }
      ]),
    /used before definition/
  );

  throws(
    () => validateIrBlock([{ op: "get", dst: irVar(0), source: operand(1) }, { op: "next" }], { operandCount: 1 }),
    /operand 1 does not exist/
  );
});

test("validator rejects signed get without byte or word access width", () => {
  throws(
    () => validateIrBlock([{ op: "get", dst: irVar(0), source: operand(0), signed: true }, { op: "next" }]),
    /signed get requires access width 8 or 16/
  );

  throws(
    () => validateIrBlock([
      { op: "get", dst: irVar(0), source: operand(0), accessWidth: 32, signed: true },
      { op: "next" }
    ]),
    /signed get requires access width 8 or 16/
  );
});

test("validator accepts memory guards with positive byte lengths", () => {
  doesNotThrow(() =>
    validateIrBlock([
      { op: "value.const", type: "i32", dst: irVar(0), value: 0x1000 },
      { op: "memory.guard", address: irVar(0), byteLength: 4, access: "read" },
      { op: "next" }
    ])
  );
});

test("validator rejects memory guards with malformed byte lengths", () => {
  throws(
    () =>
      validateIrBlock([
        { op: "memory.guard", address: const32(0x1000), byteLength: 0, access: "read" },
        { op: "next" }
      ]),
    /memory\.guard byte length must be a positive integer/
  );

  throws(
    () =>
      validateIrBlock([
        { op: "memory.guard", address: const32(0x1000), byteLength: 1.5, access: "write" },
        { op: "next" }
      ]),
    /memory\.guard byte length must be a positive integer/
  );
});

test("validator rejects memory guards with malformed access", () => {
  throws(
    () =>
      validateIrBlock([
        // @ts-expect-error Intentionally malformed runtime IR for validator coverage.
        { op: "memory.guard", address: const32(0x1000), byteLength: 4, access: "execute" },
        { op: "next" }
      ]),
    /memory\.guard access must be "read" or "write"/
  );
});

test("validator rejects malformed flag producer inputs", () => {
  throws(
    () =>
      validateIrBlock([
        { op: "value.const", type: "i32", dst: irVar(0), value: 1 },
        createIrFlagSetOp("logic", {}),
        { op: "next" }
      ]),
    /logic flag producer is missing input 'result'/
  );

  throws(
    () =>
      validateIrBlock([
        { op: "value.const", type: "i32", dst: irVar(0), value: 1 },
        createIrFlagSetOp("logic", { result: irVar(0), extra: irVar(0) }),
        { op: "next" }
      ]),
    /logic flag producer has unexpected input 'extra'/
  );
});

test("validator rejects flag descriptors that disagree with producer metadata", () => {
  throws(
    () =>
      validateIrBlock([
        { op: "value.const", type: "i32", dst: irVar(0), value: 1 },
        { ...createIrFlagSetOp("logic", { result: irVar(0) }), writtenMask: 1 },
        { op: "next" }
      ]),
    /flags\.set logic writtenMask does not match producer metadata/
  );

  throws(
    () =>
      validateIrBlock([
        { op: "value.const", type: "i32", dst: irVar(0), value: 1 },
        { ...createIrFlagSetOp("add", { left: irVar(0), right: const32(1), result: irVar(0) }), undefMask: 1 },
        { op: "next" }
      ]),
    /flags\.set add undefMask does not match producer metadata/
  );
});
