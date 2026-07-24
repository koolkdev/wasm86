import { assert } from "#common/assert.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  type CpuException
} from "#core/exceptions.js";
import {
  type StatusFlagResolverFamily
} from "#core/flags/lazy/resolvers.js";
import type { StateAccess } from "#core/state/access.js";
import type {
  AccessFault,
  IfBody,
  LoopBody,
  SemanticBranchHint,
  SemanticTemplate
} from "#instructions/semantics/builder.js";
import type {
  TargetInput,
  Value,
  ValueInput
} from "#instructions/semantics/refs.js";
import type { OperandWidth } from "#core/types.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import type {
  MemoryAccessConstruction
} from "#memory/access.js";
import type {
  OperandBinding,
  SegmentOperandBinding
} from "./bindings.js";
import { ControlEmitter, type IfOutcome } from "./control.js";
import { LoopBuilder } from "./loop.js";
import { SemanticScopeStack, type SemanticRegionScope } from "./scope.js";
import {
  InstructionSemantics,
  type InstructionSemanticsSession
} from "./semantics.js";
import { emitSegmentLoad } from "./segments.js";
import {
  InstructionStorage,
  type ScopedInstructionStorage
} from "./storage.js";
import { type InstructionStateChannel } from "./state/channels.js";
import { StateWriteLog } from "./state/write-log.js";
import {
  InstructionTerminator,
  type BuildExit,
  type InstructionTerminals
} from "./terminal.js";
export type InstructionLocation =
  | Readonly<{ kind: "static"; eip: number; nextEip: number }>
  | Readonly<{ kind: "value"; eip: ValueId; nextEip: ValueId }>;

type InstructionLocationValues = Readonly<{ eip(): ValueId; nextEip(): ValueId }>;

export type InstructionBuilder = Readonly<{
  add(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): boolean;
}>;

export type InstructionBuildOptions = Readonly<{
  stateAccess: StateAccess;
  memory: MemoryAccessConstruction;
  instructionCountField: FieldRef<"u32">;
  buildExit: BuildExit;
  statusFlagResolvers: StatusFlagResolverFamily;
  terminals: InstructionTerminals;
}>;

export function buildInstructionSequence(
  region: RegionBuilder,
  options: InstructionBuildOptions,
  addInstructions: (builder: InstructionBuilder) => void
): ValueId | undefined {
  return new InstructionBuilderImpl(region, options).build(addInstructions);
}

export function staticInstructionLocation(eip: number, nextEip: number): InstructionLocation {
  return { kind: "static", eip, nextEip };
}

export function valueInstructionLocation(
  eip: ValueId,
  nextEip: ValueId
): InstructionLocation {
  return { kind: "value", eip, nextEip };
}

