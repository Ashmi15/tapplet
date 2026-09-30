import type { StudioEnv } from "../env";
import type { ImageSafetyInspector, ImageSafetyReview } from "../imageSafety";
import {
  IMAGE_SAFETY_QUESTION,
  imageDataUrl,
  parseImageSafetyAnswer,
} from "../imageSafety";
import type {
  ModelOperation,
  OperationalTraceContext,
} from "../operationalTrace";
import { emitOperationalTrace } from "../operationalTrace";
import { UnavailableModelProvider } from "./createProvider";
import {
  generationPrompt,
  MODERATION_SYSTEM_PROMPT,
  repairPrompt,
  revisionPrompt,
  SYSTEM_PROMPT,
} from "./prompts";
import type {
  DesignCard,
  Exemplar,
  ModelProvider,
  ModerationDecision,
  RepairContext,
  TeacherBrief,
} from "./provider";
import { ModelProviderError } from "./provider";

// tkslopper is Tinkertanker's managed inference boundary. Tapplet exchanges a
// service credential for a short-lived grant on the control plane, then calls
// the gateway's narrow OpenAI-compatible subset with capability aliases.

export type PortableEffort = "low" | "medium" | "high";
export type TkslopperArtifactEndpoint = "responses" | "chat";
export type TkslopperOperation = ModelOperation | "image_review";

/** Where a tkslopper Worker is reached: a service binding or a public URL. */
export type TkslopperTarget = { binding: Fetcher } | { url: string };

export interface TkslopperConfig {
  controlPlane: TkslopperTarget;
  gateway: TkslopperTarget;
  serviceCredential: string;
  artifactAlias: string;
  reviewAlias: string;
  imageAlias: string;
  artifactEffort?: PortableEffort;
  reviewEffort?: PortableEffort;
  imageEffort?: PortableEffort;
  artifactEndpoint: TkslopperArtifactEndpoint;
  maxRequestBytes: number;
}

export type TkslopperConfigResult =
  | { ok: true; config: TkslopperConfig }
  | { ok: false; reason: string };

// Mirrors tkslopper's opaque credential format: tksvc_<id>_<secret>.
const CREDENTIAL_PATTERN = /^tksvc_([A-Za-z0-9-]{8,64})_[A-Za-z0-9_-]{16,128}$/;
const ALIAS_PATTERN = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const MINIMUM_REQUEST_BYTES = 1_024;
const MAXIMUM_REQUEST_BYTES = 10_485_760;
const GRANT_TTL_SECONDS = 900;
const GRANT_REFRESH_MARGIN_MS = 60_000;
const EXCHANGE_TIMEOUT_MS = 5_000;
// How long any request waits on a shared exchange before replacing it.
const EXCHANGE_WAIT_MS = EXCHANGE_TIMEOUT_MS + 1_000;
// A cached grant still this far from expiry covers a failed refresh.
const STALE_GRANT_MARGIN_MS = 5_000;
const GATEWAY_TIMEOUT_MS = 45_000;
const ARTIFACT_MAX_OUTPUT_TOKENS = 32_000;
const REVIEW_MAX_OUTPUT_TOKENS = 500;
const INTERNAL_ORIGIN = "https://tkslopper.internal";

export function inferenceTransport(env: StudioEnv): string {
  return env.INFERENCE_TRANSPORT?.trim() || "direct";
}

/**
 * Maps a configured effort to one the gateway accepts. tkslopper rejects
 * none, minimal, xhigh and max, so these become the nearest portable value;
 * undefined means the request omits reasoning entirely.
 *
 * Until tkslopper issue #13 lands, "high" is only the portable high effort,
 * not today's direct "xhigh"; physical efforts will then be trusted route
 * policy owned by the operators.
 */
export function portableEffort(
  value: string,
): PortableEffort | undefined | null {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    case "xhigh":
    case "max":
      return "high";
    case "minimal":
      return "low";
    case "none":
    case "omit":
      return undefined;
    default:
      return null;
  }
}

/**
 * Resolves a tkslopper Worker target. A service binding wins when present;
 * the URL is then optional but still validated if set. tkslopper routes on the
 * exact path, so the URL must be an HTTPS origin without a path prefix.
 */
