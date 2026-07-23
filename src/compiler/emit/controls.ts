import { assert } from "#common/assert.js";
import type {
  Control,
  IfControl,
  LoopContinueControl,
  LoopControl,
  ReturnControl,
  SwitchControl
} from "#compiler/ir/controls/index.js";
import { regionCompletes, type Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";
import type { PlacementPlan } from "#compiler/placement/model.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import {
  createFunctionFrame,
  emitReturnCall
} from "./context.js";
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
  // The innermost open loop's actual Wasm locals, aligned with its cells.
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
      body.ifBlock({ hint: control.hint });
      frame.withNestedControl(() => {
        emitBody(control.thenBody, outputLocal);

        if (control.elseBody !== undefined) {
          body.elseBlock();
          emitBody(control.elseBody, outputLocal);
        } else {
          assert(control.output === undefined, "value-producing if has no else body");
        }
      });
      body.endBlock();
    });

    sealJoin(control);
  }

  function emitSwitch(control: SwitchControl): void {
    withControlOutput(control.output, (outputLocal) => {
      const caseCount = control.cases.length;

      // Open order: join, default, case n-1 .. case 0.
      for (let index = 0; index <= caseCount + 1; index += 1) {
        body.block();
      }

      valueEmitter.emitUse(control.selector);
      valueEmitter.emitCaptures();
      body.brTable(switchLabelDepths(control.cases), caseCount);

      control.cases.forEach((entry, index) => {
        body.endBlock();
        frame.withNestedControl(
          () => emitBody(entry.body, outputLocal),
          caseCount - index + 1
        );
        body.br(caseCount - index);
      });

      body.endBlock();
      frame.withNestedControl(
        () => emitBody(control.defaultBody, outputLocal),
        1
      );
      body.endBlock();
    });

    sealJoin(control);
  }

  function emitLoop(control: LoopControl): void {
    const carriedLocals = control.carried.map((cell) => {
      const local = valueEmitter.valueLocal(cell.loopInput);

      valueEmitter.emitUse(cell.seed);
      body.localSet(local);
      return local;
    });

    valueEmitter.emitCaptures();
    body.loop();
    loopLocals.push(carriedLocals);
    try {
      frame.withLoopBody(() => emitBody(control.body));
    } finally {
      assert(loopLocals.pop() === carriedLocals, "loop local stack changed");
    }
    body.endBlock();
  }

  function emitLoopContinue(control: LoopContinueControl): void {
    const carriedLocals = loopLocals[loopLocals.length - 1];

    assert(carriedLocals !== undefined, "loopContinue control outside any loop body");
    assert(
      control.updates.length === carriedLocals.length,
      "loopContinue updates do not align with the loop's cells"
    );
    // Compute every update before overwriting any carried cell.
    for (const update of control.updates) {
      valueEmitter.emitUse(update);
    }
    for (let index = carriedLocals.length - 1; index >= 0; index -= 1) {
      body.localSet(carriedLocals[index]!);
    }
    frame.emitLoopContinue();
  }

  function emitReturn(control: ReturnControl): void {
    switch (control.source.kind) {
      case "values":
        for (const value of control.source.values) {
          valueEmitter.emitUse(value);
        }
        body.returnFromFunction();
        return;
      case "invocation":
        control.source.invocation.emitInputs(valueEmitter);
        emitReturnCall(body, bindings, control.source.invocation.target);
        return;
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
    const outputLocal = outputPlacement === undefined
      ? undefined
      : valueEmitter.valueLocal(output);

    emit(outputLocal);
    if (outputLocal !== undefined) {
      valueEmitter.markControlOutput(output);
    }
  }

  function sealJoin(control: IfControl | SwitchControl): void {
    if (!control.completes({ regionCompletes })) {
      return;
    }

    // Wasm cannot infer that every lowered arm exits through its nested
    // control flow, so make the structured join explicitly unreachable.
    body.unreachable();
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