// Coordinates one instruction-sequence transaction. Semantic callbacks
// receive InstructionSemantics instances fixed to their lexical scope; this
// session owns lifecycle, joins, completion, and the shared pending state.
class InstructionBuilderImpl implements InstructionSemanticsSession {
  readonly #values: ValueTable;
  readonly #region: RegionBuilder;
  readonly #scopes: SemanticScopeStack;
  readonly #options: InstructionBuildOptions;
  readonly #storage: InstructionStorage;
  readonly #control: ControlEmitter;
  readonly #terminator: InstructionTerminator;
  readonly #scopeStorage = new WeakMap<SemanticRegionScope, ScopedInstructionStorage>();
  readonly #scopeSemantics = new WeakMap<SemanticRegionScope, InstructionSemantics>();
  #instructionLocation: InstructionLocationValues | undefined;
  #closed = false;
  // "terminated" means the root region already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  constructor(
    region: RegionBuilder,
    options: InstructionBuildOptions,
    stateWriteLog = new StateWriteLog(),
    values = region.values
  ) {
    this.#values = values;
    this.#region = region;
    this.#options = options;
    this.#scopes = new SemanticScopeStack(this.#region);
    this.#storage = new InstructionStorage({
      stateAccess: options.stateAccess,
      statusFlagResolvers: options.statusFlagResolvers,
      memory: options.memory,
      instructionCountField: options.instructionCountField,
      writeObserver: stateWriteLog
    });
    this.#control = new ControlEmitter(
      this.#storage.state,
      stateWriteLog,
      this.#scopes,
      (scope) => this.#semantics(scope)
    );
    this.#terminator = new InstructionTerminator(
      this.#storage.state,
      options.buildExit,
      options.terminals
    );
  }

  build(
    addInstructions: (builder: InstructionBuilder) => void
  ): ValueId | undefined {
    const facade: InstructionBuilder = {
      add: (template, bindings, location) =>
        this.add(template, bindings, location)
    };

    try {
      addInstructions(facade);
      return this.#complete();
    } finally {
      this.#closed = true;
    }
  }

  add(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): boolean {
    assert(!this.#closed, "cannot add instructions to a closed instruction builder");
    assert(this.#blockEnd === "fallthrough", "cannot add instructions after a block terminator");
    assert(this.#instructionLocation === undefined, "instruction builder has an incomplete instruction");

    this.#scopes.root.reset();
    this.#instructionLocation = this.#locationValues(location);
    this.#storage.beginInstruction(bindings, this.#location().eip());

    this.#scopes.root.run(() => (
      template(this.#semantics(this.#scopes.root), this.#values)
    ));

    if (!this.#scopes.root.isTerminated()) {
      this.#completeRootFallthrough();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instructionLocation = undefined;
    this.#storage.endInstruction();
    return !this.#isTerminated();
  }

  #complete(): ValueId | undefined {
    assert(this.#instructionLocation === undefined, "instruction builder has an incomplete instruction");

    switch (this.#blockEnd) {
      case "fallthrough": {
        const storage = this.#storageFor(this.#scopes.root);

        assert(this.#storage.state.eip.has(), "instruction builder did not advance eip; no instructions were added");
        const nextEip = this.#storage.state.eip.read(storage.access);

        this.#terminator.publishCompletedState(this.#region, storage.access);
        return nextEip;
      }
      case "jump": {
        const storage = this.#storageFor(this.#scopes.root);

        assert(this.#storage.state.eip.has(), "instruction builder did not advance eip; no instructions were added");
        const targetEip = this.#storage.state.eip.read(storage.access);

        this.#terminator.dispatch(this.#region, storage.access, targetEip);
        return undefined;
      }
      case "terminated":
        return undefined;
    }
  }

  assertActive(scope: SemanticRegionScope): void {
    assert(
      this.#scopes.current === scope,
      "a semantic scope facade cannot be used outside its lexical callback"
    );
  }

  currentEip(): Value {
    return this.#location().eip();
  }

  nextEip(): Value {
    return this.#location().nextEip();
  }

  jump(scope: SemanticRegionScope, target: TargetInput): void {
    this.assertActive(scope);
    this.#completeInstruction(scope, target);
    this.#completeDispatch(scope);
    scope.complete();
  }

  if(
    scope: SemanticRegionScope,
    condition: ValueInput,
    thenBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.assertActive(scope);
    this.#completeIf(
      scope,
      this.#control.if(scope, condition, thenBuild, hint)
    );
  }

  ifElse(
    scope: SemanticRegionScope,
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.assertActive(scope);
    this.#completeIf(
      scope,
      this.#control.ifElse(scope, condition, thenBuild, elseBuild, hint)
    );
  }

  // Opens a loop: body-written channels become loop-carried values held in
  // locals while the body runs. The loop itself falls through; instruction
  // completion remains with the surrounding semantic template.
  loop(scope: SemanticRegionScope, body: LoopBody): void {
    this.assertActive(scope);
    const bodyWrites = this.#deriveLoopWrites(body);
    const loop = LoopBuilder.begin({
      state: this.#storage.state,
      parentRegion: scope.region
    }, bodyWrites);

    this.#control.runLoopBody(
      scope,
      loop.region,
      body,
      (condition) => loop.close(condition)
    );
  }

  cpuException(
    scope: SemanticRegionScope,
    exception: CpuException<ValueInput>
  ): void {
    this.assertActive(scope);
    assert(!scope.wroteMemory(), "a CPU exception cannot follow a memory write in the same instruction");
    this.#markTerminated(scope);
    this.#terminator.cpuException(
      scope.region,
      this.#storageFor(scope).access,
      exception
    );
    this.#endBlock(scope, "terminated");
    scope.complete();
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(scope: SemanticRegionScope, vector: ValueInput): void {
    this.assertActive(scope);
    this.#completeInstruction(scope, this.#location().nextEip());
    this.#terminator.hostTrap(
      scope.region,
      this.#storageFor(scope).access,
      vector
    );
    this.#endBlock(scope, "terminated");
    scope.complete();
  }

  #semantics(scope: SemanticRegionScope): InstructionSemantics {
    const existing = this.#scopeSemantics.get(scope);

    if (existing !== undefined) {
      return existing;
    }

    const storage = this.#storage.bind(scope, {
      raiseAccessFault: (fault) =>
        this.#raiseAccessFault(scope, fault),
      writeSegmentSelector: (binding, value, width) =>
        this.#writeSegmentSelector(scope, binding, value, width)
    });
    const semantics = new InstructionSemantics({
      session: this,
      scope,
      storage,
      state: this.#storage.state,
      operands: this.#storage.operands
    });

    this.#scopeStorage.set(scope, storage);
    this.#scopeSemantics.set(scope, semantics);
    return semantics;
  }

  #storageFor(scope: SemanticRegionScope): ScopedInstructionStorage {
    this.#semantics(scope);
    const storage = this.#scopeStorage.get(scope);

    assert(storage !== undefined, "semantic scope has no lexical storage binding");
    return storage;
  }

  #isTerminated(): boolean {
    return this.#blockEnd !== "fallthrough";
  }

  #completeRootFallthrough(): void {
    const scope = this.#scopes.root;

    this.#completeInstruction(scope, this.#location().nextEip());
    this.#endBlock(scope, "fallthrough");
  }

  #completeIf(scope: SemanticRegionScope, outcome: IfOutcome): void {
    if (outcome === "completes") {
      this.#markTerminated(scope);
      this.#endBlock(scope, "terminated");
      scope.complete();
    }
  }

  #deriveLoopWrites(body: LoopBody): readonly InstructionStateChannel[] {
    // SemanticsBuilder.loop does not declare its architectural writes, but the
    // loop needs them before constructing its loop inputs. Run the callback once
    // in an isolated scratch builder to collect possible x86 writes, discard that
    // body, then run it normally to build the real loop. The callback must not
    // depend on build-time side effects because construction invokes it twice.
    const writeLog = new StateWriteLog();
    const scratchValues = this.#scopes.current.region.values.fork();
    const scratch = new InstructionBuilderImpl(
      new RegionBuilder(scratchValues),
      this.#options,
      writeLog,
      scratchValues
    );
    scratch.#storage.beginInstruction(
      this.#storage.currentBindings(),
      scratch.#values.const(0)
    );

    try {
      return writeLog.captureWrittenChannels(() => {
        scratch.#control.runLoopBody(
          scratch.#scopes.root,
          scratch.#region,
          body,
          () => {}
        );
      });
    } finally {
      scratch.#storage.endInstruction();
    }
  }

  #markTerminated(scope: SemanticRegionScope): void {
    scope.markTerminated();
  }

  #completeInstruction(scope: SemanticRegionScope, target: ValueInput): void {
    this.#markTerminated(scope);
    const access = this.#storageFor(scope).access;

    this.#storage.state.instructionCount.increment(access);
    this.#storage.state.eip.write(target);
  }

  // A dispatching arm terminates where it occurs. The root records the
  // dispatch until sequence completion publishes its state and terminal.
  #completeDispatch(scope: SemanticRegionScope): void {
    switch (scope.kind) {
      case "root":
        this.#endBlock(scope, "jump");
        return;
      case "arm": {
        const storage = this.#storageFor(scope);
        const targetEip = this.#storage.state.eip.read(storage.access);

        this.#terminator.dispatch(scope.region, storage.access, targetEip);
        return;
      }
      case "loop":
        assert(false, "a loop body must not dispatch");
    }
  }

  // Only the root flow's terminator ends the block; an arm's terminator is
  // local to its own body.
  #endBlock(
    scope: SemanticRegionScope,
    end: "fallthrough" | "jump" | "terminated"
  ): void {
    if (scope.kind === "root") {
      this.#blockEnd = end;
    }
  }

  #raiseAccessFault(
    scope: SemanticRegionScope,
    fault: AccessFault
  ): void {
    this.assertActive(scope);
    this.#control.if(
      scope,
      fault.condition,
      (arm) => arm.cpuException(fault.exception),
      "unlikely"
    );
  }

  #writeSegmentSelector(
    scope: SemanticRegionScope,
    binding: SegmentOperandBinding,
    value: ValueInput,
    accessWidth: OperandWidth
  ): void {
    this.assertActive(scope);
    assert(accessWidth === 16, `${accessWidth}-bit set to a segment selector`);
    assert(!scope.isTerminated(), "the semantic scope is already terminated");
    // Also what keeps segment reads hoistable out of loop bodies.
    assert(!scope.insideLoop, "a segment load inside a loop body is unsupported");
    assert(scope.kind === "root", "a segment load inside a semantic if arm is unsupported");

    const outcome = emitSegmentLoad(
      this.#terminator,
      scope.region,
      this.#storageFor(scope).access,
      binding,
      value
    );

    if (outcome === "terminated") {
      this.#markTerminated(scope);
      this.#endBlock(scope, "terminated");
      scope.complete();
    }
  }

  #locationValues(location: InstructionLocation): InstructionLocationValues {
    switch (location.kind) {
      case "static":
        return {
          eip: () => this.#values.const(location.eip),
          nextEip: () => this.#values.const(location.nextEip)
        };
      case "value":
        return {
          eip: () => location.eip,
          nextEip: () => location.nextEip
        };
    }
  }

  #location(): InstructionLocationValues {
    assert(this.#instructionLocation !== undefined, "instruction builder has no current instruction");
    return this.#instructionLocation;
  }
}
