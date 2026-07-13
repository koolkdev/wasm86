import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { RunStop } from "#cpu/cpu.js";
import { decodeEntryResult } from "#cpu/entry-result.js";
import { divideError, invalidOpcode, pageFault } from "#core/exceptions.js";
import {
  CompletionExit,
  encodeCompletionExit,
  encodeCpuExceptionExit,
  encodeHostExit,
  HostExit
} from "#wasm/exit.js";

const validResults: readonly Readonly<{
  name: string;
  encoded: bigint;
  stop: RunStop;
}>[] = [
  {
    name: "instruction-limit",
    encoded: encodeCompletionExit(CompletionExit.INSTRUCTION_LIMIT, 0),
    stop: { kind: "instructionLimit" }
  },
  {
    name: "host-trap",
    encoded: encodeHostExit(HostExit.TRAP, 0xcd),
    stop: { kind: "hostTrap", vector: 0xcd }
  },
  {
    name: "unsupported-opcode",
    encoded: encodeHostExit(HostExit.UNSUPPORTED, 0),
    stop: { kind: "unsupported", reason: "unsupportedOpcode" }
  },
  {
    name: "segment-load",
    encoded: encodeHostExit(HostExit.SEGMENT_LOAD, 0x3_1234),
    stop: { kind: "segmentLoad", segment: "ds", selector: 0x1234 }
  },
  {
    name: "divide-error",
    encoded: encodeCpuExceptionExit(divideError()),
    stop: { kind: "cpuException", exception: divideError() }
  },
  {
    name: "invalid-opcode",
    encoded: encodeCpuExceptionExit(invalidOpcode()),
    stop: { kind: "cpuException", exception: invalidOpcode() }
  },
  {
    name: "page-fault",
    encoded: encodeCpuExceptionExit(pageFault(0xffff_fffc, 0x8001)),
    stop: {
      kind: "cpuException",
      exception: pageFault(0xffff_fffc, 0x8001)
    }
  }
];

for (const fixture of validResults) {
  test(`entry result decodes ${fixture.name}`, () => {
    deepStrictEqual(decodeEntryResult(fixture.encoded), fixture.stop);
  });
}

test("entry result rejects malformed encoded values", () => {
  const malformed = [
    0xff00n << 32n,
    0x02ffn << 32n,
    (1n << 48n) | (0x0200n << 32n),
    (0x0300n << 32n) | 1n
  ];

  for (const encoded of malformed) {
    throws(() => decodeEntryResult(encoded));
  }
});

test("entry result rejects a malformed segment-load payload", () => {
  throws(
    () => decodeEntryResult(encodeHostExit(HostExit.SEGMENT_LOAD, 0xff_1234)),
    /invalid segment index/
  );
});

test("entry result rejects payloads on fieldless exits", () => {
  throws(
    () => decodeEntryResult(
      encodeCompletionExit(CompletionExit.INSTRUCTION_LIMIT, 1)
    ),
    /instruction-limit entry result payload must be zero/
  );
  throws(
    () => decodeEntryResult(encodeHostExit(HostExit.UNSUPPORTED, 1)),
    /unsupported entry result payload must be zero/
  );
});

test("entry result rejects a host-trap vector wider than eight bits", () => {
  throws(
    () => decodeEntryResult(encodeHostExit(HostExit.TRAP, 0x100)),
    /must be an x86 interrupt vector/
  );
});

for (const reason of [CompletionExit.DYNAMIC_JUMP, CompletionExit.LINK_STUB]) {
  test(`entry result rejects legacy transfer completion ${reason}`, () => {
    throws(
      () => decodeEntryResult(encodeCompletionExit(reason, 0x1234)),
      /nonterminal completion/
    );
  });
}
