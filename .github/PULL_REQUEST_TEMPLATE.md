## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Why?

<!-- What problem does it solve? -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour has a test that fails without this change

## Spec fidelity

<!-- See CONTRIBUTING.md. Delete this section only if the change touches no request. -->

- [ ] Sends no field the v4 specification does not define
- [ ] Calls no path or verb the specification does not define
- [ ] Field names match the specification, differing only in casing
- [ ] `src/types.gen.ts` was not edited by hand

## If this touches ordering, resending, or cancelling

<!-- Delete if it does not. -->

- [ ] Adds no automatic retry to `/v4/Order`, `/v4/Resend`, or `/v4/Cancel`
- [ ] Amounts stay integers in minor units
- [ ] No voucher code can reach a log or an error message
- [ ] The CLI remains read-only
