import { assert } from "#common/assert.js";
import { u32 } from "#core/numeric.js";
import { statusFlagResolverType } from "#core/flags/resolvers.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import type { LegacyEffects } from "#compiler/program/legacy-body.js";
import {
  exportRef,
  functionRef,
  signatureRef,
  tableRef,
  type FunctionRef,
  type SignatureRef,
  type TableRef
} from "#compiler/program/refs.js";
import {
  resourceRef,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { wasmImport } from "#wasm/abi.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { guestMemoryResource } from "#memory/resource.js";
import { encodeTransfer } from "./legacy-transfer.js";
import type { IrBlock } from "#ir/block.js";
import { walkBodyActions } from "#ir/traverse.js";
import {
  jitModuleLinkFallbackExportName,
  type JitLinkLayout
} from "./compiled-blocks/module-link-table.js";
import { LegacyActionEmbeddingAdapter } from "./legacy-action-embedding.js";
import {
  LegacyNumericLinkAdapter,
  type JitLink
} from "./legacy-numeric-link.js";

type JitProgram = Readonly<{
  builder: ProgramBuilder;
  blockSignature: SignatureRef;
  cpuState: ResourceRef;
  guestMemory: ResourceRef;
  linkTable: TableRef | undefined;
}>;

type JitProgramSourceBlock = Readonly<{
  entryEip: number;
  ir: IrBlock;
}>;

type JitProgramBlock = Readonly<{
  entryEip: number;
  exportName: string;
  ir: IrBlock;
  linkTargets: readonly number[];
}>;

const jitBlockFunctionType = functionType([], ["i64"]);

export function buildJitProgram(
  sourceBlocks: readonly JitProgramSourceBlock[],
  linkLayout: JitLinkLayout | undefined
): Program {
  assert(sourceBlocks.length > 0, "cannot build an empty JIT program");
  const blocks = prepareJitBlocks(sourceBlocks);
  const links = snapshotLinkLayout(linkLayout);
  const tableTargetEips = links === undefined ? [] : [...links.keys()];
  const program = createJitProgram(tableTargetEips);

  declareLinkStubs(program, tableTargetEips);
  const blockFunctions = createBlockFunctions(blocks);
  const linksByTargetEip = declareLinks(blocks, blockFunctions, program.linkTable, links);

  declareBlocks(program, blocks, blockFunctions, linksByTargetEip, links);
  return program.builder.finish();
}

export function jitBlockExportName(eip: number): string {
  return `block_${u32(eip).toString(16)}`;
}

function prepareJitBlocks(blocks: readonly JitProgramSourceBlock[]): readonly JitProgramBlock[] {
  const seen = new Set<number>();

  return blocks.map((block) => {
    const entryEip = u32(block.entryEip);

    assert(!seen.has(entryEip), `duplicate JIT block module entry EIP: 0x${hex(entryEip)}`);
    seen.add(entryEip);
    return {
      entryEip,
      exportName: jitBlockExportName(entryEip),
      ir: block.ir,
      linkTargets: uniqueU32(jitBlockLinkTargets(block.ir))
    };
  });
}

export function jitBlockLinkTargets(ir: IrBlock): readonly number[] {
  const targets: number[] = [];

  walkBodyActions(ir.body, (action) => {
    if (action.kind === "finish" && action.finish.kind === "dispatch") {
      const target = ir.values.constValue(action.finish.targetEip);

      if (target !== undefined) {
        targets.push(u32(target));
      }
    }
  });

  return targets;
}

function createJitProgram(tableTargetEips: readonly number[]): JitProgram {
  const builder = new ProgramBuilder();
  const blockSignature = signatureRef("jit.block-entry");
  const cpuState = resourceRef("jit.cpu-state");
  const guestMemory = guestMemoryResource;
  const linkTable = tableTargetEips.length === 0 ? undefined : tableRef("jit.links");

  builder.signature({
    ref: blockSignature,
    type: jitBlockFunctionType
  });
  builder.signature({
    ref: signatureRef("jit.status-flag-resolver"),
    type: statusFlagResolverType
  });
  builder.importMemory({
    ref: cpuState,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  builder.importMemory({
    ref: guestMemory,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });
  if (linkTable !== undefined) {
    builder.importTable({
      ref: linkTable,
      moduleName: wasmImport.namespace,
      name: wasmImport.linkTableName,
      limits: { minElements: tableTargetEips.length, maxElements: tableTargetEips.length }
    });
  }

  return { builder, blockSignature, cpuState, guestMemory, linkTable };
}

function declareLinkStubs(program: JitProgram, targetEips: readonly number[]): void {
  for (const targetEip of targetEips) {
    const stub = functionRef(`jit.stub.${hex(targetEip)}`);

    program.builder.legacyFunction({
      ref: stub,
      signature: program.blockSignature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      effects: "none",
      build: () => new WasmFunctionBodyEncoder()
        .i64Const(encodeTransfer({ kind: "linkStub", targetEip }))
        .finish()
    });
    program.builder.exportFunction({
      ref: exportRef(`jit.stub-export.${hex(targetEip)}`),
      name: jitModuleLinkFallbackExportName(targetEip),
      target: stub
    });
  }
}

function createBlockFunctions(blocks: readonly JitProgramBlock[]): ReadonlyMap<number, FunctionRef> {
  return new Map(blocks.map((block) => [
    block.entryEip,
    functionRef(`jit.block.${hex(block.entryEip)}`)
  ]));
}

function declareLinks(
  blocks: readonly JitProgramBlock[],
  blockFunctions: ReadonlyMap<number, FunctionRef>,
  table: TableRef | undefined,
  linkLayout: JitLinkLayout | undefined
): ReadonlyMap<number, JitLink> {
  return new Map(uniqueU32(blocks.flatMap((block) => block.linkTargets)).map((targetEip) => [
    targetEip,
    declareLink(targetEip, blockFunctions, table, linkLayout)
  ]));
}

function declareLink(
  targetEip: number,
  blockFunctions: ReadonlyMap<number, FunctionRef>,
  table: TableRef | undefined,
  linkLayout: JitLinkLayout | undefined
): JitLink {
  const internalFunction = blockFunctions.get(targetEip);

  if (internalFunction !== undefined) {
    return { targetEip, target: { kind: "function", function: internalFunction } };
  }

  assert(table !== undefined && linkLayout !== undefined, `unknown JIT link target: 0x${hex(targetEip)}`);
  assert(linkLayout.has(targetEip), `unknown JIT link table target: 0x${hex(targetEip)}`);
  return { targetEip, target: { kind: "table", table } };
}

function declareBlocks(
  program: JitProgram,
  blocks: readonly JitProgramBlock[],
  blockFunctions: ReadonlyMap<number, FunctionRef>,
  linksByTargetEip: ReadonlyMap<number, JitLink>,
  linkLayout: JitLinkLayout | undefined
): void {
  for (const block of blocks) {
    const ref = blockFunctions.get(block.entryEip);

    assert(ref !== undefined, `missing JIT block identity for 0x${hex(block.entryEip)}`);
    const links = block.linkTargets.map((targetEip) => {
      const link = linksByTargetEip.get(targetEip);

      assert(link !== undefined, `missing JIT link declaration for target 0x${hex(targetEip)}`);
      return link;
    });
    const directCalls = links.flatMap((link) =>
      link.target.kind === "function" ? [link.target.function] : []
    );
    const adapter = new LegacyActionEmbeddingAdapter({
      ir: block.ir,
      links: new LegacyNumericLinkAdapter(links, linkLayout),
      cpuState: program.cpuState,
      guestMemory: program.guestMemory
    });

    program.builder.legacyFunction({
      ref,
      signature: program.blockSignature,
      calls: uniqueFunctionRefs(directCalls),
      resources: [program.cpuState, program.guestMemory],
      globals: [],
      tables: links.some((link) => link.target.kind === "table") && program.linkTable !== undefined
        ? [program.linkTable]
        : [],
      irBlocks: [{ block: block.ir, allowImplicitEntryFallthrough: false }],
      effects: legacyJitEffects,
      build: (bindings) => adapter.build(bindings)
    });
    program.builder.exportFunction({
      ref: exportRef(`jit.block-export.${hex(block.entryEip)}`),
      name: block.exportName,
      target: ref
    });
  }
}

const legacyJitEffects: LegacyEffects = "world";

function uniqueFunctionRefs(refs: readonly FunctionRef[]): readonly FunctionRef[] {
  return [...new Set(refs)];
}

function snapshotLinkLayout(linkLayout: JitLinkLayout | undefined): JitLinkLayout | undefined {
  if (linkLayout === undefined) {
    return undefined;
  }

  const snapshot = new Map<number, number>();
  const slots = new Set<number>();

  for (const [rawTargetEip, slot] of linkLayout) {
    const targetEip = u32(rawTargetEip);

    assert(!snapshot.has(targetEip), `duplicate normalized JIT link target: 0x${hex(targetEip)}`);
    assert(Number.isInteger(slot) && slot >= 0, `invalid JIT link slot for 0x${hex(targetEip)}: ${slot}`);
    assert(!slots.has(slot), `duplicate JIT link slot: ${slot}`);
    snapshot.set(targetEip, slot);
    slots.add(slot);
  }

  for (const [targetEip, slot] of snapshot) {
    assert(
      slot < snapshot.size,
      `JIT link slot out of range for 0x${hex(targetEip)}: ${slot}`
    );
  }

  return snapshot;
}

function uniqueU32(values: readonly number[]): readonly number[] {
  const unique: number[] = [];
  const seen = new Set<number>();

  for (const value of values) {
    const normalized = u32(value);

    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  return unique;
}

function hex(value: number): string {
  return u32(value).toString(16);
}
