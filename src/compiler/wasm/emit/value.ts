import { assert } from "#common/assert.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { BodyEvent, SiteId, WasmBody } from "#compiler/wasm/function/body.js";
import { wasmValueSource, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import {
  evaluationForUse,
  type EvaluationId,
  type WasmEvaluation,
  type WasmSchedule
} from "#compiler/wasm/plan/schedule.js";
import type { WasmLocalResolver } from "#wasm/encoder/function-body.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import type { WasmFunctionBindings } from "./bindings.js";
import { emitWasmOperation } from "./operation.js";
import { emitWasmValueInstruction } from "./value-instruction.js";

// Replays one completed value schedule. Its only mutable state is which
// evaluations have been emitted and the body site currently being emitted.
export class ValueEmitter {
  readonly #writer: WasmInstructionWriter;
  readonly #bindings: WasmFunctionBindings;
  readonly #body: WasmBody;
  readonly #schedule: WasmSchedule;
  readonly #resolveLocal: WasmLocalResolver;
  readonly #emitted: Uint8Array;
  #site: SiteId | undefined;

  constructor(
    context: Readonly<{
      writer: WasmInstructionWriter;
      bindings: WasmFunctionBindings;
      body: WasmBody;
      schedule: WasmSchedule;
      resolveLocal: WasmLocalResolver;
    }>
  ) {
    this.#writer = context.writer;
    this.#bindings = context.bindings;
    this.#body = context.body;
    this.#schedule = context.schedule;
    this.#resolveLocal = context.resolveLocal;
    this.#emitted = new Uint8Array(context.schedule.evaluations.length);
  }

  beginSite(site: SiteId, event: BodyEvent): void {
    this.#site = site;
    if (!capturesAfterOperands(event)) {
      this.#emitCapturesAt(site);
    }
  }

  // Structured headers call this after their own operands and before entering
  // a selected child block.
  emitCaptures(): void {
    this.#emitCapturesAt(this.#currentSite());
  }

  emitUse(value: WasmValueId): void {
    if (wasmValueSource(this.#body.values.node(value)) === "inline") {
      this.#emitValue(value);
      return;
    }

    const site = this.#currentSite();
    const id = evaluationForUse(this.#schedule, value, site);

    assert(id !== undefined, `value ${value} has no evaluation at site ${site}`);
    const evaluation = this.#evaluation(id);

    assert(evaluation.value === value, `evaluation ${id} does not produce value ${value}`);
    if (this.#emitted[id] !== 0) {
      this.#writer.write(wasmInstruction.local.get, this.#evaluationLocal(id));
      return;
    }

    assert(
      evaluation.kind === "atUse",
      `value ${value} used before its ${evaluation.kind} deadline`
    );
    assert(evaluation.anchor === site, `value ${value} emitted outside its anchor`);
    this.#emitEvaluationSource(id);

    if (evaluation.local !== undefined) {
      this.#writer.write(wasmInstruction.local.tee, this.#resolveLocal(evaluation.local));
    }
    this.#emitted[id] = 1;
  }

  joinOutputLocal(value: WasmValueId): number | undefined {
    const id = this.#schedule.defaultEvaluations[value];

    if (id === undefined) {
      return undefined;
    }
    assert(this.#evaluation(id).kind === "join", `value ${value} is not a join output`);
    return this.#evaluationLocal(id);
  }

  markJoinOutput(value: WasmValueId, anchor: SiteId): void {
    const id = this.#schedule.defaultEvaluations[value];

    assert(id !== undefined, `value ${value} has no default evaluation`);
    const evaluation = this.#evaluation(id);

    assert(evaluation.value === value, `evaluation ${id} does not produce value ${value}`);
    assert(evaluation.kind === "join", `value ${value} is not a join output`);
    assert(evaluation.anchor === anchor, `join output ${value} completed outside its anchor`);
    assert(evaluation.local !== undefined, `join output ${value} has no scheduled local`);
    assert(this.#emitted[id] === 0, `join output ${value} was emitted twice`);
    this.#emitted[id] = 1;
  }

  loopInputLocal(value: WasmValueId): number {
    const local = this.#schedule.loopInputLocals[value];

    assert(local !== undefined, `loop input ${value} has no local`);
    return this.#resolveLocal(local);
  }

  variableLocal(variable: VariableRef): number {
    const local = this.#schedule.variableLocals.get(variable);

    assert(local !== undefined, "variable has no scheduled local");
    return this.#resolveLocal(local);
  }

  assertComplete(): void {
    const missing: number[] = [];

    for (let id = 0; id < this.#schedule.evaluations.length; id += 1) {
      if (this.#emitted[id] === 0) {
        missing.push(id);
      }
    }

    assert(missing.length === 0, `scheduled evaluations were never emitted: ${missing.join(", ")}`);
  }

  #emitCapturesAt(site: SiteId): void {
    for (const id of this.#schedule.captures[site] ?? []) {
      this.#capture(id, site);
    }
  }

  #capture(id: EvaluationId, deadline: SiteId): void {
    const evaluation = this.#evaluation(id);
    const site = this.#currentSite();

    assert(
      site === deadline && evaluation.kind === "capture" && evaluation.anchor === deadline,
      `evaluation ${id} of value ${evaluation.value} has the wrong capture deadline`
    );
    assert(this.#emitted[id] === 0, `evaluation ${id} was emitted twice`);
    this.#emitEvaluationSource(id);
    this.#writer.write(wasmInstruction.local.set, this.#evaluationLocal(id));
    this.#emitted[id] = 1;
  }

  #emitEvaluationSource(id: EvaluationId): void {
    const evaluation = this.#evaluation(id);

    if (!this.#tryEmitFusedSignedLoad(evaluation)) {
      this.#emitSource(evaluation);
    }
  }

  // A no-local at-use input is established by scheduling to have exactly one
  // use, so consuming it here cannot steal a load from another evaluation.
  #tryEmitFusedSignedLoad(evaluation: WasmEvaluation): boolean {
    const node = this.#body.values.node(evaluation.value);

    if (node.kind !== "unary") {
      return false;
    }
    let width: 8 | 16;

    switch (node.operator) {
      case "extend8_s":
        width = 8;
        break;
      case "extend16_s":
        width = 16;
        break;
      default:
        return false;
    }
    assert(
      evaluation.kind === "atUse" || evaluation.kind === "capture",
      `signed extension has invalid ${evaluation.kind} placement`
    );
    const input = node.inputs[0];
    const inputId = evaluationForUse(this.#schedule, input, evaluation.anchor);

    if (inputId === undefined) {
      return false;
    }
    const inputEvaluation = this.#evaluation(inputId);
    const operationSite = inputEvaluation.operationSite;

    if (operationSite === undefined) {
      return false;
    }
    const operation = this.#body.sites[operationSite]?.event;

    assert(operation !== undefined, `unknown operation site ${operationSite}`);
    if (
      inputEvaluation.value !== input ||
      operation.kind !== "load" ||
      operation.output !== input ||
      operation.storageWidth !== width ||
      inputEvaluation.kind !== "atUse" ||
      inputEvaluation.anchor !== evaluation.anchor ||
      inputEvaluation.local !== undefined
    ) {
      return false;
    }
    assert(this.#emitted[inputId] === 0, `fused load evaluation ${inputId} was emitted twice`);
    emitWasmOperation(this.#writer, this.#bindings, this, operation, "signed");
    this.#emitted[inputId] = 1;
    return true;
  }

  #emitSource(evaluation: WasmEvaluation): void {
    const { value } = evaluation;

    switch (wasmValueSource(this.#body.values.node(value))) {
      case "output": {
        const producer = evaluation.operationSite;

        assert(producer !== undefined, `producer output ${value} has no producer`);
        const event = this.#body.sites[producer]?.event;

        assert(event !== undefined, `unknown producer site ${producer}`);
        this.#emitOutputOperation(event, value);
        return;
      }
      case "expression":
        this.#emitValue(value);
        return;
      case "inline":
        assert(false, `value ${value} cannot have a scheduled source`);
    }
  }

  #emitOutputOperation(event: BodyEvent, value: WasmValueId): void {
    switch (event.kind) {
      case "load":
      case "variableRead":
      case "call":
        assert(event.output === value, `operation does not produce value ${value}`);
        emitWasmOperation(this.#writer, this.#bindings, this, event);
        return;
      default:
        assert(false, `${event.kind} event cannot produce a value`);
    }
  }

  #emitValue(value: WasmValueId): void {
    const node = this.#body.values.node(value);

    for (const input of node.inputs) {
      this.emitUse(input);
    }

    if (node.kind === "producerOutput") {
      assert(false, `producer output ${value} must emit through its producer`);
    }
    if (node.kind === "loopInput") {
      this.#writer.write(wasmInstruction.local.get, this.loopInputLocal(value));
      return;
    }
    emitWasmValueInstruction(this.#writer, node);
  }

  #evaluation(id: EvaluationId): WasmEvaluation {
    const evaluation = this.#schedule.evaluations[id];

    assert(evaluation !== undefined, `unknown evaluation ${id}`);
    return evaluation;
  }

  #evaluationLocal(id: EvaluationId): number {
    const local = this.#evaluation(id).local;

    assert(local !== undefined, `evaluation ${id} has no scheduled local`);
    return this.#resolveLocal(local);
  }

  #currentSite(): SiteId {
    const site = this.#site;

    assert(site !== undefined, "value emission occurred outside a schedule site");
    return site;
  }
}

function capturesAfterOperands(event: BodyEvent): boolean {
  return event.kind === "if" || event.kind === "switch" || event.kind === "loop";
}
