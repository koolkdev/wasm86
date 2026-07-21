import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { RegionBuilder } from "#ir/region-builder.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#core/state/channels.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { wasmBranchHint } from "#compiler/encoder/function-body.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  instantiateIrBlock,
  irBlockBody,
  irBlockCompleted
} from "./harness.js";

test("ifValue selects one arm result and preserves its hint", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = cpuStateAccess.bind(body);
  const output = body.ifValue(
    values.external(0),
    (then) => {
      const branchState = cpuStateAccess.bind(then);

      return branchState.read(branchState.gpr("ebx"));
    },
    (otherwise) => {
      const branchState = cpuStateAccess.bind(otherwise);

      return branchState.read(branchState.gpr("ecx"));
    },
    { hint: "unlikely" }
  );

  state.write(state.gpr("eax"), output);

  const block: IrBlock = { values, body: body.build() };
  const encoded = irBlockBody(block, 1);

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
  const body = new RegionBuilder(values);

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

test("a shared unreachable result traps in either selected arm", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);

  body.ifValue(
    values.external(0),
    (then) => then.values.unreachable(),
    (otherwise) => otherwise.values.unreachable()
  );

  const block: IrBlock = { values, body: body.build() };
  const { run } = await instantiateIrBlock(block, 1);

  throws(() => run(1), WebAssembly.RuntimeError);
  throws(() => run(0), WebAssembly.RuntimeError);
});

test("an unselected ifValue arm does not evaluate a trapping result", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = cpuStateAccess.bind(body);
  const output = body.ifValue(
    values.external(0),
    (then) => then.values.binary("div_u", then.values.external(1), then.values.external(2)),
    (otherwise) => otherwise.values.const(7)
  );

  state.write(state.gpr("eax"), output);

  const block: IrBlock = { values, body: body.build() };
  const { stateView, run } = await instantiateIrBlock(block, 3);

  strictEqual(run(0, 1, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(run(1, 84, 2), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  throws(() => run(1, 1, 0), WebAssembly.RuntimeError);
});
