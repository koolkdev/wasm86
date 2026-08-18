import { assert } from "#common/assert.js";
import type { BlockId, BodyEvent, SiteId } from "#compiler/wasm/function/body.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import type { WasmFunctionBindings } from "./bindings.js";
import type { ValueEmitter } from "./value.js";

type ControlEvent = Extract<
  BodyEvent,
  { kind: "if" | "switch" | "loop" | "loopContinue" | "return" | "returnCall" }
>;
type EndEvent = Extract<BodyEvent, { kind: "end" }>;
type IfEvent = Extract<BodyEvent, { kind: "if" }>;
type SwitchEvent = Extract<BodyEvent, { kind: "switch" }>;
type LoopEvent = Extract<BodyEvent, { kind: "loop" }>;
type LoopContinueEvent = Extract<BodyEvent, { kind: "loopContinue" }>;

type OpenJoinControl = {
  readonly kind: "if" | "switch";
  readonly arms: readonly BlockId[];
  arm: number;
  readonly site: SiteId;
  readonly output: WasmValueId | undefined;
  readonly outputLocal: number | undefined;
  fallsThrough: boolean;
};

type OpenLoopControl = {
  readonly kind: "loop";
  readonly body: BlockId;
  readonly carriedLocals: readonly number[];
  readonly labelDepth: number;
};

type OpenControl = OpenJoinControl | OpenLoopControl;

// Emits structured control while the function layer walks the canonical site
// stream. Each open loop records the Wasm label depth needed by its continues;
// no second body geometry is reconstructed here.
export class WasmControlEmitter {
  readonly #writer: WasmInstructionWriter;
  readonly #bindings: WasmFunctionBindings;
  readonly #values: ValueEmitter;
  readonly #open: OpenControl[] = [];
  #labelDepth = 0;

  constructor(
    context: Readonly<{
      writer: WasmInstructionWriter;
      bindings: WasmFunctionBindings;
      values: ValueEmitter;
    }>
  ) {
    this.#writer = context.writer;
    this.#bindings = context.bindings;
    this.#values = context.values;
  }

