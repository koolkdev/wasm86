import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createInstructionBudget } from "#runtime/execution/budget.js";
import { RuntimeCodeMap } from "#runtime/program/code-map.js";
import { COMPILED_BLOCK_FIXTURES } from "#runtime/tests/fixtures/blocks.js";
import {
  assertEngineFixtureResult,
  createFixtureCompiledBlockCache,
  prepareEngineFixture
} from "#runtime/tests/fixtures/helpers.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { WasmBlocksEngine } from "#runtime/engines/wasm-blocks.js";

test("wasm blocks engine reports unavailable when no compiled block exists", () => {
  const engine = new WasmBlocksEngine({
    getOrCompile() {
      return undefined;
    }
  });
  const result = engine.run(
    { codeMap: new RuntimeCodeMap([]), memories: createWasmHostMemories() },
    createInstructionBudget(0, 10)
  );

  strictEqual(result.kind, "unavailable");
  if (result.kind === "unavailable") {
    strictEqual(result.reason, "no-compiled-block");
  }
});

for (const fixture of COMPILED_BLOCK_FIXTURES) {
  test(`wasm blocks engine runs ${fixture.name}`, () => {
    const { codeMap, memories } = prepareEngineFixture(fixture);
    const engine = new WasmBlocksEngine(createFixtureCompiledBlockCache());
    const result = engine.run({ codeMap, memories }, createInstructionBudget(0, 100));

    assertEngineFixtureResult(fixture, result, memories);
  });
}
