# Agent Note: Audio and video input modality declarations

Status: implemented

English | [中文](2026-10-11-audio-video-input-modality-declarations.zh.md)

## Problem

The model settings dialog offers four input modality chips — Text, Image, Audio, Video — but the `llm-pi-ai` config schema refused to save the last two. Checking Audio or Video on a custom provider's model surfaced `$.providers.<route>.models[3].input[2] expected "text" | "image" but got "video"` and blocked Apply. The schema derived its accepted set directly from pi-ai's own `Model.input` type, which is `("text" | "image")[]`, so a model whose gateway natively accepts audio or video could not even record that fact.

## Decision

`PiAiModality` is now pi-ai's own request-modality union widened by two declared-only entries, `audio` and `video`. pi-ai's set is still enumerated behind a `Record<PiAiUpstreamModality, true>` drift gate, so a pi-ai upgrade that adds or a removal that drops a modality still fails compilation by name instead of silently narrowing what a profile may declare. The widened `MODALITIES` list feeds the `input` and `defaultInput` schemas, so both fields accept the two new values and continue to reject anything else.

`audio` and `video` are capability metadata, not a request path. pi-ai reads a model's `input` only through `includes("image")` to decide image downgrade, and no adapter serializes audio or video request content. Declaring either reaches `LlmModelInfo.inputModalities` unchanged and gates nothing further, which is why the shared `ModelModalityMap` records them as declarable vocabulary rather than as content blocks. The `resolveEntry` merge is the single point that narrows the wider harness list back into pi-ai's `Model.input` type, and it does so with a cast carrying the reason inline.

## Alternatives considered

**Refuse audio and video in the dialog instead.** Trimming the four chips to the two the schema accepts would remove the mismatch, but it would tell the operator their gateway is wrong when it in fact serves those modalities. The declaration is a claim about an endpoint that nothing can interrogate, so the honest move is to record it.

**Model audio and video as first-class content blocks.** Adding `AudioBlock`/`VideoBlock` to `ContentBlockMap` would let the harness send the media natively, but no adapter serializes it, pi-ai's upstream type does not carry it, and the durable, projection, replay, and pricing paths would all need to honor it. That is a provider-serialization feature, not a settings fix, so it stays out of scope.

**Keep the schema pinned to pi-ai's exact union and widen later.** This preserves the tight type correspondence, but it is what produced the bug: pi-ai's narrow type is an upstream serialization limit, not a statement about what a gateway accepts. Treating it as the settings vocabulary conflated the two.

## Consequences

An operator can now check Audio or Video on a `llm-pi-ai` model and save cleanly; the values persist in `settings.yaml` and surface through `listModels`/`resolveModelInfo`. The declarations change nothing about requests — an attached media file still reaches the provider as deterministic handle text, since the attachment path admits raster images and verbatim files only. The drift gate keeps pi-ai's own set honest, and `llm-deepseek`'s independent `inputModalities` schema is deliberately untouched, since it validates a different provider's catalog and still admits only text and image.
