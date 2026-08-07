import { assert } from "#common/assert.js";
import {
  controlCompletes,
  type Control,
  type IfControl,
  type LoopContinueControl,
  type LoopControl,
  type ReturnControl,
  type SwitchControl
} from "#compiler/ir/controls/index.js";
import { invocationInputs, type CallTarget } from "#compiler/ir/invocation.js";
import { regionCompletes, type Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ModuleBindings } from "#compiler/wasm/module/bindings.js";
import type { PlacementPlan } from "#compiler/wasm/legacy/placement/model.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import { createFunctionFrame } from "./frame.js";
import type { ValueEmitter } from "./values.js";

export function createControlEmitter({
  body,
  bindings,
  plan,
  valueEmitter,
  emitBody
}: Readonly<{
  body: WasmInstructionWriter;
  bindings: ModuleBindings;
  plan: PlacementPlan;
  valueEmitter: ValueEmitter;
  emitBody: (body: Region, resultLocal?: number) => void;
}>): (control: Control) => void {
  const frame = createFunctionFrame({ body });
  // The innermost open loop's Wasm locals, aligned with its carried values.
  const loopLocals: (readonly number[])[] = [];

  function emitControl(control: Control): void {
    switch (control.kind) {
      case "if":
        emitIf(control);
        return;
      case "switch":
        emitSwitch(control);
        return;
      case "loop":
        emitLoop(control);
        return;
      case "loopContinue":
        emitLoopContinue(control);
        return;
      case "return":
        emitReturn(control);
        return;
    }
  }

  function emitIf(control: IfControl): void {
    withControlOutput(control.output, (outputLocal) => {
      valueEmitter.emitUse(control.condition);
      valueEmitter.emitCaptures();
      body.write(wasmInstruction.control.if, { hint: control.hint });
      frame.withNestedControl(() => {
        emitBody(control.thenBody, outputLocal);

        if (control.elseBody !== undefined) {
          body.write(wasmInstruction.control.else);
          emitBody(control.elseBody, outputLocal);
        } else {
          assert(control.output === undefined, "value-producing if has no else body");
        }
      });
      body.write(wasmInstruction.control.end);
    });

    sealJoin(control);
  }

  function emitSwitch(control: SwitchControl): void {
    withControlOutput(control.output, (outputLocal) => {
      const caseCount = control.cases.length;

      // Open order: join, default, case n-1 .. case 0.
      for (let index = 0; index <= caseCount + 1; index += 1) {
        body.write(wasmInstruction.control.block);
      }

      valueEmitter.emitUse(control.selector);
      valueEmitter.emitCaptures();
      body.write(wasmInstruction.control.brTable, switchLabelDepths(control.cases), caseCount);

      control.cases.forEach((entry, index) => {
        body.write(wasmInstruction.control.end);
        frame.withNestedControl(() => emitBody(entry.body, outputLocal), caseCount - index + 1);
        body.write(wasmInstruction.control.br, caseCount - index);
      });

      body.write(wasmInstruction.control.end);
      frame.withNestedControl(() => emitBody(control.defaultBody, outputLocal), 1);
      body.write(wasmInstruction.control.end);
    });

    sealJoin(control);
  }

  function emitLoop(control: LoopControl): void {
    const carriedLocals = control.carried.map((value) => {
      const local = valueEmitter.valueLocal(value.loopInput);

      valueEmitter.emitUse(value.seed);
      body.write(wasmInstruction.local.set, local);
      return local;
    });

    valueEmitter.emitCaptures();
    body.write(wasmInstruction.control.loop);
    loopLocals.push(carriedLocals);
    try {
      frame.withLoopBody(() => emitBody(control.body));
    } finally {
      assert(loopLocals.pop() === carriedLocals, "loop local stack changed");
    }
    body.write(wasmInstruction.control.end);
  }

  function emitLoopContinue(control: LoopContinueControl): void {
    const carriedLocals = loopLocals[loopLocals.length - 1];

    assert(carriedLocals !== undefined, "loopContinue control outside any loop body");
    assert(
      control.updates.length === carriedLocals.length,
      "loopContinue updates do not align with the loop's carried values"
    );
    // Compute every update before overwriting any carried local.
    for (const update of control.updates) {
      valueEmitter.emitUse(update);
    }
    for (let index = carriedLocals.length - 1; index >= 0; index -= 1) {
      body.write(wasmInstruction.local.set, carriedLocals[index]!);
    }
    frame.emitLoopContinue();
  }

  function emitReturn(control: ReturnControl): void {
    switch (control.source.kind) {
      case "values":
        for (const value of control.source.values) {
          valueEmitter.emitUse(value);
        }
        body.write(wasmInstruction.control.return);
        return;
      case "invocation": {
        const { invocation } = control.source;

        for (const input of invocationInputs(invocation)) {
          valueEmitter.emitUse(input.value);
        }
        emitReturnCall(body, bindings, invocation.target);
        return;
      }
    }
  }

  function withControlOutput(
    output: ValueId | undefined,
    emit: (outputLocal: number | undefined) => void
  ): void {
    if (output === undefined) {
      emit(undefined);
      return;
    }

    const outputPlacement = plan.values[output];

    assert(
      outputPlacement === undefined || outputPlacement.kind === "control",
      `control output ${output} has the wrong placement`
    );
    const outputLocal = outputPlacement === undefined ? undefined : valueEmitter.valueLocal(output);

    emit(outputLocal);
    if (outputLocal !== undefined) {
      valueEmitter.markControlOutput(output);
    }
  }

  function sealJoin(control: IfControl | SwitchControl): void {
    if (!controlCompletes(control, { regionCompletes })) {
      return;
    }

    // Wasm cannot infer that every lowered arm exits through its nested
    // control flow, so make the structured join explicitly unreachable.
    body.write(wasmInstruction.control.unreachable);
  }

  return emitControl;
}

function switchLabelDepths(cases: SwitchControl["cases"]): number[] {
  let size = 0;

  for (const entry of cases) {
    for (const match of entry.matches) {
      size = Math.max(size, match + 1);
    }
  }
  const table = new Array<number>(size).fill(cases.length);

  for (const [depth, entry] of cases.entries()) {
    for (const match of entry.matches) {
      table[match] = depth;
    }
  }
  return table;
}

function emitReturnCall(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  target: CallTarget
): void {
  switch (target.kind) {
    case "direct":
      body.write(wasmInstruction.returnCall.direct, bindings.functionIndex(target.ref));
      return;
    case "indirect":
      body.write(
        wasmInstruction.returnCall.indirect,
        bindings.typeIndex(target.type),
        bindings.tableIndex(target.table)
      );
      return;
  }
}
