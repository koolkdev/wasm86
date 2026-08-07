import { assert } from "#common/assert.js";
import { bodyEvent, type SiteId, type WasmBody } from "#compiler/wasm/function/body.js";
import { type EvaluationId, type WasmSchedule } from "./schedule.js";

export type WasmInstructionFusion = Readonly<{
  kind: "signedLoad";
  inputEvaluation: EvaluationId;
  operationSite: SiteId;
}>;

// Called while the private schedule draft is being completed. Every guard can
// read final placement and local decisions; consumers receive only the
// completed schedule.
export function selectWasmInstructionFusion(
  body: WasmBody,
  schedule: WasmSchedule,
  id: EvaluationId
): WasmInstructionFusion | undefined {
  const evaluation = schedule.evaluations[id];

  assert(evaluation !== undefined, `unknown evaluation ${id}`);
  const node = body.values.node(evaluation.value);

  if (node.kind !== "unary") {
    return undefined;
  }
  const width = signedExtensionWidth(node.operator);

  if (width === undefined) {
    return undefined;
  }

  assert(
    evaluation.kind === "atUse" || evaluation.kind === "capture",
    `signed extension evaluation ${id} has invalid ${evaluation.kind} placement`
  );
  const input = node.inputs[0];
  const inputId =
    schedule.useOverrides[evaluation.anchor]?.get(input) ?? schedule.defaultEvaluations[input];

  if (inputId === undefined) {
    return undefined;
  }
  const inputEvaluation = schedule.evaluations[inputId];

  assert(inputEvaluation !== undefined, `unknown input evaluation ${inputId}`);
  const operationSite = inputEvaluation.operationSite;
  const operation = operationSite === undefined ? undefined : bodyEvent(body, operationSite);

  if (
    operationSite === undefined ||
    inputEvaluation.value !== input ||
    operation?.kind !== "load" ||
    operation.width !== width ||
    inputEvaluation.kind !== "atUse" ||
    inputEvaluation.anchor !== evaluation.anchor ||
    inputEvaluation.local !== undefined ||
    inputEvaluation.uses.length !== 1
  ) {
    return undefined;
  }
  return {
    kind: "signedLoad",
    inputEvaluation: inputId,
    operationSite
  };
}

function signedExtensionWidth(operator: string): 8 | 16 | undefined {
  switch (operator) {
    case "extend8_s":
      return 8;
    case "extend16_s":
      return 16;
    default:
      return undefined;
  }
}
