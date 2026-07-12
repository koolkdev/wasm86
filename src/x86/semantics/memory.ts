import { assert } from "#common/assert.js";
import type { Values } from "#ir/values.js";
import { pageFault, pageFaultErrorCode, type CpuException } from "#core/exceptions.js";
import type {
  GetOptions,
  SemanticBuildContext,
  SemanticOps
} from "#x86/semantics/builder.js";
import type {
  MemRef,
  MemoryAccess,
  MemoryAccessKind,
  OperandRef,
  StorageInput,
  Value,
  ValueInput
} from "#x86/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";

export type ResolvedOperandStorage = "reg" | "mem";

export type ResolvedStorageAccess<TIntent extends MemoryAccessKind = MemoryAccessKind> =
  | Readonly<{ kind: "storage"; storage: StorageInput }>
  | Readonly<{ kind: "memory"; access: MemoryAccess<TIntent> }>;

export function resolvedOperandStorage(
  context: SemanticBuildContext,
  operand: OperandRef
): ResolvedOperandStorage {
  const storage = context.operandInfo(operand).storage;

  switch (storage) {
    case "reg":
      return "reg";
    case "mem":
      return "mem";
    case "imm":
    case "relTarget":
      assert(false, `operand storage cannot be ${storage}`);
  }
}

export function resolveStorageRead(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): ResolvedStorageAccess<"read"> {
  return resolveStorage(s, v, context, storage, width, "read");
}

export function resolveStorageWrite(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): ResolvedStorageAccess<"write"> {
  return resolveStorage(s, v, context, storage, width, "write");
}

export function resolveStorageReadWrite(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth
): ResolvedStorageAccess<"write"> {
  return resolveStorageWrite(s, v, context, storage, width);
}

export function resolveMemoryAccess<TIntent extends MemoryAccessKind>(
  s: SemanticOps,
  memory: MemRef,
  byteLength: ValueInput,
  intent: TIntent
): MemoryAccess<TIntent> {
  const access = s.memoryResolve(memory, byteLength, intent);

  s.if(
    access.invalid,
    (failure) => failure.cpuException(memoryAccessException(access)),
    "unlikely"
  );
  return access;
}

export function memoryAccessException(access: MemoryAccess): CpuException<ValueInput> {
  return pageFault(
    access.linearAddress,
    pageFaultErrorCode(access.intent === "write" ? "dataWrite" : "dataRead")
  );
}

export function readStorage(
  s: SemanticOps,
  v: Values,
  storage: ResolvedStorageAccess,
  width: OperandWidth,
  options: GetOptions = {}
): Value {
  switch (storage.kind) {
    case "storage":
      return s.get(storage.storage, width, options);
    case "memory":
      return s.memoryRead(storage.access, v.const(0), width, options);
  }
}

export function writeStorage(
  s: SemanticOps,
  v: Values,
  storage: ResolvedStorageAccess<"write">,
  value: ValueInput,
  width: OperandWidth
): void {
  switch (storage.kind) {
    case "storage":
      s.set(storage.storage, value, width);
      return;
    case "memory":
      s.memoryWrite(storage.access, v.const(0), value, width);
      return;
  }
}

function resolveStorage<TIntent extends MemoryAccessKind>(
  s: SemanticOps,
  v: Values,
  context: SemanticBuildContext,
  storage: StorageInput,
  width: OperandWidth,
  intent: TIntent
): ResolvedStorageAccess<TIntent> {
  if (storage.kind !== "operand") {
    return { kind: "storage", storage };
  }

  switch (context.operandInfo(storage).storage) {
    case "mem":
      return {
        kind: "memory",
        access: resolveMemoryAccess(s, s.operandMem(storage), v.const(width / 8), intent)
      };
    case "reg":
    case "imm":
    case "relTarget":
      return { kind: "storage", storage };
  }
}
