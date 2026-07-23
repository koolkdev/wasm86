import { ok } from "node:assert";

import type { CpuException } from "#core/exceptions.js";

type PageFaultException = Extract<CpuException<number>, { kind: "PF" }>;

export function assertPageFaultException(
  exception: CpuException<number>,
  label = "expected page fault exception"
): asserts exception is PageFaultException {
  ok(exception.kind === "PF", label);
}