  emit(event: ControlEvent, site: SiteId): void {
    switch (event.kind) {
      case "if":
        this.#emitIf(event, site);
        return;
      case "switch":
        this.#emitSwitch(event, site);
        return;
      case "loop":
        this.#emitLoop(event);
        return;
      case "loopContinue":
        this.#emitLoopContinue(event);
        return;
      case "return":
        this.#emitOperands(event.operands);
        this.#writer.write(wasmInstruction.control.return);
        return;
      case "returnCall":
        this.#emitOperands(event.operands);
        this.#writer.write(
          wasmInstruction.returnCall.direct,
          this.#bindings.functionIndex(event.target.ref)
        );
        return;
    }
  }

  // beginSite has already flushed captures at this block end. A live join's
  // arm result follows, then the structural bytes owed by that arm.
  end(event: EndEvent, block: BlockId): void {
    const open = this.#open[this.#open.length - 1];

    assert(open !== undefined, `block ${block} ended outside a structured control`);
    const expectedBlock = open.kind === "loop" ? open.body : open.arms[open.arm];

    assert(expectedBlock === block, `block ${block} is not the current structured body`);
    if (open.kind !== "loop" && event.result !== undefined && open.outputLocal !== undefined) {
      this.#values.emitUse(event.result);
      this.#writer.write(wasmInstruction.local.set, open.outputLocal);
    }

    switch (open.kind) {
      case "if":
        open.fallsThrough ||= event.fallsThrough;
        this.#endIfArm(open);
        return;
      case "switch":
        open.fallsThrough ||= event.fallsThrough;
        this.#endSwitchArm(open);
        return;
      case "loop":
        this.#endLoop(open);
        return;
    }
  }

  assertComplete(): void {
    assert(this.#open.length === 0, "structured controls were not closed");
    assert(this.#labelDepth === 0, "Wasm label stack was not closed");
  }

  #emitIf(event: IfEvent, site: SiteId): void {
    const outputLocal = this.#controlOutputLocal(event.output);

    this.#values.emitUse(event.condition);
    this.#values.emitCaptures();
    this.#writer.write(wasmInstruction.control.if, { hint: event.hint });
    this.#enterLabels();
    this.#open.push({
      kind: "if",
      site,
      arms: event.arms,
      output: event.output,
      outputLocal,
      arm: 0,
      // An omitted else arm is an implicit fallthrough path.
      fallsThrough: event.arms.length === 1
    });
  }

  #emitSwitch(event: SwitchEvent, site: SiteId): void {
    const outputLocal = this.#controlOutputLocal(event.output);
    const caseCount = event.caseMatches.length;

    assert(event.arms.length === caseCount + 1, "switch arms do not include one default");
    // Open order: join, default, case n-1 .. case 0.
    for (let index = 0; index <= caseCount + 1; index += 1) {
      this.#writer.write(wasmInstruction.control.block);
    }
    this.#values.emitUse(event.selector);
    this.#values.emitCaptures();
    this.#writer.write(
      wasmInstruction.control.brTable,
      switchLabelDepths(event.caseMatches),
      caseCount
    );
    this.#writer.write(wasmInstruction.control.end);
    this.#enterLabels(caseCount + 1);
    this.#open.push({
      kind: "switch",
      site,
      arms: event.arms,
      output: event.output,
      outputLocal,
      arm: 0,
      fallsThrough: false
    });
  }

  #emitLoop(event: LoopEvent): void {
    assert(event.seeds.length === event.inputs.length, "loop seeds and inputs do not align");
    const carriedLocals = new Array<number>(event.seeds.length);

    for (let index = 0; index < event.seeds.length; index += 1) {
      const seed = event.seeds[index];
      const input = event.inputs[index];

      assert(seed !== undefined && input !== undefined, `loop carried value ${index} is missing`);
      const local = this.#values.loopInputLocal(input);

      this.#values.emitUse(seed);
      this.#writer.write(wasmInstruction.local.set, local);
      carriedLocals[index] = local;
    }

    this.#values.emitCaptures();
    this.#writer.write(wasmInstruction.control.loop);
    this.#enterLabels();
    this.#open.push({
      kind: "loop",
      body: event.body,
      carriedLocals,
      labelDepth: this.#labelDepth
    });
  }

  #emitLoopContinue(event: LoopContinueEvent): void {
    let loop: OpenLoopControl | undefined;

    for (let index = this.#open.length - 1; index >= 0; index -= 1) {
      const candidate = this.#open[index];

      if (candidate?.kind === "loop") {
        loop = candidate;
        break;
      }
    }

    assert(loop !== undefined, "loop continue is outside a loop body");
    assert(
      event.updates.length === loop.carriedLocals.length,
      "loop continue updates do not align with the loop's carried values"
    );

    // Preserve parallel assignment: push every update before popping them into
    // their carried locals in reverse order.
    for (const update of event.updates) {
      this.#values.emitUse(update);
    }
    for (let index = loop.carriedLocals.length - 1; index >= 0; index -= 1) {
      const local = loop.carriedLocals[index];

      assert(local !== undefined, `loop carried local ${index} is missing`);
      this.#writer.write(wasmInstruction.local.set, local);
    }
    this.#writer.write(wasmInstruction.control.br, this.#labelDepth - loop.labelDepth);
  }

  #endIfArm(open: OpenJoinControl): void {
    if (open.arm + 1 < open.arms.length) {
      assert(open.arm === 0 && open.arms.length === 2, "if has an invalid arm sequence");
      this.#writer.write(wasmInstruction.control.else);
      open.arm += 1;
      return;
    }
    this.#closeJoin(open, open.arms.length === 2 && !open.fallsThrough);
  }

  #endSwitchArm(open: OpenJoinControl): void {
    const caseCount = open.arms.length - 1;

    if (open.arm < caseCount) {
      this.#writer.write(wasmInstruction.control.br, caseCount - open.arm);
      this.#writer.write(wasmInstruction.control.end);
      open.arm += 1;
      this.#leaveLabel();
      return;
    }
    this.#closeJoin(open, !open.fallsThrough);
  }

  #closeJoin(open: OpenJoinControl, seal: boolean): void {
    assert(this.#open.pop() === open, "control stack became unbalanced");
    this.#leaveLabel();
    this.#writer.write(wasmInstruction.control.end);
    if (open.output !== undefined && open.outputLocal !== undefined) {
      this.#values.markJoinOutput(open.output, open.site);
    }
    if (seal) {
      // The source graph records that no arm reaches the join. Seal the Wasm
      // continuation explicitly rather than exposing a synthetic path.
      this.#writer.write(wasmInstruction.control.unreachable);
    }
  }

  #endLoop(open: OpenLoopControl): void {
    assert(this.#open.pop() === open, "loop control stack became unbalanced");

    assert(open.labelDepth === this.#labelDepth, "Wasm loop label became unbalanced");
    this.#leaveLabel();
    this.#writer.write(wasmInstruction.control.end);
  }

  #emitOperands(operands: readonly WasmValueId[]): void {
    for (const operand of operands) {
      this.#values.emitUse(operand);
    }
  }

  #controlOutputLocal(output: WasmValueId | undefined): number | undefined {
    return output === undefined ? undefined : this.#values.joinOutputLocal(output);
  }

  #enterLabels(count = 1): void {
    this.#labelDepth += count;
  }

  #leaveLabel(): void {
    this.#labelDepth -= 1;
    assert(this.#labelDepth >= 0, "Wasm label stack became unbalanced");
  }
}

function switchLabelDepths(caseMatches: readonly (readonly number[])[]): number[] {
  let size = 0;

  for (const matches of caseMatches) {
    for (const match of matches) {
      size = Math.max(size, match + 1);
    }
  }
  const table = new Array<number>(size).fill(caseMatches.length);

  for (const [depth, matches] of caseMatches.entries()) {
    for (const match of matches) {
      table[match] = depth;
    }
  }
  return table;
}
