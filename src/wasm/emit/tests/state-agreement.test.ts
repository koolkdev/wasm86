import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { stateRead, stateWrite } from "#compiler/ir/operations/state.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import {
  createCpuExecutionStateHostView,
  type CpuExecutionStateHostView
} from "#cpu/execution-state.js";
import { x86Flags } from "#core/flags/definitions.js";
import {
  createFlagStateHostView,
  type FlagStateHostView
} from "#core/flags/host-view.js";
import { u32 } from "#core/numeric.js";
import {
  createCoreStateHostView,
  type CoreStateHostView
} from "#core/state/host-view.js";
import { reg32, segmentRegisters } from "#core/types.js";
import type { IrBlock } from "#ir/block.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  instructionCountChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentAccessChannel,
  segmentBaseChannel,
  segmentLimitChannel,
  segmentSelectorChannel,
  type GprChannel,
  type StateChannel
} from "#ir/slots.js";
import { executionStateLayout } from "#ir/state-layout.js";
import {
  WasmCpuState,
  wasmCpuStateFields,
  type WasmCpuStateField,
  type WasmCpuStateInit
} from "#wasm/host/cpu-state.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

type OwnerViews = Readonly<{
  core: CoreStateHostView;
  flags: FlagStateHostView;
  execution: CpuExecutionStateHostView;
}>;

type AgreementCase = Readonly<{
  name: string;
  field: WasmCpuStateField;
  slot: StateChannel;
  hostSeed: number;
  expectedGeneratedRead: number;
  generatedWrite: number;
  expectedHostRead: number;
  readHost(views: OwnerViews): number;
}>;

const fullMemberCases: AgreementCase[] = [];

for (const [index, reg] of reg32.entries()) {
  const hostSeed = u32(0x8123_4500 + index);
  const generatedWrite = 0x1_0000_0001 + index;

  fullMemberCases.push({
    name: reg,
    field: reg,
    slot: gprChannel(reg),
    hostSeed,
    expectedGeneratedRead: hostSeed,
    generatedWrite,
    expectedHostRead: u32(generatedWrite),
    readHost: ({ core }) => core.readReg32(reg)
  });
}

fullMemberCases.push(
  {
    name: "eip",
    field: "eip",
    slot: eipChannel,
    hostSeed: 0x89ab_cdef,
    expectedGeneratedRead: 0x89ab_cdef,
    generatedWrite: 0x1_2345_6789,
    expectedHostRead: 0x2345_6789,
    readHost: ({ core }) => core.eip
  },
  {
    name: "instructionCount",
    field: "instructionCount",
    slot: instructionCountChannel,
    hostSeed: 0xfedc_ba98,
    expectedGeneratedRead: 0xfedc_ba98,
    generatedWrite: 0x1_7654_3210,
    expectedHostRead: 0x7654_3210,
    readHost: ({ execution }) => execution.instructionCount
  },
  {
    name: "lazyFlagsKind",
    field: "lazyFlagsKind",
    slot: lazyFlagsKindChannel,
    hostSeed: 0x1ab,
    expectedGeneratedRead: 0xab,
    generatedWrite: 0x2cd,
    expectedHostRead: 0xcd,
    readHost: ({ flags }) => flags.lazyKind
  },
  {
    name: "lazyFlagsA",
    field: "lazyFlagsA",
    slot: lazyFlagsAChannel,
    hostSeed: 0xa1b2_c3d4,
    expectedGeneratedRead: 0xa1b2_c3d4,
    generatedWrite: 0x1_e5f6_0718,
    expectedHostRead: 0xe5f6_0718,
    readHost: ({ flags }) => flags.lazyA
  },
  {
    name: "lazyFlagsB",
    field: "lazyFlagsB",
    slot: lazyFlagsBChannel,
    hostSeed: 0x192a_3b4c,
    expectedGeneratedRead: 0x192a_3b4c,
    generatedWrite: 0x1_5d6e_7f80,
    expectedHostRead: 0x5d6e_7f80,
    readHost: ({ flags }) => flags.lazyB
  }
);

for (const flag of x86Flags) {
  fullMemberCases.push({
    name: flag,
    field: flag,
    slot: flagChannel(flag),
    hostSeed: 0x80,
    expectedGeneratedRead: 1,
    generatedWrite: 0xfe,
    expectedHostRead: 1,
    readHost: ({ flags }) => flags.readFlag(flag) ? 1 : 0
  });
}

