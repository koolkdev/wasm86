import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { IfControl } from "#compiler/ir/controls/index.js";
import { pageFault } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import { buildExit } from "#cpu/exit.js";
import {
  compileTestFunction,
  testFunction,
  type TestFunction
} from "./harness.js";

test("if branch hints come only from the explicit IR hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [0]);
});

function branchHintsForCheckIf(hint: IfControl["hint"]): readonly number[] {
  const fixture = testFunction(0, (fn) => {
    const values = fn.values;
    const address = values.const(0x2000);
    const condition = values.const(1);
    const pageFaultResult = buildExit(
      values,
      exceptionExit(pageFault(address, values.const(0)))
    );

    fn.region.if(
      condition,
      (arm) => arm.return([pageFaultResult]),
      hint === undefined ? {} : { hint }
    );
    fn.return([values.const64(0n)]);
  });

  return testFunctionBranchHints(fixture);
}

function testFunctionBranchHints(fixture: TestFunction): readonly number[] {
  const compiled = compileTestFunction(fixture);
  const module = new WebAssembly.Module(compiled.bytes);
  const sections = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint"
  );

  if (sections.length === 0) {
    return [];
  }
  strictEqual(sections.length, 1);
  const section = new Uint8Array(sections[0]!);
  let cursor = readU32(section, 0);
  const functionCount = cursor.value;
  const values: number[] = [];

  for (let functionEntry = 0; functionEntry < functionCount; functionEntry += 1) {
    const functionIndex = readU32(section, cursor.nextOffset);
    const hintCount = readU32(section, functionIndex.nextOffset);

    cursor = hintCount;
    for (let hintIndex = 0; hintIndex < hintCount.value; hintIndex += 1) {
      const offset = readU32(section, cursor.nextOffset);
      const metadataCount = readU32(section, offset.nextOffset);

      strictEqual(metadataCount.value, 1);
      const value = readU32(section, metadataCount.nextOffset);

      if (functionIndex.value === 0) {
        values.push(value.value);
      }
      cursor = value;
    }
  }
  return values;
}

type U32Read = Readonly<{ value: number; nextOffset: number }>;

function readU32(bytes: Uint8Array, start: number): U32Read {
  let value = 0;
  let shift = 0;

  for (let offset = start; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];

    if (byte === undefined) {
      break;
    }
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: offset + 1 };
    }
    shift += 7;
    if (shift >= 35) {
      throw new Error("u32 LEB128 is too wide");
    }
  }
  throw new Error("truncated u32 LEB128");
}
