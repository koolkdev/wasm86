import { buildDefinition } from "#build";
import { BodyEvent, siteId } from "#compiler/wasm/function/body.js";
import type { WasmFunctionPlan } from "#compiler/wasm/plan/function.js";
import {
  encodeWasmFunctionBody,
  type EncodedWasmFunctionBody,
  type WasmLocalResolver
} from "#wasm/encoder/function-body.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import type { WasmFunctionBindings } from "./bindings.js";
import { WasmControlEmitter } from "./control.js";
import { emitWasmOperation } from "./operation.js";
import { ValueEmitter } from "./value.js";

type WasmFunctionInstructionContext = Readonly<{
  writer: WasmInstructionWriter;
  bindings: WasmFunctionBindings;
  resolveLocal: WasmLocalResolver;
}>;

// Binding-aware function emission is the boundary between the symbolic plan
// and the encoder's concrete function body.
export function emitWasmFunctionBody(
  plan: WasmFunctionPlan,
  bindings: WasmFunctionBindings
): EncodedWasmFunctionBody {
  return encodeWasmFunctionBody(
    {
      parameterCount: plan.body.parameterCount,
      localTypes: plan.schedule.localTypes
    },
    (writer, resolveLocal) => {
      emitWasmFunctionInstructions(plan, { writer, bindings, resolveLocal });
    }
  );
}

// One pass over the canonical site stream. Block ends carry all structure the
// control emitter needs, so emission does not rebuild or recursively walk the body.
function emitWasmFunctionInstructions(
  plan: WasmFunctionPlan,
  context: WasmFunctionInstructionContext
): void {
  const { body, schedule } = plan;
  const { writer, bindings, resolveLocal } = context;
  const values = new ValueEmitter({ writer, bindings, body, schedule, resolveLocal });
  const controls = new WasmControlEmitter({ writer, bindings, values });

  for (const [rawSite, record] of body.sites.entries()) {
    const site = siteId(rawSite);
    const { event } = record;

    values.beginSite(site, event);
    switch (event.kind) {
      case "if":
      case "switch":
      case "loop":
      case "loopContinue":
      case "return":
      case "returnCall":
        controls.emit(event, site);
        break;
      case "end":
        if (record.block !== body.entryBlock) {
          controls.end(event, record.block);
        }
        break;
      case "load":
      case "store":
      case "variableRead":
      case "variableWrite":
      case "call":
        if (schedule.operationsAtAuthoredSite[site] !== 0) {
          emitWasmOperation(writer, bindings, values, event);
          if (BodyEvent.describe(event).output !== undefined) {
            writer.write(wasmInstruction.parametric.drop);
          }
        }
        break;
    }
  }

  if (buildDefinition.validation) {
    controls.assertComplete();
    values.assertComplete();
  }
}