for (const [index, reg] of segmentRegisters.entries()) {
  const selectorField = `${reg}Selector` as WasmCpuStateField;
  const baseField = `${reg}Base` as WasmCpuStateField;
  const limitField = `${reg}Limit` as WasmCpuStateField;
  const accessField = `${reg}Access` as WasmCpuStateField;

  fullMemberCases.push(
    {
      name: selectorField,
      field: selectorField,
      slot: segmentSelectorChannel(reg),
      hostSeed: 0x1_2300 + index,
      expectedGeneratedRead: 0x2300 + index,
      generatedWrite: 0x2_4500 + index,
      expectedHostRead: 0x4500 + index,
      readHost: ({ core }) => core.readSegmentSelector(reg)
    },
    {
      name: baseField,
      field: baseField,
      slot: segmentBaseChannel(reg),
      hostSeed: u32(0x8100_0000 + index),
      expectedGeneratedRead: u32(0x8100_0000 + index),
      generatedWrite: 0x1_9100_0000 + index,
      expectedHostRead: u32(0x9100_0000 + index),
      readHost: ({ core }) => core.readSegmentBase(reg)
    },
    {
      name: limitField,
      field: limitField,
      slot: segmentLimitChannel(reg),
      hostSeed: u32(0x8200_0000 + index),
      expectedGeneratedRead: u32(0x8200_0000 + index),
      generatedWrite: 0x1_9200_0000 + index,
      expectedHostRead: u32(0x9200_0000 + index),
      readHost: ({ core }) => core.readSegmentLimit(reg)
    },
    {
      name: accessField,
      field: accessField,
      slot: segmentAccessChannel(reg),
      hostSeed: u32(0x8300_0000 + index),
      expectedGeneratedRead: u32(0x8300_0000 + index),
      generatedWrite: 0x1_9300_0000 + index,
      expectedHostRead: u32(0x9300_0000 + index),
      readHost: ({ core }) => core.readSegmentAccess(reg)
    }
  );
}

const narrowGprCases: readonly AgreementCase[] = [
  {
    name: "AL alias",
    field: "eax",
    slot: gprChannel("al"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xdd,
    generatedWrite: 0x1234,
    expectedHostRead: 0xaabb_cc34,
    readHost: ({ core }) => core.readReg32("eax")
  },
  {
    name: "AH alias",
    field: "eax",
    slot: gprChannel("ah"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xcc,
    generatedWrite: 0x1234,
    expectedHostRead: 0xaabb_34dd,
    readHost: ({ core }) => core.readReg32("eax")
  },
  {
    name: "AX alias",
    field: "eax",
    slot: gprChannel("ax"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xccdd,
    generatedWrite: 0x12_3456,
    expectedHostRead: 0xaabb_3456,
    readHost: ({ core }) => core.readReg32("eax")
  }
];

test("agreement cases cover every combined host-view field", () => {
  deepStrictEqual(
    [...new Set(fullMemberCases.map((entry) => entry.field))].sort(),
    [...wasmCpuStateFields].sort()
  );
});

for (const agreement of [...fullMemberCases, ...narrowGprCases]) {
  test(`host and generated state access agree for ${agreement.name}`, async () => {
    const destination = destinationFor(agreement.slot);
    const block = agreementBlock(agreement.slot, destination, agreement.generatedWrite);
    const { stateMemory, run } = await instantiateIrBlock(block);
    const combined = new WasmCpuState(stateMemory);
    const initial: WasmCpuStateInit = {};

    initial[agreement.field] = agreement.hostSeed;
    combined.load(initial);

    strictEqual(run(), irBlockCompleted, `${agreement.name}: generated block completed`);
    strictEqual(
      combined.readReg32(destination.reg),
      agreement.expectedGeneratedRead,
      `${agreement.name}: generated read observed the host write`
    );
    strictEqual(
      agreement.readHost(ownerViews(stateMemory)),
      agreement.expectedHostRead,
      `${agreement.name}: owner host view observed the generated write`
    );
  });
}

function destinationFor(source: StateChannel): GprChannel {
  return source.kind === "gpr" && source.reg === "edi"
    ? gprChannel("eax")
    : gprChannel("edi");
}

function agreementBlock(
  source: StateChannel,
  destination: GprChannel,
  generatedWrite: number
): IrBlock {
  const values = new ValueTable();
  const generatedValue = values.const(generatedWrite);
  const read = stateRead.create({ slot: source });

  assert(read.result.type === "i32", "state reads must produce i32 values");

  const readOutput = values.addActionOutput(read.result.bounds);

  return {
    body: {
      actions: [
        { kind: "op", output: readOutput, op: read },
        {
          kind: "op",
          op: stateWrite.create({ slot: destination, value: readOutput })
        },
        {
          kind: "op",
          op: stateWrite.create({ slot: source, value: generatedValue })
        }
      ]
    },
    values
  };
}

function ownerViews(memory: WebAssembly.Memory): OwnerViews {
  return {
    core: createCoreStateHostView(memory, executionStateLayout),
    flags: createFlagStateHostView(memory, executionStateLayout),
    execution: createCpuExecutionStateHostView(memory, executionStateLayout)
  };
}
