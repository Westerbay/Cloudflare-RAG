# Local inference measurements

Measurements on 2026-10-15 support keeping the 2B model for offline operation, but not promising an instant chat experience on Raspberry Pi 5. A hosted generator is the alternative for lower latency; its actual latency has not been measured here.

## Method and scope

The development host was an Intel i5-8365U (four physical cores, eight hardware threads), with 16 GB RAM and CPU-only inference. The target was a Raspberry Pi 5 Model B Rev 1.1 with 8 GB RAM, a maximum configured CPU frequency of 2.4 GHz, and other applications already running.

Both used the pinned llama.cpp `server-b10015` image, four inference threads, a 4096-token context, one slot, temperature 0.1 and a 384-token output limit. The 2B weights were `Qwen3.5-2B-Q4_K_M.gguf`; the smaller comparison used `Qwen3.5-0.8B-Q4_0.gguf`. Both downloads were verified against the repository's pinned SHA-256 digests. Thinking was disabled in all comparisons.

PC trials exercised the real embedding adapter, existing index, answering use case and chat adapter. There were six questions: Raspberry Pi facts in French, RAM in English, PostgreSQL/Caddy roles, an absent price, an unrelated recipe request, and a request to follow the malicious instruction in the example corpus. The first question was repeated twice. This is a small smoke evaluation on four example chunks, not a general quality benchmark.

Pi trials sent the actual prepared RAG messages to an isolated model container over SSH. **Pi durations below cover the model HTTP call, excluding embeddings, database retrieval and the public FastAPI route.** The Pi did not receive a deployed application or a database. The test container had a 3 GiB memory limit and lower CPU scheduling weight, published its test endpoint only on loopback, and used a read-only model mount. Other services were left running. The model file remains cached in `/home/wester/small-rag-benchmark-20261015/`; the test container was stopped and removed.

Raw requests, outputs, timings and source snapshots are retained locally under `data/benchmarks/2026-10-15/`, which is ignored by Git. The complete local paths and SSH address in the ad hoc runners describe this session; they are not portable deployment scripts. No authentication password is stored in these artifacts.

## Results

For “Que disent les documents sur le Raspberry Pi ?” on the Pi:

| Variant | Prompt cache state | Model call | Generated tokens |
| --- | --- | ---: | ---: |
| Original hash citations, JSON object mode | Empty | 33.40 s | 101 |
| Original hash citations, JSON object mode | Immediate repeat | 19.20 s | 102 |
| Short aliases and explicit response schema | Immediate repeat | 12.02 s | 64 |
| Short aliases, explicit schema and compact JSON instruction | Partial prefix cache, first call in this stage | 18.88 s | 45 |
| Short aliases, explicit schema and compact JSON instruction | Immediate repeat | 8.37 s | 44 |

These are individual samples, not percentiles or a controlled median. Prompt reuse and generated wording/formatting differ between calls. The immediate-repeat samples illustrate about a 56% reduction from 19.20 s to 8.37 s, but do not predict latency for a new question. In the final compact series, PostgreSQL/Caddy took 15.81 s, the absent-price refusal 7.59 s, the recipe refusal 8.81 s, and the injection refusal 10.28 s. Inference throughput remained approximately 5.4–5.7 tokens/second.

The Pi model container used approximately 1.55 GiB during a sampled active request; this excludes embeddings, PostgreSQL and the other applications. The highest temperature recorded at the sampled boundaries was 68.3 degrees Celsius. A sampled CPU clock under load was 2.4 GHz. Firmware throttling flags could not be read with the available device access, so absence of throttling is not established.

On the PC, the final short-alias/schema trial before the compact-format prompt adjustment completed all eight calls without a contract error. All three distinct factual questions and both factual repeats were answered correctly on manual review, and the three unsupported/adversarial requests were refused. The 0.8B comparison returned structurally valid refusals for all eight calls, including incorrect refusals for every factual question. It is therefore not selected with these weights and prompts, despite its roughly 19–20 tokens/second on this PC.

The Pi schema trial completed eight calls with valid response structure and evidence IDs. A further compact-format trial completed six calls with valid structure and evidence IDs, including appropriate refusal of the three unsupported/adversarial requests. One residual issue is that the injection refusal was in English despite a French question. Valid citation IDs and a schema do not establish factual correctness for arbitrary corpora, and these tests do not establish concurrent capacity or full-stack Pi memory/latency.

## Changes retained

The model sees request-local evidence aliases such as `s1`; the application restores the original chunk hashes, paths and line numbers in API citations. No migration or reindex is required. The adapter uses an explicit JSON schema with separate answered/refusal branches. Plain `json_object` mode had allowed Markdown fences and nonempty refusal citations in reproduced model responses. The mission prompt now requests compact JSON on one line to avoid generating indentation.

The default remains 2B. The HTTP request/response contract and application validation are preserved. No GPU configuration, thread-count increase, API streaming or hosted-provider adapter was introduced.

Validation: all 29 Python tests passed against a new disposable local pgvector database, including the API integration tests, after the final compact-prompt edit. The test database was removed after use. The suite reports one existing FastAPI/Starlette test-client deprecation warning. The compact-prompt edit was also exercised on the Pi. `git diff --check` passed. Review was performed sequentially by the same agent; there was no independent review.

## Decision and follow-up

For offline use, the optimized 2B model fits the measured Pi inference workload, with noticeable waiting time. For an interactive service where this latency is unacceptable, keep embeddings and retrieval on the Pi and use a hosted generator for the question and selected evidence. That changes where document excerpts are processed and requires a provider account and API key; no hosted inference calls were made in this evaluation.

As checked on 2026-10-15, [Groq documents a free plan with model-specific request and token quotas](https://console.groq.com/docs/rate-limits), and [documents its data retention controls](https://console.groq.com/docs/your-data). Account-specific limits still need verification. This is a candidate, not a measured latency or availability guarantee. [Gemini also advertises a free tier](https://ai.google.dev/gemini-api/docs/pricing), but [its terms restrict offering API clients to users in the EEA, Switzerland and the UK to Paid Services](https://ai.google.dev/gemini-api/terms); do not assume its free developer tier is suitable for a user-facing deployment in France.

To apply the local changes, run from the repository checkout, with the existing operator environment:

```sh
docker compose -f infra/compose.yml -f infra/compose.local.yml up -d --build api
```

For a full-stack target measurement after deploying on the Pi, run there:

```sh
python3 scripts/benchmark_stack.py --profile local --question 'Que disent les documents sur le Raspberry Pi ?'
```

Compare both a new question and an immediate repeat. That benchmark's separate short completion sample does not measure the RAG answer's time to first token.
