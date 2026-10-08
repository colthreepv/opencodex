# Model Cost Overrides

`providers.<name>.modelCosts.<modelId>` holds a manual price row: four absolute USD-per-1M-token rates (`input`, `output`, `cacheRead`, `cacheWrite`). An optional `promptPricing` field chooses the prompt-size band.

- Absent or `{"policy":"automatic"}`: legacy behavior. The vendor long-context multiplier applies atop the manual base rates.
- `{"policy":"flat"}`: disables the automatic context band. Priority/Fast handling is unchanged.
- `{"policy":"custom","threshold":N,"comparison":"gt"|"gte","input":…,"output":…,"cacheRead":…,"cacheWrite":…}`: the four absolute rates replace the automatic band once the threshold is crossed. Below it the base rates apply with no band. `threshold` is a positive safe integer.

Band selection uses raw `usage.inputTokens`, which includes cache reads and writes. Output tokens never count. A crossed band reprices the whole request. A custom band replaces the automatic multiplier, so the two never multiply.

Priority interacts with a custom band through the provider's published relation. `stack` applies the priority multiplier on top of the band. `exclusive` keeps the base rate when the response confirms priority. `lower-bound` applies the band, flags the estimate as a lower bound under confirmed priority, and skips the multiplier. A model with no published relation keeps its provider priority rule, because custom rates are standard-speed rates.

A management PUT replaces the whole row, so a write without `promptPricing` drops a stored policy. `cost: null` deletes the whole row, policy included. `ocx models set-price` in `src/cli/models-runtime.ts` reads the current row and carries its policy forward on base-rate writes; `--auto` removes the row. Malformed policies are rejected on both read and write. The overlay registry refreshes when a policy changes, even when the four rates do not.
