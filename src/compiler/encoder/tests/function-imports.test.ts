import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import {
  wasmCodeFunctionCount,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import { encodeTestModule } from "#compiler/encoder/tests/module-description.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importModuleName = "host";
const importFunctionName = "increment";

test("function imports prefix defined indexes and direct calls", async () => {
  const bytes = encodeTestModule({
    functionTypes: [{
      params: [wasmValueType.i32],
      results: [wasmValueType.i32]
    }],
    functionImports: [{
      moduleName: importModuleName,
      name: importFunctionName,
      typeIndex: 0
    }],
    functions: [
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder(1)
          .localGet(0)
          .callFunction(0)
          .i32Const(1)
          .i32Add()
          .finish()
      },
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder(1)
          .localGet(0)
          .returnCallFunction(0)
          .finish()
      }
    ],
    functionExports: [
      { name: "ordinary", functionIndex: 1 },
      { name: "returned", functionIndex: 2 }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);

  deepStrictEqual(WebAssembly.Module.imports(compiled), [{
    module: importModuleName,
    name: importFunctionName,
    kind: "function"
  }]);

  const instance = await WebAssembly.instantiate(compiled, {
    [importModuleName]: {
      [importFunctionName]: (value: number): number => value + 1
    }
  });
  const ordinary = exportedFunction(instance, "ordinary");
  const returned = exportedFunction(instance, "returned");

  strictEqual(ordinary(41), 43);
  strictEqual(returned(41), 42);
});

test("function and code sections contain definitions only", () => {
  const bytes = encodeTestModule({
    functionTypes: [{ params: [], results: [] }],
    functionImports: [{
      moduleName: importModuleName,
      name: importFunctionName,
      typeIndex: 0
    }],
    functions: [
      { typeIndex: 0, body: new WasmFunctionBodyEncoder().finish() },
      { typeIndex: 0, body: new WasmFunctionBodyEncoder().finish() }
    ]
  });

  strictEqual(wasmDefinedFunctionCount(bytes), 2);
  strictEqual(wasmCodeFunctionCount(bytes), 2);
  new WebAssembly.Module(bytes);
});

test("branch hints use imported-function-prefixed indexes", () => {
  const bytes = encodeTestModule({
    functionTypes: [{ params: [], results: [] }],
    functionImports: [{
      moduleName: importModuleName,
      name: importFunctionName,
      typeIndex: 0
    }],
    functions: [
      { typeIndex: 0, body: new WasmFunctionBodyEncoder().finish() },
      {
        typeIndex: 0,
        body: new WasmFunctionBodyEncoder()
          .i32Const(1)
          .ifBlock({ hint: "likely" })
          .endBlock()
          .finish()
      }
    ]
  });
  const compiled = new WebAssembly.Module(bytes);

  deepStrictEqual(branchHintFunctionIndices(compiled), [2]);
});

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string
): (...args: number[]) => unknown {
  const value = instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }
  return value as (...args: number[]) => unknown;
}

function branchHintFunctionIndices(module: WebAssembly.Module): readonly number[] {
  const sections = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint"
  );

  if (sections.length !== 1) {
    throw new Error(`expected one branch-hint section, got ${sections.length}`);
  }
  const section = sections[0];

  if (section === undefined) {
    throw new Error("missing branch-hint section");
  }
  const bytes = new Uint8Array(section);
  const entryCount = readU32Leb128(bytes, 0);
  const indices: number[] = [];
  let offset = entryCount.nextOffset;

  for (let entry = 0; entry < entryCount.value; entry += 1) {
    const functionIndex = readU32Leb128(bytes, offset);
    const hintCount = readU32Leb128(bytes, functionIndex.nextOffset);

    indices.push(functionIndex.value);
    offset = hintCount.nextOffset;

    for (let hint = 0; hint < hintCount.value; hint += 1) {
      const instructionOffset = readU32Leb128(bytes, offset);
      const attributeCount = readU32Leb128(bytes, instructionOffset.nextOffset);

      offset = attributeCount.nextOffset;
      for (let attribute = 0; attribute < attributeCount.value; attribute += 1) {
        offset = readU32Leb128(bytes, offset).nextOffset;
      }
    }
  }

  if (offset !== bytes.length) {
    throw new Error("unexpected trailing branch-hint section data");
  }
  return indices;
}

function readU32Leb128(
  bytes: Uint8Array<ArrayBufferLike>,
  offset: number
): Readonly<{ value: number; nextOffset: number }> {
  let value = 0;
  let shift = 0;

  while (true) {
    const byte = bytes[offset];

    if (byte === undefined) {
      throw new Error("unexpected end of branch-hint section");
    }
    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: offset };
    }
    shift += 7;
  }
}
