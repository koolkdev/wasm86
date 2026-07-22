# Test ownership

Architectural instruction behavior has one home: `test/instructions`. These
suites execute production decode, Core semantics, Memory access, and compiler
output through `test/harness/compiled-instruction.ts`. Their assertions are
limited to architectural state, memory, completion, fault ordering, restart
state, and partial progress.

The instruction suites are divided by behavior:

- `mov-register`, `mov-memory`, `nop`, `flags`, and `alu` own scalar state and
  arithmetic;
- `shift-rotate`, `multiply-divide`, and `decimal` own the remaining scalar
  arithmetic families;
- `bits` and `exchange` own bit-string, scan, swap, and compare-exchange
  behavior;
- `addressing` and `control` own effective addresses and near control flow;
- `stack` and `compound-stack` own ordinary and multi-cell stack behavior;
- `strings` and `rep-strings` own string units, repetition, faults, and resume;
  and
- `system` owns the current instruction-level exceptions and typed host
  requests.

Component suites retain only contracts owned by that component:

- Decoder tests own byte consumption, prefix and ModRM/SIB binding, immediate
  decoding, and decode-time exception classification.
- Core ISA tests own definition-table shape, form expansion, and table lint.
- Compiler tests own validation, expression and control lowering, placement,
  resource binding, and executed compiler-specific contracts.
- Memory tests own range validation, access intent, and fault authority.
- Interpreter tests own prefix replacement, invalid/truncated dispatch,
  dynamic binding, fetch behavior, redispatch, and deadline policy.
- JIT tests own block boundaries, copied-byte identity, snapshots, artifact
  metadata, and dispatch-tail-call policy.
- CPU and Machine tests own resource lifetime, the public run boundary,
  instruction budgets, and exit-envelope classification.
- Encoder tests may assert exact bytes because encoding is their observable
  result.

The former semantic-trace oracle and legacy instruction-fixture inventory are
not behavioral owners and must not be reintroduced. A frontend may keep one
small integration case, but architectural family matrices belong in
`test/instructions`.
