import type { ConditionCode, FlagProducerName, IrFlagSetOp } from "./types.js";

export type IrFlagProducerConditionKind =
  | "eq"
  | "ne"
  | "uLt"
  | "uGe"
  | "sLt"
  | "sGe"
  | "sLe"
  | "sGt"
  | "zero"
  | "nonZero"
  | "sign"
  | "notSign"
  | "parity8"
  | "notParity8"
  | "constTrue"
  | "constFalse"
  | "zeroOrSign"
  | "nonZeroAndNotSign";

export type FlagProducerConditionDescriptor = Readonly<{
  cc: ConditionCode;
  producer: FlagProducerName;
  width?: IrFlagSetOp["width"];
}>;

export function flagProducerConditionKind(
  condition: FlagProducerConditionDescriptor
): IrFlagProducerConditionKind | undefined {
  if (condition.producer === "logic") {
    switch (condition.cc) {
      case "O":
      case "B":
        return "constFalse";
      case "NO":
      case "AE":
        return "constTrue";
      case "E":
      case "BE":
        return "zero";
      case "NE":
      case "A":
        return "nonZero";
      case "S":
      case "L":
        return "sign";
      case "NS":
      case "GE":
        return "notSign";
      case "P":
        return "parity8";
      case "NP":
        return "notParity8";
      case "LE":
        return "zeroOrSign";
      case "G":
        return "nonZeroAndNotSign";
    }
  }

  if (condition.producer === "sub") {
    switch (condition.cc) {
      case "E":
        return "eq";
      case "NE":
        return "ne";
      case "B":
        return "uLt";
      case "AE":
        return "uGe";
      case "L":
        return "sLt";
      case "GE":
        return "sGe";
      case "LE":
        return "sLe";
      case "G":
        return "sGt";
    }
  }

  if (!producerHasResultInput(condition.producer)) {
    return undefined;
  }

  switch (condition.cc) {
    case "E":
      return "zero";
    case "NE":
      return "nonZero";
    case "S":
      return "sign";
    case "NS":
      return "notSign";
    case "P":
      return "parity8";
    case "NP":
      return "notParity8";
    default:
      return undefined;
  }
}

function producerHasResultInput(producer: FlagProducerName): boolean {
  return producer === "add" ||
    producer === "sub" ||
    producer === "logic" ||
    producer === "inc" ||
    producer === "dec";
}
