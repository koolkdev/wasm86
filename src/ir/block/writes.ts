import {
  BindingResolver,
  dynamicRegBinding,
  regBinding,
  type StorageBinding
} from "#ir/block/bindings/resolver.js";
import type { BlockAction } from "#ir/block/actions.js";
import type {
  BlockScheduleEntry,
  BoundaryScheduleEntry
} from "#ir/block/schedule.js";
import type { ExprDependency } from "#ir/expr/dependencies.js";
import type { FlagName } from "#ir/model/flags.js";
import { registerAlias } from "#x86/registers.js";
import type { RegisterAlias } from "#x86/types.js";

export type CellWrite =
  | Readonly<{ kind: "reg"; reg: RegisterAlias }>
  | Readonly<{ kind: "flag"; flag: FlagName }>
  | Readonly<{ kind: "dynamicReg"; binding: Extract<StorageBinding, { kind: "dynamicReg" }> }>;

const dynamicRegisterWriteResolver = new BindingResolver();

export function writesForEntry(entry: BlockScheduleEntry): readonly CellWrite[] {
  switch (entry.role) {
    case "action":
      return writesForActionEntry(entry);
    case "definition":
      return Object.freeze([]);
    case "boundary":
      return writesForBoundaryEntry(entry);
  }
}

export function writeOverlapsDependencies(
  write: CellWrite,
  deps: readonly ExprDependency[]
): boolean {
  switch (write.kind) {
    case "reg":
      return clobbersOverlapDependencies(
        dynamicRegisterWriteResolver.clobbers(regBinding(write.reg)),
        deps
      );
    case "flag":
      return deps.some((dep) => dep.kind === "flag" && dep.flag === write.flag);
    case "dynamicReg":
      return clobbersOverlapDependencies(
        dynamicRegisterWriteResolver.clobbers(write.binding),
        deps
      );
  }
}

function writesForActionEntry(
  entry: Extract<BlockScheduleEntry, { role: "action" }>
): readonly CellWrite[] {
  if (entry.action.kind !== "dynamicRegisterStore") {
    return Object.freeze([]);
  }

  return Object.freeze([
    Object.freeze({
      kind: "dynamicReg",
      binding: dynamicRegisterBinding(entry.action)
    })
  ]);
}

function writesForBoundaryEntry(entry: BoundaryScheduleEntry): readonly CellWrite[] {
  if (entry.kind !== "stateSync") {
    return Object.freeze([]);
  }

  return Object.freeze([
    ...entry.state.registers.cells().map((cell) => Object.freeze({
      kind: "reg" as const,
      reg: registerAlias(cell.reg)
    })),
    ...entry.state.flags.cells().flatMap(({ flag, cell }) =>
      cell.kind === "undef"
        ? []
        : [Object.freeze({ kind: "flag" as const, flag })]
    )
  ]);
}

function dynamicRegisterBinding(
  action: Extract<BlockAction, { kind: "dynamicRegisterStore" }>
): Extract<StorageBinding, { kind: "dynamicReg" }> {
  const binding = dynamicRegBinding(action.index, action.width);

  if (binding.kind !== "dynamicReg") {
    throw new Error("dynamic register write binding resolved to non-dynamic storage");
  }

  return binding;
}

function clobbersOverlapDependencies(
  clobbers: ReturnType<BindingResolver["clobbers"]>,
  deps: readonly ExprDependency[]
): boolean {
  return clobbers.some((clobber) =>
    clobber.kind === "reg" &&
      deps.some((dep) =>
        dep.kind === "reg" &&
          dep.reg === clobber.reg &&
          ((dep.mask & clobber.mask) >>> 0) !== 0
      )
  );
}
