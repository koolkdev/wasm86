import { strictEqual } from "node:assert";
import { test } from "node:test";

import { coreStateFields } from "#core/state/layout.js";
import { exceptionExit } from "#core/exits.js";
import type { RunStop } from "#cpu/cpu.js";
import { buildExit, decodeExit } from "#cpu/exit.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import {
  flatMemoryOperand,
  flatMemoryResolution
} from "#memory/flat.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { assertPageFaultException } from "#test/support/cpu-exception-assertions.js";
import {
  cpuStateAccess,
  testExecutionModel
} from "#test/support/execution-model.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  instantiateTestFunction,
  testFunction,
  type TestFunction
} from "./harness.js";

function decodeReadFunction(k: number): TestFunction {
  return testFunction(0, (fn) => {
    const values = fn.values;
    const state = cpuStateAccess.bind(fn.region);
    const eip = state.field(coreStateFields.eip);
    const eipValue = state.read(eip);
    const address = values.binary("add", eipValue, values.const(k));
    const { access, fault } = flatMemoryResolution(
      values,
      { start: address, byteLength: values.const(1) },
      "instructionFetch"
    );
    const faultResult = buildExit(values, exceptionExit(fault.exception));

    fn.region.if(fault.condition, (failed) => {
      const failedState = cpuStateAccess.bind(failed);

      failedState.write(failedState.field(coreStateFields.eip), eipValue);
      failed.return([faultResult]);
    }, { hint: "unlikely" });
    const fetched = fn.region.operation(resourceRead, {
      source: flatMemoryOperand(
        testExecutionModel.guestMemory.resource,
        values,
        access,
        values.const(0),
        8
      )
    });

    fn.return([values.extend64(32, fetched, false)]);
  });
}

function assertCpuException(
  stop: RunStop
): asserts stop is Extract<RunStop, { kind: "cpuException" }> {
  strictEqual(stop.kind, "cpuException");

  if (stop.kind !== "cpuException") {
    throw new Error("expected CPU exception exit");
  }
}

test("a symbolic function returns a guarded decode byte", async () => {
  const { stateView, guestView, run } = await instantiateTestFunction(
    decodeReadFunction(2)
  );

  writeWasmCpuStateSnapshot(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x90);

  strictEqual(run(), 0x90n);
});

test("a symbolic function preserves an instruction-fetch exit", async () => {
  const { stateView, run } = await instantiateTestFunction(decodeReadFunction(2));
  const eip = guestMemoryMinimumByteLength - 2;

  writeWasmCpuStateSnapshot(stateView, { eip });

  const decoded = decodeExit(run());

  assertCpuException(decoded);
  assertPageFaultException(decoded.exception);
  strictEqual(decoded.exception.linearAddress, eip + 2);
  strictEqual(decoded.exception.errorCode, 16);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), eip);
});
