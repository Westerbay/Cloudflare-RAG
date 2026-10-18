# Cloudflare architecture

Cloudflare RAG is a TypeScript pnpm workspace with a Cloudflare Worker and Node.js operator tools. The application layout is inspired by [WebApp Template](https://github.com/Westerbay/WebApp-Template). Cloudflare Workers, Workers AI, D1 and Vectorize are the hosted runtime.

## Indexing

`pnpm corpus:index` exports deterministic chunks with markdown-it CommonMark extraction and pure TypeScript character windows. It is a local plan until the operator adds `--apply`. Paths, source line ranges and canonical content-derived chunk hashes are preserved. The default corpus is `examples/corpus`; production documents should live in an ignored directory outside the source tree.

The operator script uses an explicitly selected Cloudflare account and D1 database. For a changed corpus it creates a new generation, requests embeddings, inserts passage batches into D1 and upserts vectors under the generation's namespace. Vector IDs hash both generation and original chunk ID so staged writes cannot overwrite active vectors. No source text is stored in Vectorize metadata; the passage text stays in D1. A repeat with an identical corpus hash and recipe makes no new embedding calls.

Document embeddings include the relative source path and full heading ancestry before the passage. This keeps a section such as "Purpose" associated with its project even when the body does not repeat the project name. D1 retains the original passage and line ranges for citations. The embedding-input recipe is versioned separately from extraction; changing it requires re-exporting and explicitly reindexing, even when source text is unchanged.

Vectorize writes are asynchronous. The script polls its last submitted mutation before changing D1's active-generation pointer. Activation is one SQL statement that also verifies the staged chunk count. Provider errors, incomplete vectors or missing passages leave the old active generation intact. Failed or old generations are retained, not automatically deleted. Run one indexing job at a time: competing operators can otherwise delay mutation confirmation. Staging is rejected if its estimated total stored vector dimensions would exceed the Free allowance for this index. This estimate does not account for other indexes in the account.

The operator retains the Markdown files as the source of truth. There is no public ingestion API and no automatic indexing at startup or chat time. Changing extraction, chunking or embedding models requires rebuilding from those sources. Existing vectors must not be reused with a different embedding model, even when dimensions happen to match.

## Answering and grounding

By default, the Worker authenticates every route with HTTP Basic (`rag` and a Cloudflare secret). Protected routes return 503 without a valid configured secret, or 401 for invalid credentials, before storage or model access. Setting `PUBLIC_CHAT_ENABLED` to exactly `"true"` opens only `POST /v1/chat` and its `OPTIONS` preflight. Both health endpoints remain private. Public chat does not require the Basic Auth secret and ignores supplied credentials.

Public chat uses an explicit `PUBLIC_CHAT_ORIGINS` allowlist. Allowed browser origins receive CORS headers on answers and errors, including sleeping and `Retry-After`; rejected origins and preflights never reach the RAG pipeline. Requests without `Origin` remain allowed, so CORS is not authentication or abuse prevention. Public mode exposes the entire indexed corpus; private mode shares it with all credential holders. Neither mode has per-document permissions. The public option changes only access, not retrieval, generation or service sleep.

For a valid chat request, the Worker reads the active D1 generation, embeds the question, queries Vectorize in that generation's namespace, filters weak similarity scores and fetches passages from D1. It uses at most four candidate passages and 3000 characters of evidence. Missing D1 passages for matched vector IDs are an error rather than a reason to use unrelated data.

Search uses Qwen's `queries` input with a retrieval instruction, while ingestion uses document embeddings. In the [Cloudflare model input contract](https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/schema-input.json), `text` is an alias for `documents`, not queries. When history is present, the existing chat model first produces a bounded, validated standalone English search question. It resolves subjects from the conversation, including an opening assistant message, while prioritizing a topic change in the current question. Only this resolved question is embedded; older project descriptions no longer compete directly with the current question in the embedding input. Empty history keeps the direct query-mode embedding path.

Resolution distinguishes the visitor, assistant, portfolio owner, discussed project and underlying model. A question addressed to the assistant about its own implementation or models retains the assistant's known description as a search anchor, including after a project discussion. The resolver does not infer model names or training facts; those must come from retrieved evidence. This is part of the existing resolution call, not an additional model step.

Answer generation receives the original question, intact validated history and the resolved search question as a separate, untrusted intent hint. It responds in the original question's language. Neither the rewritten question nor history is factual evidence. Invalid or truncated resolution output fails before embedding and vector search. Resolution uses the same provider availability checks, with no retries or separate quota allowance. A request with history now makes three AI calls instead of two; it adds inference latency and quota consumption without changing the public API, model, index representation or service-sleep policy. Clients should retain a visible introduction when it establishes a continuing subject, within the existing four-turn and 2000-character limits. Retrieval and resolution still require representative live evaluation rather than relying on model stand-ins.

The model receives the mission and style files bundled at deployment, with the question, history and evidence serialized as untrusted JSON. Evidence IDs are short request-local aliases (`s1`, `s2`, and so on). The Worker checks status, answer text and citation membership, then restores the original hashes, paths and line ranges in the HTTP response. Chat history is never used as evidence. No qualifying evidence forces an `insufficient_context` refusal. Other refusal statuses require no citations; answered responses require at least one selected citation.

The default JSON response path sends Workers AI a JSON schema and a 200-token output cap. Its response must still pass application validation. Invalid JSON, unknown citations, truncation, provider failure and incompatible indexes return 503. There is no automatic retry, alternative paid provider or local-model fallback. Valid citation membership proves only that a passage was supplied; it cannot prove that every factual sentence follows from that passage. Model quality and latency remain to be measured against the operator's account and real corpus.

## Streaming answers

`POST /v1/chat` opts into Server-Sent Events when its `Accept` header includes `text/event-stream`. Existing callers retain the JSON response. Input validation, public/private access, allowed origins, context resolution, retrieval, generation model, 200-token budget and call count are unchanged: one embedding and one answer generation, plus the existing question-resolution call when history is present.

Cloudflare [JSON Mode does not support streaming](https://developers.cloudflare.com/workers-ai/features/json-mode/). Only the streamed final generation omits `response_format`; the prompt still asks for one compact JSON object with status, answer and citations. The resolver continues to use JSON Mode. The API parses Workers AI SSE with `eventsource-parser` and incrementally extracts only the JSON `answer` string with `@streamparser/json`, both MIT packages. Provider metadata, model JSON syntax, source passages and internal errors are never forwarded. OpenAI-compatible `choices[0].delta.content` is preferred when present because Cloudflare can coerce the duplicate native `response` field into a number; native string fragments remain supported without duplicating text. Usage-only and separate stop frames are accepted, while truncation, incomplete UTF-8/JSON and a missing `[DONE]` marker fail closed. The provider stream is limited to 128 KiB, 2048 events and 16 KiB of generated JSON, in addition to the token limit.

The response has `Content-Type: text/event-stream; charset=utf-8` and `Cache-Control: no-store, no-transform`. Each event is one JSON value:

| Event | Data | Client behavior |
| --- | --- | --- |
| `delta` | `{ "delta": "text fragment" }` | Append provisional answer text. |
| `result` | The existing `{ status, answer, citations }` response | Commit the validated final answer and conversation history. |
| `sleeping` | The existing sleeping body, including `service`, `reason` and `retry_at` | Discard provisional text and enter the existing sleep state. |
| `error` | `{ "code": "response" }` | Discard provisional text and report that the answer could not be completed. |

Exactly one terminal event (`result`, `sleeping` or `error`) completes a connected stream. An interrupted connection has no success guarantee. Clients must treat EOF without a terminal event as failure, keep unvalidated partials out of persisted history and never interpret a `delta` as a final answer. The API validates the complete JSON with the same Zod, citation-membership and status rules as the default path before emitting `result`. Provisional text can therefore be withdrawn if final validation fails; this is a streaming UX tradeoff, not stronger grounding. The API does not retry or make another model call to repair a rejected answer.

Failures before the stream starts retain existing HTTP JSON status codes and retry headers. After headers are sent, provider read errors and provider error events use the same availability policy and a terminal `sleeping` payload. Cancelling the response reader stops the upstream reader; request aborts also stop it when the runtime provides an abort signal. Intentional cancellation never pauses the service for other visitors. Provider cancellation is best effort and does not promise a billing refund for already generated tokens.

## Provider quotas and service availability

There is no manual daily admission counter or limit on question count. Cloudflare enforces its account-wide allocations. The historical `daily_usage` table is retained for migration compatibility but is never read or written by the Worker; old rows do not block questions.

`ServiceAvailability` wraps D1 reads, Workers AI calls and Vectorize operations. A binding failure returns a redacted HTTP 503 with `status: "sleeping"`, `service`, `reason`, `retry_at` and `Retry-After`. Only documented daily exhaustion signals (Workers AI code 3036 and D1 daily row-limit messages) set `reason: "quota_exhausted"` and `reset_at` to the next UTC midnight. AI capacity error 3040 is not daily exhaustion. Error causes are inspected without exposing provider messages.

Unknown failures, including Vectorize errors without a documented reset signal, pause for one minute. After expiry, the next valid request tries the regular operation; there are no background probes or replay of failed questions. If the service is still unavailable it pauses again. `retry_at` is a probe time, never an invented monthly or storage reset. Storage exhaustion needs an operator to free capacity; monthly allowances do not reset at midnight every day.

Pause state is best-effort and isolate-local, associated with the D1 binding identity. Cached sleep blocks chat and readiness before downstream access, including AI when D1/Vectorize is unavailable. Liveness and authentication continue to work. No pause persistence depends on an exhausted database. A cold isolate or an in-flight request can still reach the provider; Cloudflare is the global enforcement authority. Exhausting the Workers request quota can prevent the handler from executing at all, so application JSON and retry headers are not guaranteed in that case.

Bounded inputs and output remain in place to control per-request work. On an already paid account, Cloudflare can bill overages rather than return a free-tier exhaustion error; this behavior is not a financial spending cap. The deployment must remain on Workers Free for the intended zero-cost policy.

## Modules and infrastructure

- `apps/api/src/`: Worker composition, HTTP/auth boundary, Cloudflare bindings and provider availability.
- `packages/contracts/src/`: Zod chat, answer, corpus and embedding contracts plus shared model/budget settings.
- `packages/core/src/chunking.ts`: framework-independent source windows; no Node, Cloudflare or Zod imports.
- `packages/database/`: minimal D1 binding types and unchanged versioned SQL migrations.
- `infra/wrangler.jsonc`: source configuration; `infra/setup.ts` creates/reuses resources only with `--apply`.
- `packages/database/migrations/`: D1 schema; remote migrations are explicit.
- `scripts/corpus/export.ts`: confined, bounded local CommonMark extraction and stable source/chunk hashes.
- `scripts/index-cloudflare.ts`: operator-only generation staging and activation.

Wrangler was chosen over Pulumi for this single-provider application. Source configuration, migrations and a small repeatable setup script cover the resources without adding a second infrastructure state backend or toolchain. Setup stores only account/database identifiers in ignored `infra/wrangler.local.json`; tokens remain in the operator environment and the HTTP password is a Worker secret. No deployment or billing subscription is created by a build or test.

## Workspace boundaries

The workspace separates application composition, pure rules, shared contracts and persistence. It contains one API application and no web chat interface. Node's test runner covers HTTP behavior, source extraction and operator staging; strict TypeScript checks include the Worker, packages and operator scripts.

Core imports no framework or filesystem modules. Contracts depend on Zod and their own definitions; database owns SQL and binding types. Shared packages never import the application. The API consumes contracts/database; operator scripts compose core, contracts and Cloudflare REST access. CommonMark parsing and filesystem access stay in the Node-only exporter so they are not bundled into the Worker.

The current extraction recipe is `markdown-it-15.0.2-commonmark/utf16-v3`, paired with embedding recipe `document-path-heading-text-v1`. Empty parent headings remain in their descendants' ancestry instead of consuming standalone vectors; headings with body text and standalone leaf facts remain indexed. Reindex explicitly when changing a recipe; never reuse its identifier for different extraction or embedding input. Source hashes, canonical relative paths, line numbers, section boundaries and deterministic IDs remain part of the citation contract. UTF-16 windows stay within the shared character budget without splitting surrogate pairs. All corpus symlinks are rejected, including directory cycles; files must be UTF-8, regular, confined and bounded. Traversal stops at 5000 entries.
