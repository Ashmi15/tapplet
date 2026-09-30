# Tapplet

**Create tiny interactive tapplets for any lesson.** Tapplet Studio is Tinkercademy's teacher-facing, iPad-first SwiftUI app for creating, adapting, previewing and sharing self-contained classroom activities.

## Architecture

- `apps/ipad`: native SwiftUI app and the canonical bundled example corpus at `Resources/Examples`
- `services/api`: Cloudflare Worker API, D1 migrations and tests
- `scripts` and `evals`: repository, publication and model-quality tooling
- `docs`: product contract and pilot operations

The app bundles reviewed HTML examples and can browse and run them offline. Saved tapplets remain available for offline preview. Generation, revision history, restoration from the service, and publication require the API.

## Native iPad setup (no Node required)

Install Xcode and pinned XcodeGen 2.44.1, then:

```bash
cd apps/ipad
xcodegen generate
cd ../..
xcodebuild -project apps/ipad/Tapplet.xcodeproj -scheme Tapplet \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

If Node is already installed, `npm run ipad:generate` is an equivalent
repository-root convenience command. It does not use `node_modules`.

Run tests on an available iPad simulator:

```bash
xcodebuild -project apps/ipad/Tapplet.xcodeproj -scheme Tapplet \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  CODE_SIGNING_ALLOWED=NO -only-testing:TappletTests test
```

Debug defaults to simulator loopback at `http://127.0.0.1:8787`. A physical iPad cannot reach the Mac through loopback: set `TAPPLET_API_BASE_URL` to an address reachable from that iPad. Release defaults to the deployed API. See [`apps/ipad/README.md`](apps/ipad/README.md) for signing and configuration.

## API and repository tooling

Node.js 22 dependencies are only for development, API and repository tooling; they are never bundled into the native app.

```bash
npm ci
cp services/api/.dev.vars.example services/api/.dev.vars
npm run api:db:migrate:local
npm run api:dev
```

The API selects its text model with `AI_PROVIDER` and `AI_MODEL`. Supported
providers are:

| `AI_PROVIDER` | Credential | Endpoint |
| --- | --- | --- |
| `openai-compatible` | `AI_API_KEY` | `AI_BASE_URL` |
| `opencode` | `OPENCODE_API_KEY` | OpenCode Zen |
| `opencode-go` | `OPENCODE_API_KEY` | OpenCode Go |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter |
| `fixture` | none | deterministic local fixture |

For OpenCode Zen or Go, use a model ID listed in the provider's endpoint table;
Tapplet supports OpenAI-compatible chat completions and the Responses API used
by the default `muse-spark-1.2-contributor` model. For OpenRouter, use an
OpenRouter model slug. Provider credentials are Wrangler secrets in deployed
environments; never put them in
`wrangler.jsonc`. Tapplet requests maximum reasoning for generation, revision
and repair (`max` on OpenCode's DeepSeek chat models and `xhigh` on Muse Spark
and OpenRouter); this can increase
latency and token cost. Uploaded-image safety review uses `gpt-5.6-luna`
through OpenCode Go with reasoning disabled and requires `OPENCODE_API_KEY`.

Setting `INFERENCE_TRANSPORT=tkslopper` instead routes every model call,
including image review, through Tinkertanker's tkslopper gateway using
capability aliases; the default `direct` keeps the providers above. See
[`docs/TKSLOPPER_TRANSPORT.md`](docs/TKSLOPPER_TRANSPORT.md).

Useful commands are `api:dev`, `api:build`, `api:test`, `api:typecheck`, `api:db:migrate:local`, `examples:validate`, `examples:package`, `examples:import`, `eval:artifacts`, `eval:model`, `eval:model-moderation`, `verify:live`, and `class-access:provision`.

Run all offline repository verification with:

```bash
npm run verify
npm run api:build
```

`verify` runs root tooling tests, API tests and typechecking, canonical example validation, and artifact evaluation. It deliberately does not claim to compile Swift; native build and tests run separately on macOS CI.

Operational details: [`docs/TAPPLET_PILOT_RUNBOOK.md`](docs/TAPPLET_PILOT_RUNBOOK.md). Product contract: [`docs/TAPPLET_V1.md`](docs/TAPPLET_V1.md). Current first-party colour guidance: [`docs/DESIGN.md`](docs/DESIGN.md).

## Licence

[MIT](LICENSE)
