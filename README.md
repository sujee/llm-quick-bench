# LLM Quick Bench

## What is it?

A quick and easy browser-based tool for benchmarking LLM inference endpoints. No spinning up VMs, setting up Python environments, or installing packages.

It measures response speed, token throughput, latency, accuracy, token usage, and estimated cost. Results can be exported as CSV or JSON.

> **Note:** This is designed to be a quick benchmark—hence the name. It is not intended to replace comprehensive benchmarking tools.

## Try it!


[![Try LLM Quick Bench live](https://img.shields.io/badge/TRY_IT_LIVE-Launch_LLM_Quick_Bench-6c5ce7?style=for-the-badge)](https://sujee.github.io/llm-quick-bench/)

Enter your endpoint URL and API key, load the available models, select the models you want to compare, and run a benchmark.


## Benchmarks

- **Speed Test 1** — raw output-generation speed: one tokens-per-second value per measured run, charted per model.
- **Thinking Test 1** — accuracy and token cost with reasoning enabled vs disabled.
- **Decode Test** — client-observed output generation speed at configured output lengths (p50/p90 per length).
- **Needle Test** — long-context retrieval: a document sized at a fill percent of each model's context window (default 90%) hides one needle at each configured position (default 5%–90%), producing the "lost in the middle" accuracy matrix plus TTFT p50/p90 and effective input tok/s per position. Models run one at a time, and a styled confirmation dialog totals the planned requests, input tokens, and estimated input cost before anything is sent.
- **Prefill Test** — long-prompt prefill speed: input sizes from 10K to 1M tokens with the needle pinned near the end (default 90%); the effective input rate shows how fast the endpoint digests each size. A styled confirmation dialog totals the planned requests, input tokens, and estimated input cost before anything is sent.
- **Cache Test** — prompt-cache effectiveness: one fixed trivia question ("What is the capital of France?") asked three ways — short (bare question, below the cacheable minimum), padded (question + filler to a configured size, default 50K tokens), and nonce-busted (the padded prompt with a fresh nonce on every request, the no-cache control). Per variant, one cold request primes the cache and repeats measure the server-reported cached-token split (cache hit %), the TTFT reduction, and the billed-cost drop at cached input pricing.

## Prerequisites

- The URL of your OpenAI-compatible endpoint
- An API key for that endpoint

## Dev Notes

[dev-notes.md](dev-notes.md)
