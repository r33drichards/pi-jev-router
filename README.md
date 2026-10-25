# pi-jev-router

Standalone TypeScript routing core for a Pi IRC host. Given an incoming message, recent channel history, and recent Pi context, it selects `ignore`, `queue`, or `interrupt`. It ships with synthetic tests and a fake-host contract. **It is not installed or integrated into deployed Pi.**

Live inference is disabled by default. There is no network client, credential discovery, telemetry, or stored conversation history. No license has been selected. The npm package has `private: true` to prevent accidental npm publication; this does not restrict GitHub repository visibility.

## Setup

Use Node 22 or newer:

```sh
npm ci --ignore-scripts
npm run check
npm run example
npm run build
```

Import `Router`, `pack`, `Coordinator`, and the `Host` interface from the built package. `examples/synthetic.mjs` demonstrates a fully offline mock. Production callers must provide authenticated, validated messages and bounded, oldest-first history arrays. Use one coordinator per host session and discard it when that session ends. Hosts must bound active channel count, snapshot size, and snapshot/apply latency; the coordinator bounds pending arrivals per channel to 100 by default.

## Context budget

[TypeSafe models](https://docs.typesafe.ai/models), checked 2026-10-25, specifies `jev-1.14.0`, a default 64k request limit and a 32k limit for state plus each question. This package sends one Choice question and caps its budget at **32,000** (conservatively interpreting 32k). It never opts into the 262k long-context mode.

`pack` first measures the complete request with empty history: incoming message, routing instructions, criteria/schema, state envelope, and meter-defined framing. It splits the remainder equally between channel and Pi history, leaving an odd unit unused. Each side gets its newest contiguous suffix of complete entries. If the next older entry does not fit, selection stops for that side. An oversized newest entry therefore leaves that side empty. Unused capacity is not borrowed, and history is never fabricated or truncated. The combined request is checked after each addition and once more before return. Arrays must exclude the incoming message and be scoped to the current channel/session.

**Token accuracy is an explicit integration requirement.** The bundled `offlineMeter` measures UTF-8 JSON bytes plus 512 sizing units. These are estimates for offline planning, not exact Jev tokens or a proven upper bound. Unicode, escaping, and provider-side rendering can change tokenization. No exact Jev tokenizer/framing contract was established from the cited documentation. Consequently the router refuses live adapters with this meter, even when `enableLive` is true.

A production `Meter` must supply a validated upper bound for the provider's complete state-plus-question tokenization, including framing, pinned to this model. Its `assurance: 'verified-upper-bound'` is an implementer's assertion, not verification performed by this library. Do not relabel the estimate to bypass the gate. An accurate provider-backed meter can fill each half more closely; whole-entry granularity may still leave space. If overhead alone exceeds the limit, the router returns `ignore/error` without calling the adapter. The hard actual-token guarantee for live use depends on fulfilling this meter contract.

## TypeSafe adapter and failures

The [Choice API](https://docs.typesafe.ai/primitives/choice) accepts `state`, `model`, and `questions`; responses contain `answers.route` with `type`, `choice`, `confidence`, and `probabilities`. `typeSafeAdapter(transport, enableLive)` wraps an explicitly injected SDK or HTTP transport. The transport should call `POST https://api.typesafe.ai/v1/systemone`, honor AbortSignal, use no long-context header, and avoid retries beyond the routing deadline. This repository deliberately does not supply a credential or HTTP implementation.

Both the adapter and Router require explicit live enablement; Router also requires a verified meter. A mock adapter is assumed to be offline developer code. Custom adapters are trusted executable code and can violate that assumption; mode flags are not a sandbox.

The default deadline is 1,500 ms. Timeout, cancellation, thrown transport errors, wrong model, malformed responses, inconsistent probabilities, or confidence/selected probability below 0.8 all yield `ignore`. This favors avoiding unwanted insertion or interruption; the host can surface the reason for manual retry. There are no automatic retries. Late results cannot apply a stale decision. The caller should tune thresholds against labeled synthetic or expressly approved data.

[State](https://docs.typesafe.ai/concepts/state) supports structured context; here incoming input and the two histories have separate named fields. Channel text and Pi context are untrusted classifier data. The prompt says so, but prompts do not enforce authorization. Host allowlists, sender identity, channel permissions, and tool authorization remain independent. [Intent routing](https://docs.typesafe.ai/patterns/intent-routing) motivates keeping deterministic actions outside classification.

## Required Pi host adapter

The target IRC host requires these integration considerations (verify against your host version):

- `bot.ts` filters unmentioned channel messages before extensions see them.
- `channel-session.ts` sends busy arrivals through `session.steer()`, bypassing `input`.
- `pi.on('input')` can continue, transform, or handle input, but cannot cover those missing IRC arrivals.
- `ctx.sessionManager.buildContextEntries()` provides active compaction-aware context; `getBranch()` selects the active branch. Avoid all-branch `getEntries()`.
- `pi.sendUserMessage(text, { deliverAs: 'followUp' })` re-enters input with source `extension`; a future extension must guard that recursion.
- `ctx.abort()` returns void, and `pi.events.emit()` is not awaited. Neither supplies the required interruption barrier.

Current [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) and [extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) describe extension capabilities. They are not a substitute for checking and pinning your IRC host version. No speculative Pi hook is registered by this package.

Add an **awaited host call before mention filtering and busy steering, after deterministic command authorization/dispatch**. Pass structured channel, sender, message ID, text, busy status, and recent context to the router. The included `Coordinator` is a reference implementation of sequencing against this package's `Host` interface, not a Pi API.

Implement these host operations:

| Operation | Required behavior |
| --- | --- |
| `snapshot` | Fetch bounded history for the channel and active compaction-aware Pi session at processing time; omit secrets and other sessions. |
| `apply(ignore)` | No context insertion; Coordinator does not call apply for ignore. |
| `apply(queue)` | Enqueue follow-up if busy, or prompt if idle, using current host state. Resolve after admission, not after the full agent run. |
| `apply(interrupt)` | Await `ChannelSession.abort()`; recheck generation; submit the message. Do not equate steering with a completed abort. |
| `invalidate` | Synchronously fence older generations, including actions already inside apply. |
| `stop` | Bypass routing waits, clear old pending work, and await host abort; enforce the generation fence after each await. |
| `command` | Execute existing deterministic command semantics and authorization without inference. |

For hosts that dispatch commands before routing, invoke the coordinator's stop path (or an equivalent fence) as part of the deterministic stop handler so pending classifications cannot resume work afterward. The included parser conservatively reserves any leading comma command, including unknown ones, for the host; `,stop` is recognized case-insensitively with a whitespace/end boundary. Match deployed parser semantics in the host shim and do not classify explicit commands.

Ordinary arrivals classify and apply FIFO per channel. Channels are independent. Stop increments a generation immediately, cancels active inference, fences already-running host effects, and supersedes older queued arrivals. New arrivals wait for the stop barrier; a failed stop blocks further insertion until a subsequent successful stop/recovered host session. Host errors return `ignore/host-error`; stop errors reject to the host for visible recovery. The host must deduplicate message IDs upstream and authenticate commands before calling `receive`. Already admitted work cannot be retracted by the core alone: the host's generation fencing and abort implementation are essential.

## Validation and publication status

Tests use synthetic messages and fake hosts only: Unicode/escaping, huge entries, overhead boundaries, equal allocation, empty histories, malformed/low-confidence responses, disabled live calls, timeouts, cancellation, FIFO, independent channels, stop races, host errors, and queue backpressure. No TypeSafe inference or deployment is part of verification.

Source: [r33drichards/pi-jev-router](https://github.com/r33drichards/pi-jev-router). The npm package remains unpublished. No production host installation or live inference has been performed.
