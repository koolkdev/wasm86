import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  wasmBranchHint,
  WasmFunctionBodyEncoder
} from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import {
  wasmCodeFunctionCount,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import { wasmValueType } from "#compiler/encoder/types.js";

const importModuleName = "host";
const importFunctionName = "increment";

test("function imports prefix defined indexes and direct calls", async () => {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const importedIndex = module.importFunction(
    importModuleName,
    importFunctionName,
    typeIndex
  );
  const ordinaryIndex = module.addFunction(
    typeIndex,
    new WasmFunctionBodyEncoder(1)
      .localGet(0)
      .callFunction(importedIndex)
      .i32Const(1)
      .i32Add()
      .finish()
  );
  const returnedIndex = module.addFunction(
    typeIndex,
    new WasmFunctionBodyEncoder(1)
      .localGet(0)
      .returnCallFunction(importedIndex)
      .finish()
  );

  strictEqual(importedIndex, 0);
  strictEqual(ordinaryIndex, 1);
  strictEqual(returnedIndex, 2);

  module.exportFunction("ordinary", ordinaryIndex);
  module.exportFunction("returned", returnedIndex);

  const compiled = new WebAssembly.Module(module.encode());

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

test("function imports cannot be added after a definition", () => {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({ params: [], results: [] });
  const body = new WasmFunctionBodyEncoder().finish();

  strictEqual(module.addFunction(typeIndex, body), 0);
  throws(
    () => module.importFunction(importModuleName, importFunctionName, typeIndex + 1),
    /unknown Wasm function type index/
  );
  throws(
    () => module.importFunction(importModuleName, importFunctionName, typeIndex),
    /cannot import a Wasm function after adding a defined function/
  );
  strictEqual(module.addFunction(typeIndex, body), 1);
});

test("invalid function imports do not reserve an index", () => {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({ params: [], results: [] });

  throws(
    () => module.importFunction(importModuleName, "invalid", typeIndex + 1),
    /unknown Wasm function type index/
  );
  strictEqual(
    module.importFunction(importModuleName, importFunctionName, typeIndex),
    0
  );
});

test("function and code sections contain definitions only", () => {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({ params: [], results: [] });

  module.importFunction(importModuleName, importFunctionName, typeIndex);
  module.addFunction(typeIndex, new WasmFunctionBodyEncoder().finish());
  module.addFunction(typeIndex, new WasmFunctionBodyEncoder().finish());

  const bytes = module.encode();

  strictEqual(wasmDefinedFunctionCount(bytes), 2);
  strictEqual(wasmCodeFunctionCount(bytes), 2);
  new WebAssembly.Module(bytes);
});

test("branch hints use imported-function-prefixed indexes", () => {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({ params: [], results: [] });

  strictEqual(
    module.importFunction(importModuleName, importFunctionName, typeIndex),
    0
  );
  strictEqual(
    module.addFunction(typeIndex, new WasmFunctionBodyEncoder().finish()),
    1
  );
  const hintedIndex = module.addFunction(
    typeIndex,
    new WasmFunctionBodyEncoder()
      .i32Const(1)
      .ifBlock({ hint: wasmBranchHint.likely })
      .endBlock()
      .finish()
  );

  strictEqual(hintedIndex, 2);

  const compiled = new WebAssembly.Module(module.encode());

  deepStrictEqual(branchHintFunctionIndices(compiled), [hintedIndex]);
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
