# tkslopper inference transport

Tapplet can send every model call (generation, revision, repair, publication
review and uploaded-image review) through
[tkslopper](https://github.com/tinkertanker/tkslopper), Tinkertanker's managed
inference boundary. The transport is off by default. The direct provider path
described in the [README](../README.md) remains the rollback path until a
canary has been accepted; a follow-up change can then remove the direct dialect
code and provider keys.

## How it works

- The Worker holds a tkslopper **service credential** (`tksvc_<id>_<secret>`)
  as a Worker secret. iPads never talk to tkslopper: they authenticate to
  Tapplet with class codes and device tokens, and Tapplet keeps prompts,
  validation and quotas server-side. Join-code device activation and classroom
  group keys (`tkgk_`) are not used.
- The credential is exchanged at `POST /v1/token` on the control plane for a
  15-minute grant covering the three capability aliases. Grants are cached per
  isolate, refreshed when less than 60 seconds remain (or halfway through a
  grant shorter than two minutes), and shared between concurrent requests. The
  exchange has its own 5-second timeout. Keep the environment's token TTL well
  above 60 seconds so grants are reused.
- Model calls go to the gateway's `/v1/responses` (or `/v1/chat/completions`
  for artifacts when configured) with the alias as `model`, an explicit output
  limit, `stream: false` and a fresh `idempotency-key` of the form
  `tapplet:<operation>:<uuid>`. Each call keeps Tapplet's 45-second abort.
- Only portable reasoning efforts are sent. `xhigh` and `max` become `high`,
  `minimal` becomes `low`, and `none` omits reasoning. `thinking`,
  `reasoning.exclude` and provider attribution headers are never sent. Until
  tkslopper issue #13 lands, `high` is the portable high effort and is not the
  same as today's direct `xhigh`.
- A result counts only when it is complete: Responses `status: "completed"`
  with non-empty output text and no refusal, or Chat `finish_reason: "stop"`
  with non-empty content. Truncated, incomplete, refused and empty results are
  errors, never partial artifacts.
- Errors keep Tapplet's existing mapping: 429 and 5xx are retryable (HTTP 503
  to the iPad), everything else is not (HTTP 502). A gateway 401 drops the
  cached grant and is retried exactly once with a new grant and a new
  idempotency key. A 403 drops the cached grant. Nothing else is retried by
  Tapplet; 502 and 504 are ambiguous and already charged.
- Requests larger than `TKSLOPPER_MAX_REQUEST_BYTES` are rejected before any
  network call. Oversized or failed image reviews return the usual "review
  unavailable" advisory warning.
- `model_call` traces record the alias as `configuredModel`, the returned
  alias as `resolvedModel`, the response id and the gateway's
  `x-tkslopper-request-id` as `gatewayRequestId`. Credentials, grant tokens
  and payloads are never logged or traced.
- The D1 admin model override is ignored while the transport is `tkslopper`.
  The operations panel shows "Transport: tkslopper (admin model override
  inactive)" and the configured aliases. Revisions record
  `tkslopper:<artifact alias>` as their model version.

## Configuration

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `INFERENCE_TRANSPORT` | var | `direct` | `direct` or `tkslopper`. Any other value disables model calls. |
| `TKSLOPPER_CONTROL_PLANE_URL` | var | none | HTTPS. |
| `TKSLOPPER_GATEWAY_URL` | var | none | HTTPS. |
| `TKSLOPPER_SERVICE_CREDENTIAL` | secret | none | `wrangler secret put`; never a var. |
| `TKSLOPPER_ARTIFACT_ALIAS` | var | none | Generation, revision and repair. |
| `TKSLOPPER_REVIEW_ALIAS` | var | none | Publication moderation. |
| `TKSLOPPER_IMAGE_ALIAS` | var | none | Uploaded-image review. |
| `TKSLOPPER_ARTIFACT_EFFORT` | var | `high` | `low`, `medium`, `high` or `omit`. Direct-provider values are translated: `xhigh` and `max` to `high`, `minimal` to `low`, `none` to `omit`. |
| `TKSLOPPER_REVIEW_EFFORT` | var | `low` | As above. |
| `TKSLOPPER_IMAGE_EFFORT` | var | `omit` | As above. |
| `TKSLOPPER_ARTIFACT_ENDPOINT` | var | `responses` | `responses` or `chat`. Review and image calls always use Responses. |
| `TKSLOPPER_MAX_REQUEST_BYTES` | var | `1048576` | Must not exceed the gateway's effective limit, the smaller of its `MAX_BODY_BYTES` and the environment's `max_request_bytes`. |
| `TKSLOPPER_GATEWAY`, `TKSLOPPER_CONTROL_PLANE` | service binding | none | Optional, same Cloudflare account only. Used instead of the URLs when present. |

