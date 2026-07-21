import { strictEqual } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import { RegionBuilder } from "#ir/region-builder.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#core/state/channels.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateChannel
} from "#test/support/cpu-state.js";
import {
  instantiateIrBlock,
  irBlockCompleted
} from "./harness.js";

test("cell reads and writes execute through placement-owned storage", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = cpuStateAccess.bind(body);
  const cell = body.cell(values.const(37));
  const output = body.read(cell);

  state.write(state.gpr("eax"), output);
  const block: IrBlock = { values, body: body.build() };
  const { run, stateView } = await instantiateIrBlock(block);

  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 37);
});

test("a cell read producer can realize in a nested body", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const condition = values.external(0);
  const cell = body.cell(values.const(1));

  body.write(cell, values.const(9));
  const output = body.read(cell);

  body.if(condition, (then) => {
    const state = cpuStateAccess.bind(then);

    state.write(state.gpr("eax"), output);
  });
  const block: IrBlock = { values, body: body.build() };
  const { run, stateView } = await instantiateIrBlock(block, 1);

  strictEqual(run(1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
});

test("branch arms start from the incoming cell snapshot and join the selected write", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = cpuStateAccess.bind(body);
  const condition = values.external(0);
  const cell = body.cell(values.const(11));

  body.if(
    condition,
    (then) => then.write(cell, values.const(22)),
    {
      elseBuild: (otherwise) => {
        const incoming = otherwise.read(cell);

        const branchState = cpuStateAccess.bind(otherwise);

        branchState.write(branchState.gpr("ebx"), incoming);
      }
    }
  );
  const joined = body.read(cell);

  state.write(state.gpr("eax"), joined);
  const block: IrBlock = { values, body: body.build() };
  const { run, stateView } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateChannel(stateView, gprChannel("ebx"), 99);
  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 11);

  writeWasmCpuStateChannel(stateView, gprChannel("ebx"), 99);
  strictEqual(run(1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 22);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 99);
});

test("an i64 cell local preserves its value through i32 truncation", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const state = cpuStateAccess.bind(body);
  const cell = body.cell(values.const64(1n));

  body.write(cell, values.const64(0x1234_5678_89ab_cdefn));
  const wide = body.read(cell);
  const low = values.truncate64(32, wide);

  state.write(state.gpr("eax"), low);
  const block: IrBlock = { values, body: body.build() };
  const { run, stateView } = await instantiateIrBlock(block);

  strictEqual(run(), irBlockCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("eax")),
    0x89ab_cdef
  );
});
