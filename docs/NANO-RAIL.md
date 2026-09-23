# A feeless settlement companion: Nano (XNO)

This facilitator lets an HTTP API get paid in **USDs on Arbitrum** and **USDC on
Arbitrum and Base**. Every settle is a signed `transferWithAuthorization`
(USDC) or a Permit2 witness transfer (USDs) against a token contract, which
burns L2 gas per payment.

For sub-cent-per-call pricing that gas is not noise — it is a real, per-call
cost that the buyer or facilitator eats on every settlement. This note is a
side-by-side of that cost against a **feeless** settlement rail, so a
deployment that cares about total cost-to-value has a second option.

## Settlement cost, side by side

| Scenario ($0.01 call) | settle cost/call | % of the $0.01 price |
|---|---|---|
| x402 gateway settle (dev.to) | ~$0.00150 | ~15% |
| ERC-20 transfer upper bound (65k gas) | ~$0.00195 | ~19% |
| Real $0.013 settle, actual receipt | $0.00144 | ~11% of its value |
| Median Base gas, x402 data window | ~$0.006 | ~60% of a $0.01 call |

Sources, not estimates:
- 50,000 gas settle + gas-spike warning: dev.to/whiteknightonhorse/what-happens-to-the-0001-when-an-ai-agent-pays-for-an-api-call-389a
- Real $0.00144 settle on an $0.013 payment (~11% gas-to-value): blokz.dev/articles/x402-agent-payments-dissected
- Median 0.04 gwei, "for a $0.001 payment the gas costs more than the payment": proofoftech.org/blog/x402-economy

So at $0.01/call the USDC/USDs rail costs roughly 11–60% of the price in
settlement gas, and an agent draining a whole batch pays it per call.

## The same paid call on Nano (XNO) — zero

Nano is a layer-1 block-lattice: zero protocol fees (no gas, no validator or
miner to pay) and ~0.3 s confirmed finality. The x402 `exact` scheme already
has a Nano dialect — a pure ED25519 send — so the buyer's flow is unchanged;
only the settle stops costing anything.

| Rail | settle cost/call | 100 calls | finality |
|---|---|---|---|
| USDC on Base | ~$0.0015–0.006 | ~$0.15–0.60 | ~2 s (L2 batch) |
| USDs on Arbitrum | similar gas | similar | ~1–2 s (L2 batch) |
| Nano (XNO) | $0.000000 | $0.00 | ~0.3 s confirmed |

## On-chain evidence the buyer side already works

An OpenAI-Agents-SDK agent (a thin adapter on the MIT-licensed `feeless402`
client) settled a real third-party x402 seller on 2026-09-18 in
**0.00001292 XNO** — block
`E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3`,
`confirmed: true` on the Nano network (query it at `rpc.nano.to` or
`nanexplorer.com/nano/block/...`).

A facilitator that settles in Nano instead of (or beside) USDs/USDC gives its
sellers a per-call cost of zero, at confirmed finality in under a second, with
no gas sponsorship and no ERC-3009/Permit2 plumbing to maintain. The x402
request/verify/settle flow is otherwise identical.