function serviceTarget(
  name: string,
  value: string | undefined,
  binding: Fetcher | undefined,
): { target?: TkslopperTarget; problem?: string } {
  const problem = `${name} must be an HTTPS origin such as https://tkslopper.example`;
  let url: string | undefined;
  if (value?.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      return { problem };
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      return { problem };
    url = parsed.origin;
  }
  if (binding) return { target: { binding } };
  return url ? { target: { url } } : { problem };
}

function isArtifactEndpoint(value: string): value is TkslopperArtifactEndpoint {
  return value === "responses" || value === "chat";
}

export function readTkslopperConfig(env: StudioEnv): TkslopperConfigResult {
  const problems: string[] = [];
  const controlPlane = serviceTarget(
    "TKSLOPPER_CONTROL_PLANE_URL",
    env.TKSLOPPER_CONTROL_PLANE_URL,
    env.TKSLOPPER_CONTROL_PLANE,
  );
  if (controlPlane.problem) problems.push(controlPlane.problem);
  const gateway = serviceTarget(
    "TKSLOPPER_GATEWAY_URL",
    env.TKSLOPPER_GATEWAY_URL,
    env.TKSLOPPER_GATEWAY,
  );
  if (gateway.problem) problems.push(gateway.problem);

  const serviceCredential = env.TKSLOPPER_SERVICE_CREDENTIAL?.trim() ?? "";
  if (!CREDENTIAL_PATTERN.test(serviceCredential))
    problems.push(
      "TKSLOPPER_SERVICE_CREDENTIAL must be a tksvc_ service credential secret",
    );

  const aliases = {
    artifactAlias: env.TKSLOPPER_ARTIFACT_ALIAS?.trim() ?? "",
    reviewAlias: env.TKSLOPPER_REVIEW_ALIAS?.trim() ?? "",
    imageAlias: env.TKSLOPPER_IMAGE_ALIAS?.trim() ?? "",
  };
  for (const [key, name] of [
    ["artifactAlias", "TKSLOPPER_ARTIFACT_ALIAS"],
    ["reviewAlias", "TKSLOPPER_REVIEW_ALIAS"],
    ["imageAlias", "TKSLOPPER_IMAGE_ALIAS"],
  ] as const) {
    const alias = aliases[key];
    if (alias.length < 2 || alias.length > 100 || !ALIAS_PATTERN.test(alias))
      problems.push(`${name} must be a capability alias such as tapplet.artifact.v1`);
  }

  const efforts: Record<
    "artifactEffort" | "reviewEffort" | "imageEffort",
    PortableEffort | undefined
  > = { artifactEffort: undefined, reviewEffort: undefined, imageEffort: undefined };
  for (const [key, name, value, fallback] of [
    ["artifactEffort", "TKSLOPPER_ARTIFACT_EFFORT", env.TKSLOPPER_ARTIFACT_EFFORT, "high"],
    ["reviewEffort", "TKSLOPPER_REVIEW_EFFORT", env.TKSLOPPER_REVIEW_EFFORT, "low"],
    ["imageEffort", "TKSLOPPER_IMAGE_EFFORT", env.TKSLOPPER_IMAGE_EFFORT, "omit"],
  ] as const) {
    const effort = portableEffort(value?.trim() || fallback);
    if (effort === null)
      problems.push(`${name} must be low, medium, high or omit`);
    else efforts[key] = effort;
  }

  const endpoint = env.TKSLOPPER_ARTIFACT_ENDPOINT?.trim() || "responses";
  if (!isArtifactEndpoint(endpoint))
    problems.push("TKSLOPPER_ARTIFACT_ENDPOINT must be responses or chat");

  const maxRequestBytesValue = env.TKSLOPPER_MAX_REQUEST_BYTES?.trim();
  const maxRequestBytes = maxRequestBytesValue
    ? Number(maxRequestBytesValue)
    : DEFAULT_MAX_REQUEST_BYTES;
  if (
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < MINIMUM_REQUEST_BYTES ||
    maxRequestBytes > MAXIMUM_REQUEST_BYTES
  )
    problems.push(
      `TKSLOPPER_MAX_REQUEST_BYTES must be a whole number from ${MINIMUM_REQUEST_BYTES} to ${MAXIMUM_REQUEST_BYTES}`,
    );

  if (
    problems.length ||
    !controlPlane.target ||
    !gateway.target ||
    !isArtifactEndpoint(endpoint)
  )
    return {
      ok: false,
      reason: `tkslopper transport is misconfigured: ${problems.join("; ")}.`,
    };
  return {
    ok: true,
    config: {
      controlPlane: controlPlane.target,
      gateway: gateway.target,
      serviceCredential,
      ...aliases,
      ...(efforts.artifactEffort ? { artifactEffort: efforts.artifactEffort } : {}),
      ...(efforts.reviewEffort ? { reviewEffort: efforts.reviewEffort } : {}),
      ...(efforts.imageEffort ? { imageEffort: efforts.imageEffort } : {}),
      artifactEndpoint: endpoint,
      maxRequestBytes,
    },
  };
}