Aliases must match `^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$`. If the transport is
`tkslopper` and any required value is missing or invalid, every model call
fails with a message naming the problem. Tapplet never falls back to the direct
providers on its own.

## Operator setup in tkslopper

Tapplet does not create any of this; tkslopper operators set it up per stage.

- Product `tapplet`, one environment per stage, and a service credential
  entitled to the three aliases.
- Aliases on the `responses` endpoint, and also on `chat` for the artifact
  alias if `TKSLOPPER_ARTIFACT_ENDPOINT=chat`:
  - Artifact alias: `allow_structured_json`, `allow_reasoning`,
    `max_output_tokens` of at least 32,000, and `max_input_tokens` of at least
    the largest serialised generate or repair body. Two 200 KB exemplars can
    exceed 450,000 bytes after JSON escaping.
  - Review alias: `allow_structured_json`, `allow_reasoning` unless the review
    effort is `omit`, `max_output_tokens` of at least 500, and
    `max_input_tokens` of about 260,000.
  - Image alias: `allow_images`, `max_output_tokens` of at least 500, and
    `max_input_tokens` of at least the image body size. A 2 MB JPEG is about
    2.7 MB of base64, and image requests reserve the whole alias input ceiling.
- Environment `max_request_bytes` of at least 3,145,728 if full canonical
  images are reviewed, with `TKSLOPPER_MAX_REQUEST_BYTES` set to match.
- Rate, token, concurrency and daily budget limits sized for the whole Tapplet
  fleet. All traffic shares one principal, and the defaults (100,000 tokens per
  minute, concurrency 2, one cent a day) would reject most generations.
- Route deadlines of 40 seconds or less, so the gateway answers 504 before
  Tapplet's 45-second abort. Each route's model must echo the exact configured
  model id; tkslopper fails closed with 502 on any mismatch, including dated
  snapshot names.

## Rollout and rollback

1. Before cutover, check `model_call` `durationMs` in the operational traces.
   If p95 for generate, revise or repair is near 40 seconds, agree a longer
   envelope with the operators first: raise the route deadline and Tapplet's
   abort together, keeping the route deadline below Tapplet's abort.
2. Store the credential for the target stage:
   `npx wrangler secret put TKSLOPPER_SERVICE_CREDENTIAL --profile tinkertanker`.
3. Set the URLs and aliases. If full canonical images should be reviewed, ask
   the operators to raise the environment's `max_request_bytes` to at least
   3,145,728 and set `TKSLOPPER_MAX_REQUEST_BYTES` to match; with the 1 MiB
   default, JPEGs above roughly 780 KB return "review unavailable". Then set
   `INFERENCE_TRANSPORT=tkslopper` in a non-production environment and
   deploy. Run the live flow, including an image upload and a publication.
4. Repeat as a production canary. Keep the direct provider secrets in place
   until the canary is accepted.
5. To roll back, set `INFERENCE_TRANSPORT=direct` and redeploy. Tapplet never
   switches back automatically after a tkslopper error, because that would
   double-charge ambiguous attempts and hide kill switches.

For a local transport smoke test, bind the local tkslopper dev Workers as the
`TKSLOPPER_GATEWAY` and `TKSLOPPER_CONTROL_PLANE` service bindings (the URL
variables must still be HTTPS values). The dev gateway's fixture route returns
the plain text `fixture response`, which is not JSON, so it exercises
authentication and transport only, not artifact semantics.
