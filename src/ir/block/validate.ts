import type {
  BlockRegisterAccess,
  BlockWalkResult
} from "#ir/block/walk/index.js";

type RegisterWriteAccess = Extract<
  BlockRegisterAccess,
  Readonly<{ kind: "registerWrite" | "dynamicRegisterStore" }>
>;

type DynamicRegisterStoreAccess = Extract<
  BlockRegisterAccess,
  Readonly<{ kind: "dynamicRegisterStore" }>
>;

export function validateBlockWalkResult(result: BlockWalkResult): void {
  let firstRegisterWrite: RegisterWriteAccess | undefined;
  let firstDynamicRegisterStore: DynamicRegisterStoreAccess | undefined;

  for (const access of result.registerAccesses) {
    switch (access.kind) {
      case "registerRead":
        if (firstDynamicRegisterStore !== undefined) {
          throw new Error(
            `${registerReadDescription(access)} after dynamic register store at op ` +
            `${firstDynamicRegisterStore.at.opIndex} is unsupported by the shared block pipeline ` +
            `at op ${access.at.opIndex}`
          );
        }
        break;
      case "registerWrite":
        if (firstDynamicRegisterStore !== undefined) {
          throw new Error(
            `register write after dynamic register store at op ` +
            `${firstDynamicRegisterStore.at.opIndex} is unsupported by the shared block pipeline ` +
            `at op ${access.at.opIndex}`
          );
        }
        firstRegisterWrite ??= access;
        break;
      case "dynamicRegisterLoad":
        if (firstRegisterWrite !== undefined) {
          throw new Error(
            `dynamic register load after register write at op ${firstRegisterWrite.at.opIndex} ` +
            `is unsupported by the shared block pipeline at op ${access.at.opIndex}`
          );
        }
        break;
      case "dynamicRegisterStore":
        firstRegisterWrite ??= access;
        firstDynamicRegisterStore ??= access;
        break;
    }
  }
}

function registerReadDescription(
  access: Extract<BlockRegisterAccess, Readonly<{ kind: "registerRead" }>>
): string {
  return access.reason === "partialRegisterWrite"
    ? "partial register write"
    : "register read";
}
