import { leaSemantic } from "../lea.js";

export function leaSemanticTypeContract(): void {
  leaSemantic(16);
  leaSemantic(32);

  // @ts-expect-error LEA has no byte form.
  leaSemantic(8);
  // @ts-expect-error an LEA form must state its architectural width.
  leaSemantic();
}