interface Grant {
  accessToken: string;
  expiresAt: number;
  refreshAt: number;
}

interface PendingExchange {
  promise: Promise<Grant>;
  startedAt: number;
}

interface GrantSlot {
  grant?: Grant;
  pending?: PendingExchange;
}

/**
 * Per-isolate grant cache. Every exchange costs the control plane a PBKDF2
 * verification and a D1 write, so grants are reused until a minute before
 * expiry and concurrent requests share one in-flight exchange.
 */
export class TkslopperGrantCache {
  private readonly slots = new Map<string, GrantSlot>();

  slot(key: string): GrantSlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {};
      this.slots.set(key, slot);
    }
    return slot;
  }
}

const sharedGrantCache = new TkslopperGrantCache();

/** Error from the tkslopper transport, with the gateway request id if known. */
export class TkslopperError extends ModelProviderError {
  constructor(
    message: string,
    retryable: boolean,
    readonly status?: number,
    readonly gatewayRequestId?: string,
  ) {
    super(message, retryable);
  }
}

export interface TkslopperGatewayResult {
  body: Record<string, unknown>;
  gatewayRequestId?: string;
}

export interface TkslopperClientOptions {
  fetch?: typeof fetch;
  grantCache?: TkslopperGrantCache;
  now?: () => number;
}

interface ErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown };
  request_id?: unknown;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Console detail for a transport failure; never part of a thrown error. */
function failureDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "timed out";
    return `failed (${error.name})`;
  }
  return "failed";
}

