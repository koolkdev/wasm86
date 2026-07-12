import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { BodyBuilder } from "#ir/body-builder.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { ValueTable } from "#ir/value-table.js";
import { wasmBranchHint } from "#wasm/encoder/function-body.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import {
  instantiateIrBlock,
  irBlockBody,
  irBlockCompleted
} from "./harness.js";

test("ifValue selects one arm result and preserves its hint", async () => {
  const values = new ValueTable();
  const body = new BodyBuilder(values);
  const output = body.ifValue(
    values.external(0),
    (then) => then.opValue({ kind: "state.read", slot: gprChannel("ebx") }),
    (otherwise) => otherwise.opValue({ kind: "state.read", slot: gprChannel("ecx") }),
    { hint: "unlikely" }
  );

  body.op({ kind: "state.write", slot: gprChannel("eax"), value: output });

  const block: IrBlock = { values, body: body.build() };
  const encoded = irBlockBody(block, 1).encodeWithMetadata();

  deepStrictEqual(
    encoded.branchHints.map((hint) => hint.value),
    [wasmBranchHint.unlikely]
  );

  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { ebx: 11, ecx: 22 });
  strictEqual(run(1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 22);
});

test("a dead ifValue output preserves an impossible selected arm", async () => {
  const values = new ValueTable();
  const body = new BodyBuilder(values);

  body.ifValue(
    values.external(0),
    (then) => then.values.const(7),
    (otherwise) => otherwise.values.unreachable()
  );

  const block: IrBlock = { values, body: body.build() };
  const { run } = await instantiateIrBlock(block, 1);

  strictEqual(run(1), irBlockCompleted);
  throws(() => run(0), WebAssembly.RuntimeError);
});
