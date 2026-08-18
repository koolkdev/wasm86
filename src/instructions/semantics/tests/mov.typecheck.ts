import { cmovSemantic, movsxSemantic, movzxSemantic } from "../mov.js";

export function movSemanticTypeContract(sourceWidth: 8 | 16): void {
  movzxSemantic(8, 16);
  movzxSemantic(8, 32);
  movzxSemantic(16, 32);
  movsxSemantic(8, 16);
  movsxSemantic(8, 32);
  movsxSemantic(16, 32);
  movzxSemantic(sourceWidth, 32);
  movsxSemantic(sourceWidth, 32);
  cmovSemantic("E", 16);
  cmovSemantic("E", 32);

  // @ts-expect-error a word source cannot be extended to a word.
  movzxSemantic(16, 16);
  // @ts-expect-error a word source cannot be extended to a word.
  movsxSemantic(16, 16);
  // @ts-expect-error a word target is unsafe until the source is known to be a byte.
  movzxSemantic(sourceWidth, 16);
  // @ts-expect-error a word target is unsafe until the source is known to be a byte.
  movsxSemantic(sourceWidth, 16);
  // @ts-expect-error CMOV has no byte form.
  cmovSemantic("E", 8);
  // @ts-expect-error a CMOV form must state its architectural width.
  cmovSemantic("E");
}