/** Bounds how long one request waits on a possibly shared exchange. */
function withDeadline(promise: Promise<Grant>, ms: number): Promise<Grant> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error("tkslopper grant exchange wait timed out");
      reject(new TkslopperError("Model access grant timed out", true));
    }, Math.max(0, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class TkslopperClient {
  private readonly fetcher: typeof fetch;
  private readonly cache: TkslopperGrantCache;
  private readonly now: () => number;
  private readonly capabilities: string[];
  private readonly cacheKey: string;

  constructor(
    private readonly config: TkslopperConfig,
    options: TkslopperClientOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.cache = options.grantCache ?? sharedGrantCache;
    this.now = options.now ?? Date.now;
    this.capabilities = [
      ...new Set([config.artifactAlias, config.reviewAlias, config.imageAlias]),
    ];
    // Keyed on the credential id so the secret is not copied into the cache.
    this.cacheKey = JSON.stringify([
      "url" in config.controlPlane ? config.controlPlane.url : "service-binding",
      CREDENTIAL_PATTERN.exec(config.serviceCredential)?.[1] ?? "",
      this.capabilities,
    ]);
  }

  /**
   * Sends one gateway request. The body is size-checked before any network
   * call; a 401 is the only failure that is retried, once, with a new grant
   * and a new idempotency key because it is rejected before dispatch.
   */
  async request(
    path: "/v1/responses" | "/v1/chat/completions",
    body: Readonly<Record<string, unknown>>,
    operation: TkslopperOperation,
  ): Promise<TkslopperGatewayResult> {
    const serialised = JSON.stringify(body);
    const bytes = new TextEncoder().encode(serialised).byteLength;
    if (bytes > this.config.maxRequestBytes)
      throw new TkslopperError(
        `Model request is ${bytes} bytes, above the ${this.config.maxRequestBytes} byte tkslopper limit`,
        false,
      );

    let grant = await this.grant();
    let response = await this.send(path, serialised, operation, grant);
    if (response.status === 401) {
      this.invalidate(grant);
      const rejectedId = response.headers.get("x-tkslopper-request-id");
      console.error(
        `tkslopper ${operation} grant rejected${rejectedId ? ` (request ${rejectedId})` : ""}; re-exchanging once`,
      );
      await response.body?.cancel();
      grant = await this.grant();
      response = await this.send(path, serialised, operation, grant);
    }
    const gatewayRequestId =
      response.headers.get("x-tkslopper-request-id") ?? undefined;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.invalidate(grant);
      const error = (await response.json().catch(() => null)) as ErrorBody | null;
      const code =
        typeof error?.error?.code === "string" ? error.error.code : "unknown";
      const requestId =
        gatewayRequestId ??
        (typeof error?.request_id === "string" ? error.request_id : undefined);
      console.error(
        `tkslopper ${operation} failed: HTTP ${response.status} ${code}${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        typeof error?.error?.message === "string"
          ? error.error.message
          : `HTTP ${response.status}`,
        retryableStatus(response.status),
        response.status,
        requestId,
      );
    }

    const parsed: unknown = await response.json().catch(() => undefined);
    if (!isRecord(parsed))
      throw new TkslopperError(
        "Malformed gateway response",
        true,
        response.status,
        gatewayRequestId,
      );
    return {
      body: parsed,
      ...(gatewayRequestId ? { gatewayRequestId } : {}),
    };
  }

  private async send(
    path: string,
    serialised: string,
    operation: TkslopperOperation,
    grant: Grant,
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `tapplet:${operation}:${crypto.randomUUID()}`,
      },
      body: serialised,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    };
    try {
      return await this.dispatch(this.config.gateway, path, init);
    } catch (error) {
      // An aborted attempt may still have reached the provider and been
      // charged, so it is surfaced as retryable but never retried here.
      console.error(`tkslopper ${operation} request failed: ${failureDetail(error)}`);
      throw new TkslopperError(
        `Model request ${describeFailure(error)}`,
        true,
      );
    }
  }

  private dispatch(
    target: TkslopperTarget,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    // Service bindings route on the path only; the public URL keeps working
    // when no binding is configured.
    if ("binding" in target)
      return target.binding.fetch(new Request(`${INTERNAL_ORIGIN}${path}`, init));
    return this.fetcher(`${target.url}${path}`, init);
  }

  private async grant(): Promise<Grant> {
    const slot = this.cache.slot(this.cacheKey);
    const current = slot.grant;
    if (current && this.now() < current.refreshAt) return current;
    let pending = slot.pending;
    // A shared exchange belongs to the request that started it; if that
    // request is cancelled its promise may never settle, so an exchange older
    // than its own timeout is replaced rather than awaited.
    if (!pending || this.now() - pending.startedAt >= EXCHANGE_WAIT_MS) {
      const promise = this.exchange().then((grant) => {
        slot.grant = grant;
        return grant;
      });
      const started = { promise, startedAt: this.now() };
      slot.pending = started;
      const settle = () => {
        if (slot.pending === started) delete slot.pending;
      };
      promise.then(settle, settle);
      pending = started;
    }
    try {
      return await withDeadline(
        pending.promise,
        pending.startedAt + EXCHANGE_WAIT_MS - this.now(),
      );
    } catch (error) {
      // A control-plane blip must not fail requests while the cached grant is
      // still valid. Rejected credentials and kill switches are not retryable
      // and still fail.
      if (
        error instanceof TkslopperError &&
        error.retryable &&
        current &&
        slot.grant === current &&
        current.expiresAt - this.now() > STALE_GRANT_MARGIN_MS
      )
        return current;
      throw error;
    }
  }

  private invalidate(grant: Grant): void {
    const slot = this.cache.slot(this.cacheKey);
    if (slot.grant === grant) delete slot.grant;
  }

  private async exchange(): Promise<Grant> {
    let response: Response;
    try {
      response = await this.dispatch(
        this.config.controlPlane,
        "/v1/token",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.serviceCredential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            capabilities: this.capabilities,
            ttl_seconds: GRANT_TTL_SECONDS,
          }),
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        },
      );
    } catch (error) {
      console.error(`tkslopper grant exchange failed: ${failureDetail(error)}`);
      throw new TkslopperError(
        `Model access grant ${describeFailure(error)}`,
        true,
      );
    }
    const requestId = response.headers.get("x-tkslopper-request-id") ?? undefined;
    const body = (await response.json().catch(() => null)) as
      | (ErrorBody & {
          access_token?: unknown;
          token_type?: unknown;
          expires_in?: unknown;
          capabilities?: unknown;
        })
      | null;
    if (!response.ok) {
      const code =
        typeof body?.error?.code === "string" ? body.error.code : "unknown";
      console.error(
        `tkslopper grant exchange failed: HTTP ${response.status} ${code}${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        `Model access grant failed: HTTP ${response.status} ${code}`,
        retryableStatus(response.status),
        response.status,
        requestId,
      );
    }
    if (
      typeof body?.access_token !== "string" ||
      !body.access_token ||
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer" ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      console.error(
        `tkslopper grant exchange returned a malformed grant${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        "Malformed model access grant",
        true,
        response.status,
        requestId,
      );
    }
    const granted = Array.isArray(body.capabilities) ? body.capabilities : [];
    const missing = this.capabilities.filter((alias) => !granted.includes(alias));
    if (missing.length) {
      console.error(
        `tkslopper grant is missing capabilities ${missing.join(", ")}${requestId ? ` (request ${requestId})` : ""}`,
      );
      throw new TkslopperError(
        "Model access grant lacks a capability",
        false,
        response.status,
        requestId,
      );
    }
    const lifetime = body.expires_in * 1_000;
    const expiresAt = this.now() + lifetime;
    // Refresh a minute early, or halfway through a grant shorter than two
    // minutes, so a short environment TTL cannot force an exchange per call.
    return {
      accessToken: body.access_token,
      expiresAt,
      refreshAt: expiresAt - Math.min(GRANT_REFRESH_MARGIN_MS, lifetime / 2),
    };
  }
}

type Outcome =
  | { kind: "complete"; text: string }
  | { kind: "truncated" }
  | { kind: "incomplete" }
  | { kind: "refused" }
  | { kind: "empty" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  return record(Array.isArray(body.choices) ? body.choices[0] : undefined);
}

/** A Responses result is complete only when every condition holds. */
export function responsesOutcome(body: Record<string, unknown>): Outcome {
  const output: unknown[] = Array.isArray(body.output) ? body.output : [];
  const parts = output
    .filter(isRecord)
    .filter((item) => item.type === "message")
    .flatMap((item): unknown[] => (Array.isArray(item.content) ? item.content : []))
    .filter(isRecord);
  if (parts.some((part) => part.type === "refusal")) return { kind: "refused" };
  if (body.status === "incomplete") {
    return record(body.incomplete_details).reason === "max_output_tokens"
      ? { kind: "truncated" }
      : { kind: "incomplete" };
  }
  if (body.status !== "completed") return { kind: "incomplete" };
  const text = parts
    .map((part) =>
      part.type === "output_text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
  return text ? { kind: "complete", text } : { kind: "empty" };
}

/** A Chat result is complete only when it stopped with non-empty content. */
export function chatOutcome(body: Record<string, unknown>): Outcome {
  const choice = firstChoice(body);
  const message = record(choice.message);
  const finishReason = choice.finish_reason;
  if (finishReason === "content_filter") return { kind: "refused" };
  if (typeof message.refusal === "string" && message.refusal)
    return { kind: "refused" };
  if (finishReason === "length") return { kind: "truncated" };
  if (finishReason !== "stop") return { kind: "incomplete" };
  return typeof message.content === "string" && message.content
    ? { kind: "complete", text: message.content }
    : { kind: "empty" };
}

function outcomeError(
  outcome: Exclude<Outcome, { kind: "complete" }>,
): ModelProviderError {
  switch (outcome.kind) {
    case "truncated":
      return new ModelProviderError("Model output truncated", true);
    case "incomplete":
      return new ModelProviderError("Model output incomplete", true);
    case "refused":
      return new ModelProviderError("Model refused", false);
    case "empty":
      return new ModelProviderError("No model output", true);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function effortField(
  endpoint: TkslopperArtifactEndpoint,
  effort: PortableEffort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  return endpoint === "chat"
    ? { reasoning_effort: effort }
    : { reasoning: { effort } };
}

export interface TkslopperModelProviderOptions extends TkslopperClientOptions {
  client?: TkslopperClient;
}

export class TkslopperModelProvider implements ModelProvider {
  readonly name: string;
  private readonly client: TkslopperClient;

  constructor(
    private readonly config: TkslopperConfig,
    options: TkslopperModelProviderOptions = {},
  ) {
    this.name = `tkslopper:${config.artifactAlias}`;
    this.client = options.client ?? new TkslopperClient(config, options);
  }

  generate(b: TeacherBrief, e: Exemplar[], trace?: OperationalTraceContext) {
    return this.artifact("generate", generationPrompt(b, e), trace);
  }

  revise(
    h: string,
    c: DesignCard | undefined,
    i: string,
    b: TeacherBrief,
    trace?: OperationalTraceContext,
  ) {
    return this.artifact("revise", revisionPrompt(h, c, i, b), trace);
  }

  repair(
    c: unknown,
    i: string[],
    context?: RepairContext,
    trace?: OperationalTraceContext,
  ) {
    return this.artifact("repair", repairPrompt(c, i, context), trace);
  }

  async moderate(
    html: string,
    trace?: OperationalTraceContext,
  ): Promise<ModerationDecision> {
    const r = await this.complete(
      "moderate",
      "responses",
      MODERATION_SYSTEM_PROMPT,
      html,
      {
        model: this.config.reviewAlias,
        instructions: MODERATION_SYSTEM_PROMPT,
        input: html,
        text: { format: { type: "json_object" } },
        max_output_tokens: REVIEW_MAX_OUTPUT_TOKENS,
        ...effortField("responses", this.config.reviewEffort),
        stream: false,
      },
      true,
      trace,
    );
    if (
      !r ||
      typeof r !== "object" ||
      typeof Reflect.get(r, "safe") !== "boolean" ||
      !Array.isArray(Reflect.get(r, "categories"))
    )
      throw new ModelProviderError("Invalid moderation response", true);
    return {
      safe: Reflect.get(r, "safe") as boolean,
      categories: Reflect.get(r, "categories") as string[],
    };
  }

  private artifact(
    operation: "generate" | "revise" | "repair",
    prompt: string,
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const endpoint = this.config.artifactEndpoint;
    const body =
      endpoint === "chat"
        ? {
            model: this.config.artifactAlias,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" },
            max_tokens: ARTIFACT_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
            ...effortField("chat", this.config.artifactEffort),
            stream: false,
          }
        : {
            model: this.config.artifactAlias,
            instructions: SYSTEM_PROMPT,
            input: prompt,
            text: { format: { type: "json_object" } },
            max_output_tokens: ARTIFACT_MAX_OUTPUT_TOKENS,
            ...effortField("responses", this.config.artifactEffort),
            stream: false,
          };
    return this.complete(
      operation,
      endpoint,
      SYSTEM_PROMPT,
      prompt,
      body,
      false,
      trace,
    );
  }

  private async complete(
    operation: ModelOperation,
    endpoint: TkslopperArtifactEndpoint,
    system: string,
    user: string,
    body: Readonly<Record<string, unknown>>,
    requireJson: boolean,
    trace?: OperationalTraceContext,
  ): Promise<unknown> {
    const started = performance.now();
    const encoder = new TextEncoder();
    const base = {
      operation,
      started,
      systemBytes: encoder.encode(system).byteLength,
      inputBytes: encoder.encode(user).byteLength,
    };
    let result: TkslopperGatewayResult;
    try {
      result = await this.client.request(
        endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses",
        body,
        operation,
      );
    } catch (error) {
      this.emitTrace(trace, {
        ...base,
        status: "error",
        ...(error instanceof TkslopperError && error.gatewayRequestId
          ? { gatewayRequestId: error.gatewayRequestId }
          : {}),
      });
      throw error;
    }
    const responseBody = result.body;
    const outcome =
      endpoint === "chat"
        ? chatOutcome(responseBody)
        : responsesOutcome(responseBody);
    const metadata = {
      ...base,
      body: responseBody,
      endpoint,
      ...(result.gatewayRequestId
        ? { gatewayRequestId: result.gatewayRequestId }
        : {}),
    };
    if (outcome.kind !== "complete") {
      this.emitTrace(trace, { ...metadata, status: "error" });
      throw outcomeError(outcome);
    }
    try {
      const parsed: unknown = JSON.parse(outcome.text);
      this.emitTrace(trace, { ...metadata, status: "success" });
      return parsed;
    } catch {
      this.emitTrace(trace, {
        ...metadata,
        status: requireJson ? "error" : "success",
      });
      if (requireJson)
        throw new ModelProviderError("Malformed model JSON", false);
      return outcome.text;
    }
  }

  private emitTrace(
    trace: OperationalTraceContext | undefined,
    event: {
      operation: ModelOperation;
      status: "success" | "error";
      started: number;
      systemBytes: number;
      inputBytes: number;
      endpoint?: TkslopperArtifactEndpoint;
      body?: Record<string, unknown>;
      gatewayRequestId?: string;
    },
  ): void {
    if (!trace) return;
    const body = event.body;
    const chat = event.endpoint === "chat";
    const resolvedModel = stringOrUndefined(body?.model);
    const responseId = stringOrUndefined(body?.id);
    const finishReason = body
      ? chat
        ? stringOrUndefined(firstChoice(body).finish_reason)
        : stringOrUndefined(record(body.incomplete_details).reason) ??
          stringOrUndefined(body.status)
      : undefined;
    const usage = record(body?.usage);
    const inputTokens = numberOrUndefined(
      chat ? usage.prompt_tokens : usage.input_tokens,
    );
    const outputTokens = numberOrUndefined(
      chat ? usage.completion_tokens : usage.output_tokens,
    );
    const totalTokens = numberOrUndefined(usage.total_tokens);
    emitOperationalTrace(trace.sink, {
      kind: "model_call",
      requestId: trace.requestId,
      operation: event.operation,
      provider: this.name,
      configuredModel:
        event.operation === "moderate"
          ? this.config.reviewAlias
          : this.config.artifactAlias,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(responseId ? { responseId } : {}),
      ...(event.gatewayRequestId
        ? { gatewayRequestId: event.gatewayRequestId }
        : {}),
      status: event.status,
      durationMs: Math.round(performance.now() - event.started),
      systemBytes: event.systemBytes,
      inputBytes: event.inputBytes,
      ...(finishReason ? { finishReason } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    });
  }
}

export class TkslopperImageSafetyInspector implements ImageSafetyInspector {
  private readonly client: TkslopperClient;

  constructor(
    private readonly config: TkslopperConfig,
    options: TkslopperModelProviderOptions = {},
  ) {
    this.client = options.client ?? new TkslopperClient(config, options);
  }

  async inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview> {
    let result: TkslopperGatewayResult;
    try {
      result = await this.client.request(
        "/v1/responses",
        {
          model: this.config.imageAlias,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: IMAGE_SAFETY_QUESTION },
                { type: "input_image", image_url: imageDataUrl(bytes, mediaType) },
              ],
            },
          ],
          max_output_tokens: REVIEW_MAX_OUTPUT_TOKENS,
          ...effortField("responses", this.config.imageEffort),
          stream: false,
        },
        "image_review",
      );
    } catch (error) {
      const requestId =
        error instanceof TkslopperError ? error.gatewayRequestId : undefined;
      console.error(
        `Image safety review failed: ${error instanceof Error ? error.message : "unknown error"}${requestId ? ` (request ${requestId})` : ""}`,
      );
      return { status: "unavailable" };
    }
    const requestSuffix = result.gatewayRequestId
      ? ` (request ${result.gatewayRequestId})`
      : "";
    const outcome = responsesOutcome(result.body);
    if (outcome.kind !== "complete") {
      console.error(`Image safety review was ${outcome.kind}${requestSuffix}`);
      return { status: "unavailable" };
    }
    const review = parseImageSafetyAnswer(outcome.text);
    if (review) return review;
    console.error(`Image safety review returned an invalid answer${requestSuffix}`);
    return { status: "unavailable" };
  }
}

export function createTkslopperModelProvider(
  env: StudioEnv,
  options: TkslopperClientOptions = {},
): ModelProvider {
  const result = readTkslopperConfig(env);
  if (!result.ok) return new UnavailableModelProvider(result.reason);
  return new TkslopperModelProvider(result.config, options);
}

export function createTkslopperImageSafetyInspector(
  env: StudioEnv,
  options: TkslopperClientOptions = {},
): ImageSafetyInspector {
  const result = readTkslopperConfig(env);
  if (result.ok) return new TkslopperImageSafetyInspector(result.config, options);
  const reason = result.reason;
  return {
    async inspect(): Promise<ImageSafetyReview> {
      console.error(`Image safety review unavailable: ${reason}`);
      return { status: "unavailable" };
    },
  };
}
