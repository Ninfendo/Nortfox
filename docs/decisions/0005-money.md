# 5. Money

Status: accepted, 2026-11-01. Amended 2026-11-02: the compatible API takes amounts and exchange rates in the established API's forms.

## Context

A JavaScript number is a binary float: `0.1 + 0.2` is not `0.3`. In accounting, one öre wrong is wrong.

## Decision

- Inside NortFox, an amount is a whole number of the currency's minor unit, held as a `bigint`: öre for SEK. Other currencies use their own minor unit from ISO 4217.
- In PostgreSQL, amounts are `bigint` columns.
- On the native API (`/v1`), an amount is a decimal string with a currency code, for example `{"amount": "1234.50", "currency": "SEK"}`. It has no more decimals than the currency has. A JSON number is refused.
- The compatible API ([decision 12](0012-compatible-api.md)) takes and gives amounts in the forms that the established API uses, endpoint by endpoint:
  - It takes an amount as a JSON number, and also as a string where the established endpoint takes one. The established voucher endpoint takes both, such as `200.50` and `"200.50"`.
  - In its answers, each amount has the form that the established endpoint gives it. That is mostly a JSON number, but some answers give a string.
  - It reads each amount from its own text in the request, never through a float, and writes each one in its answers from the exact value.
  - The established API rounds some amounts that have more decimals than it keeps. Each slice's issue records how its established endpoints round, and the compatible endpoint does the same.
- A voucher row has one signed amount: debit is positive, credit is negative, as in SIE.
- On the native API, exchange rates are decimal strings too, never numbers.
- The compatible API takes and gives an exchange rate in the forms that the established API uses, as it does an amount. It reads the rate like an amount, from its own text, never through a float. The same holds for any other exact decimal in the established API.
- Rounding happens in one place, `packages/engine`, with one named rule for each case (VAT, currency conversion, accruals).
- An amount is never a JavaScript number, anywhere. Nor is an exchange rate.

## Consequences

- Sums are exact. A balance is a sum of `bigint` values.
- Every client of the native API must read decimal strings. The generated client keeps them as strings.
- The compatible API cannot use a plain JSON parser on a request with money or an exchange rate in it, because that parser turns every number into a float. It reads the raw request text.
- TypeScript refuses to mix `bigint` and `number`, and the lint rule `restrict-plus-operands` catches an amount glued to a string.
- Display formats such as `1 234,50 kr` come from `packages/i18n`. Until `packages/i18n` exists ([plan, slice 2d](../plan.md#step-2-the-foundation)), the Swedish form of an amount (`formatSwedish` and `parseSwedish`) sits in `packages/engine`. The slice that adds `packages/i18n` moves it there, and the engine then keeps only the wire form.
