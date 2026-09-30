import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredModelProvider,
  handleAdminRequest,
  loadConfiguredModelProvider,
} from "../src/admin";
import {
  generationPrompt,
  MODERATION_SYSTEM_PROMPT,
  repairPrompt,
  revisionPrompt,
  SYSTEM_PROMPT,
} from "../src/ai/prompts";
import { ModelProviderError } from "../src/ai/provider";
import {
  createTkslopperModelProvider,
  readTkslopperConfig,
  TkslopperGrantCache,
  TkslopperImageSafetyInspector,
  TkslopperModelProvider,
} from "../src/ai/tkslopper";
import type { TkslopperConfig } from "../src/ai/tkslopper";
import type { StudioEnv } from "../src/env";
import { generateArtifact, InvalidModelOutputError } from "../src/generation";
import {
  IMAGE_SAFETY_QUESTION,
  OpenCodeGoImageSafetyInspector,
} from "../src/imageSafety";
import { createImageSafetyInspector } from "../src/index";
import { MemoryOperationalTraceSink } from "../src/operationalTrace";
import {
  validateChatRequest,
  validateResponsesRequest,
  validateTokenExchangeRequest,
} from "./tkslopperSchema";

const CONTROL = "https://control.tkslopper.test";
const GATEWAY = "https://gateway.tkslopper.test";
const CREDENTIAL_SECRET = "credential-secret-value-0123456789";
const CREDENTIAL = `tksvc_cred0001abcd_${CREDENTIAL_SECRET}`;
const ACCESS_TOKEN_PREFIX = "access-token-secret-";
const ARTIFACT = "tapplet.artifact.v1";
const REVIEW = "tapplet.review.v1";
const IMAGE = "tapplet.image.v1";
const adminToken = "admin-token-with-at-least-thirty-two-characters";
const encryptionSecret = "encryption-key-with-at-least-thirty-two-characters";

const brief = {
  level: "P5",
  subject: "Maths",
  learningObjective: "Fractions",
  studentAction: "Choose",
};
const html =
  '<!doctype html><html><head><style>body{color:black}</style></head><body>Hello<script>document.body.dataset.ok="1"</script></body></html>';
const artifactJson = JSON.stringify({ html });
const moderationJson = JSON.stringify({ safe: true, categories: [] });

function tkEnv(values: Partial<StudioEnv> = {}): StudioEnv {
  return {
    AI_PROVIDER: "fixture",
    AI_MODEL: "fixture-v1",
    AI_BASE_URL: "https://models.example.test/v1",
    PUBLIC_PLAYER_ORIGIN: "https://tapplet.example.test",
    INFERENCE_TRANSPORT: "tkslopper",
    TKSLOPPER_CONTROL_PLANE_URL: CONTROL,
    TKSLOPPER_GATEWAY_URL: GATEWAY,
    TKSLOPPER_SERVICE_CREDENTIAL: CREDENTIAL,
    TKSLOPPER_ARTIFACT_ALIAS: ARTIFACT,
    TKSLOPPER_REVIEW_ALIAS: REVIEW,
    TKSLOPPER_IMAGE_ALIAS: IMAGE,
    ...values,
  } as StudioEnv;
}

function config(values: Partial<StudioEnv> = {}): TkslopperConfig {
  const result = readTkslopperConfig(tkEnv(values));
  if (!result.ok) throw new Error(result.reason);
  return result.config;
}

interface Call {
  url: string;
  signal: AbortSignal | null | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply = Response | Error | (() => Response | Promise<Response>);

function grantResponse(count: number, expiresIn = 900): Response {
  return Response.json({
    grant_id: `grant-${count}`,
    access_token: `${ACCESS_TOKEN_PREFIX}${count}`,
    token_type: "Bearer",
    expires_in: expiresIn,
    capabilities: [ARTIFACT, REVIEW, IMAGE],
  });
}

function gateway(
  replies: Reply[],
  exchange?: (count: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const exchanges: Call[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const call = {
      url: request.url,
      signal: init ? init.signal : request.signal,
      headers,
      body: (await request.json()) as Record<string, unknown>,
    };
    if (new URL(request.url).pathname === "/v1/token") {
      exchanges.push(call);
      return exchange
        ? exchange(exchanges.length)
        : grantResponse(exchanges.length);
    }
    calls.push(call);
    const next = replies.shift();
    if (!next) throw new Error("Unexpected gateway call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return {
    fetch: mock as unknown as typeof fetch,
    mock,
    calls,
    exchanges,
  };
}

function text(value: string) {
  return { type: "output_text", text: value, annotations: [] };
}

function message(...content: unknown[]) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content,
  };
}

function responsesResponse(
  body: Record<string, unknown> = {},
  requestId = "req_gateway_1",
): Response {
  return Response.json(
    {
      id: "resp_1",
      object: "response",
      model: ARTIFACT,
      status: "completed",
      output: [message(text(artifactJson))],
      usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      ...body,
    },
    { headers: { "x-tkslopper-request-id": requestId } },
  );
}

function chatResponse(
  choice: { content: string | null; refusal?: string | null; finish: string | null },
  requestId = "req_chat_1",
): Response {
  return Response.json(
    {
      id: "chatcmpl_1",
      object: "chat.completion",
      model: ARTIFACT,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: choice.content,
            refusal: choice.refusal ?? null,
          },
          finish_reason: choice.finish,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    },
    { headers: { "x-tkslopper-request-id": requestId } },
  );
}

function errorResponse(status: number, code = "error"): Response {
  return Response.json(
    {
      error: { message: `Gateway ${code}`, type: code, code },
      request_id: `req_error_${status}`,
    },
    { status, headers: { "x-tkslopper-request-id": `req_error_${status}` } },
  );
}

function provider(
  g: ReturnType<typeof gateway>,
  values: Partial<StudioEnv> = {},
  extra: { grantCache?: TkslopperGrantCache; now?: () => number } = {},
) {
  return new TkslopperModelProvider(config(values), {
    fetch: g.fetch,
    grantCache: extra.grantCache ?? new TkslopperGrantCache(),
    ...(extra.now ? { now: extra.now } : {}),
  });
}

function inspector(
  g: ReturnType<typeof gateway>,
  values: Partial<StudioEnv> = {},
) {
  return new TkslopperImageSafetyInspector(config(values), {
    fetch: g.fetch,
    grantCache: new TkslopperGrantCache(),
  });
}

async function rejection(promise: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderError);
    return error as ModelProviderError;
  }
  throw new Error("Expected the promise to reject");
}

const KEY_PATTERN =
  /^tapplet:(generate|revise|repair|moderate|image_review):[0-9a-f-]{36}$/;

describe("tkslopper configuration", () => {
  it("defaults efforts, endpoint and request limit", () => {
    expect(config()).toMatchObject({
      controlPlaneUrl: CONTROL,
      gatewayUrl: GATEWAY,
      artifactEffort: "high",
      reviewEffort: "low",
      artifactEndpoint: "responses",
      maxRequestBytes: 1_048_576,
    });
    expect(config()).not.toHaveProperty("imageEffort");
  });

  it("reports every missing or invalid value without falling back", () => {
    const result = readTkslopperConfig(
      tkEnv({
        TKSLOPPER_CONTROL_PLANE_URL: "http://control.example.test",
        TKSLOPPER_GATEWAY_URL: undefined,
        TKSLOPPER_SERVICE_CREDENTIAL: "tkgk_group_key",
        TKSLOPPER_ARTIFACT_ALIAS: "gpt-5",
        TKSLOPPER_REVIEW_ALIAS: "",
        TKSLOPPER_IMAGE_ALIAS: "Tapplet.image.v1",
        TKSLOPPER_ARTIFACT_EFFORT: "turbo",
        TKSLOPPER_ARTIFACT_ENDPOINT: "completions",
        TKSLOPPER_MAX_REQUEST_BYTES: "lots",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const name of [
      "TKSLOPPER_CONTROL_PLANE_URL",
      "TKSLOPPER_GATEWAY_URL",
      "TKSLOPPER_SERVICE_CREDENTIAL",
      "TKSLOPPER_ARTIFACT_ALIAS",
      "TKSLOPPER_REVIEW_ALIAS",
      "TKSLOPPER_IMAGE_ALIAS",
      "TKSLOPPER_ARTIFACT_EFFORT",
      "TKSLOPPER_ARTIFACT_ENDPOINT",
      "TKSLOPPER_MAX_REQUEST_BYTES",
    ])
      expect(result.reason).toContain(name);
    expect(result.reason).not.toContain("tkgk_group_key");
  });

  it("requires HTTPS even for loopback URLs and trims trailing slashes", () => {
    expect(
      readTkslopperConfig(tkEnv({ TKSLOPPER_GATEWAY_URL: "http://localhost:8787" })).ok,
    ).toBe(false);
    expect(config({ TKSLOPPER_GATEWAY_URL: `${GATEWAY}/` }).gatewayUrl).toBe(GATEWAY);
  });
});

describe("tkslopper request shape", () => {
  it("sends strict Responses bodies for every model operation", async () => {
    const g = gateway([
      responsesResponse(),
      responsesResponse(),
      responsesResponse(),
      responsesResponse({ model: REVIEW, output: [message(text(moderationJson))] }),
    ]);
    const p = provider(g);

    await p.generate(brief, []);
    await p.revise(html, undefined, "Make it blue", brief);
    await p.repair({ html: "x" }, ["Missing body"], { brief });
    await expect(p.moderate(html)).resolves.toEqual({ safe: true, categories: [] });

    expect(p.name).toBe(`tkslopper:${ARTIFACT}`);
    expect(g.exchanges).toHaveLength(1);
    expect(g.calls.map((call) => call.url)).toEqual(
      Array(4).fill(`${GATEWAY}/v1/responses`),
    );
    const operations = ["generate", "revise", "repair", "moderate"];
    for (const [index, call] of g.calls.entries()) {
      expect(validateResponsesRequest(call.body)).toEqual([]);
      expect(Object.keys(call.headers).sort()).toEqual([
        "authorization",
        "content-type",
        "idempotency-key",
      ]);
      expect(call.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}1`);
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.headers["idempotency-key"]).toMatch(KEY_PATTERN);
      expect(call.headers["idempotency-key"]).toContain(
        `tapplet:${operations[index]}:`,
      );
      expect(Object.keys(call.body).sort()).toEqual([
        "input",
        "instructions",
        "max_output_tokens",
        "model",
        "reasoning",
        "stream",
        "text",
      ]);
      expect(call.body.stream).toBe(false);
      expect(call.body.text).toEqual({ format: { type: "json_object" } });
    }
    expect(g.calls[0]?.body).toMatchObject({
      model: ARTIFACT,
      instructions: SYSTEM_PROMPT,
      input: generationPrompt(brief, []),
      max_output_tokens: 32000,
      reasoning: { effort: "high" },
    });
    expect(g.calls[1]?.body.input).toBe(
      revisionPrompt(html, undefined, "Make it blue", brief),
    );
    expect(g.calls[2]?.body.input).toBe(
      repairPrompt({ html: "x" }, ["Missing body"], { brief }),
    );
    expect(g.calls[3]?.body).toMatchObject({
      model: REVIEW,
      instructions: MODERATION_SYSTEM_PROMPT,
      input: html,
      max_output_tokens: 500,
      reasoning: { effort: "low" },
    });
  });

  it("sends strict Chat bodies for artifacts while review stays on Responses", async () => {
    const g = gateway([
      chatResponse({ content: artifactJson, finish: "stop" }),
      responsesResponse({ model: REVIEW, output: [message(text(moderationJson))] }),
    ]);
    const p = provider(g, { TKSLOPPER_ARTIFACT_ENDPOINT: "chat" });

    await expect(p.generate(brief, [])).resolves.toEqual({ html });
    await p.moderate(html);

    expect(g.calls.map((call) => call.url)).toEqual([
      `${GATEWAY}/v1/chat/completions`,
      `${GATEWAY}/v1/responses`,
    ]);
    const body = g.calls[0]!.body;
    expect(validateChatRequest(body)).toEqual([]);
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "reasoning_effort",
      "response_format",
      "stream",
      "temperature",
    ]);
    expect(body).toEqual({
      model: ARTIFACT,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: generationPrompt(brief, []) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 32000,
      temperature: 0.2,
      reasoning_effort: "high",
      stream: false,
    });
    expect(validateResponsesRequest(g.calls[1]!.body)).toEqual([]);
  });

  it("exchanges the service credential for de-duplicated capabilities", async () => {
    const g = gateway([responsesResponse()]);
    await provider(g, { TKSLOPPER_IMAGE_ALIAS: REVIEW }).generate(brief, []);

    expect(g.exchanges).toHaveLength(1);
    const exchange = g.exchanges[0]!;
    expect(exchange.url).toBe(`${CONTROL}/v1/token`);
    expect(Object.keys(exchange.headers).sort()).toEqual([
      "authorization",
      "content-type",
    ]);
    expect(exchange.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(exchange.body).toEqual({
      capabilities: [ARTIFACT, REVIEW],
      ttl_seconds: 900,
    });
    expect(validateTokenExchangeRequest(exchange.body)).toEqual([]);
  });

  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
    ["minimal", "low"],
    ["none", undefined],
    ["omit", undefined],
  ] as const)("maps configured effort %s to %s", async (configured, expected) => {
    const values = {
      TKSLOPPER_ARTIFACT_EFFORT: configured,
      TKSLOPPER_REVIEW_EFFORT: configured,
      TKSLOPPER_IMAGE_EFFORT: configured,
    };
    const g = gateway([
      responsesResponse(),
      responsesResponse({ output: [message(text(moderationJson))] }),
      responsesResponse({ output: [message(text("SAFE\nA diagram."))] }),
      chatResponse({ content: artifactJson, finish: "stop" }),
    ]);
    const p = provider(g, values);
    await p.generate(brief, []);
    await p.moderate(html);
    await new TkslopperImageSafetyInspector(config(values), {
      fetch: g.fetch,
      grantCache: new TkslopperGrantCache(),
    }).inspect(new Uint8Array([1, 2, 3]), "image/jpeg");
    await provider(g, { ...values, TKSLOPPER_ARTIFACT_ENDPOINT: "chat" }).generate(
      brief,
      [],
    );

    const [generate, moderate, image, chat] = g.calls.map((call) => call.body);
    for (const body of [generate, moderate, image]) {
      if (expected) expect(body?.reasoning).toEqual({ effort: expected });
      else expect(body).not.toHaveProperty("reasoning");
      expect(validateResponsesRequest(body)).toEqual([]);
      expect(body).not.toHaveProperty("thinking");
    }
    if (expected) expect(chat?.reasoning_effort).toBe(expected);
    else expect(chat).not.toHaveProperty("reasoning_effort");
    expect(validateChatRequest(chat)).toEqual([]);
  });

  it("has a validator that rejects fields the gateway forbids", () => {
    const responses = { model: ARTIFACT, input: "hello" };
    expect(validateResponsesRequest(responses)).toEqual([]);
    for (const invalid of [
      { ...responses, thinking: { type: "enabled" } },
      { ...responses, reasoning: { effort: "high", exclude: true } },
      { ...responses, reasoning: { effort: "xhigh" } },
      { ...responses, reasoning: { effort: "minimal" } },
      { ...responses, stream: true },
      { ...responses, tools: [] },
      { ...responses, model: "gpt-5" },
    ])
      expect(validateResponsesRequest(invalid)).not.toEqual([]);
    const chat = {
      model: ARTIFACT,
      messages: [{ role: "user", content: "hello" }],
    };
    expect(validateChatRequest(chat)).toEqual([]);
    for (const invalid of [
      { ...chat, reasoning_effort: "max" },
      { ...chat, thinking: { type: "disabled" } },
      { ...chat, max_tokens: 1, max_completion_tokens: 1 },
      { ...chat, provider: { order: [] } },
    ])
      expect(validateChatRequest(invalid)).not.toEqual([]);
  });

  it("uses the image default of no reasoning", async () => {
    const g = gateway([responsesResponse({ output: [message(text("SAFE"))] })]);
    await inspector(g).inspect(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(g.calls[0]?.body).not.toHaveProperty("reasoning");
  });
});

describe("tkslopper outcomes", () => {
  it.each([
    [
      "concatenates every output_text in message items and ignores reasoning",
      {
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "not part of the answer" }],
          },
          message(text('{"html":'), text(JSON.stringify(html))),
          message(text("}")),
        ],
      },
      { html },
    ],
    [
      "returns non-JSON text to the repair loop",
      { output: [message(text("not json"))] },
      "not json",
    ],
  ])("Responses %s", async (_name, body, expected) => {
    const g = gateway([responsesResponse(body)]);
    await expect(provider(g).generate(brief, [])).resolves.toEqual(expected);
  });

  it.each([
    [
      "truncation",
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      "Model output truncated",
      true,
    ],
    [
      "another incomplete reason",
      { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      "Model output incomplete",
      true,
    ],
    ["a failed status", { status: "failed" }, "Model output incomplete", true],
    [
      "a refusal part",
      { output: [message(text("partial"), { type: "refusal", refusal: "No." })] },
      "Model refused",
      false,
    ],
    ["empty text", { output: [message(text(""))] }, "No model output", true],
    ["no output", { output: [] }, "No model output", true],
  ])("Responses %s", async (_name, body, messageText, retryable) => {
    const g = gateway([responsesResponse(body)]);
    const error = await rejection(provider(g).generate(brief, []));
    expect(error.message).toBe(messageText);
    expect(error.retryable).toBe(retryable);
  });

  it.each([
    ["length", { content: '{"html":"<!doc', finish: "length" }, "Model output truncated", true],
    ["content_filter", { content: null, finish: "content_filter" }, "Model refused", false],
    ["null", { content: '{"html":"', finish: null }, "Model output incomplete", true],
    ["stop without content", { content: "", finish: "stop" }, "No model output", true],
  ] as const)("Chat %s", async (_name, choice, messageText, retryable) => {
    const g = gateway([chatResponse(choice)]);
    const error = await rejection(
      provider(g, { TKSLOPPER_ARTIFACT_ENDPOINT: "chat" }).generate(brief, []),
    );
    expect(error.message).toBe(messageText);
    expect(error.retryable).toBe(retryable);
  });

  it("accepts a complete Chat stop", async () => {
    const g = gateway([chatResponse({ content: artifactJson, finish: "stop" })]);
    await expect(
      provider(g, { TKSLOPPER_ARTIFACT_ENDPOINT: "chat" }).generate(brief, []),
    ).resolves.toEqual({ html });
  });

  it("requires valid JSON for moderation", async () => {
    const g = gateway([responsesResponse({ output: [message(text("SAFE"))] })]);
    const error = await rejection(provider(g).moderate(html));
    expect(error.message).toBe("Malformed model JSON");
    expect(error.retryable).toBe(false);
  });
});

describe("tkslopper errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [400, "invalid_request", false],
    [402, "budget_exceeded", false],
    [403, "authorization_failed", false],
    [409, "conflict", false],
    [413, "invalid_request", false],
    [415, "invalid_request", false],
    [429, "rate_limit_exceeded", true],
    [500, "internal_error", true],
    [502, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [504, "provider_unavailable", true],
  ] as const)("maps HTTP %i to retryable %s without retrying", async (status, code, retryable) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([errorResponse(status, code)]);
    const error = await rejection(provider(g).generate(brief, []));
    expect(error.retryable).toBe(retryable);
    expect(g.calls).toHaveLength(1);
    expect(g.exchanges).toHaveLength(1);
  });

  it("re-exchanges once after a 401 and retries with a new idempotency key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([errorResponse(401, "authentication_failed"), responsesResponse()]);
    await expect(provider(g).generate(brief, [])).resolves.toEqual({ html });
    expect(g.exchanges).toHaveLength(2);
    expect(g.calls).toHaveLength(2);
    expect(g.calls[0]?.headers["idempotency-key"]).not.toBe(
      g.calls[1]?.headers["idempotency-key"],
    );
    expect(g.calls[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}1`);
    expect(g.calls[1]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}2`);
  });

  it("stops after the single 401 retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([
      errorResponse(401, "authentication_failed"),
      errorResponse(401, "authentication_failed"),
    ]);
    const error = await rejection(provider(g).generate(brief, []));
    expect(error.retryable).toBe(false);
    expect(g.exchanges).toHaveLength(2);
    expect(g.calls).toHaveLength(2);
  });

  it("drops the cached grant after a 403 but keeps it after a 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forbidden = gateway([errorResponse(403, "authorization_failed"), responsesResponse()]);
    const p = provider(forbidden);
    await rejection(p.generate(brief, []));
    await p.generate(brief, []);
    expect(forbidden.exchanges).toHaveLength(2);

    const invalid = gateway([errorResponse(400, "invalid_request"), responsesResponse()]);
    const q = provider(invalid);
    await rejection(q.generate(brief, []));
    await q.generate(brief, []);
    expect(invalid.exchanges).toHaveLength(1);
  });

  it("surfaces transport failures and aborts as retryable without retrying", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const offline = gateway([new TypeError("Network connection lost")]);
    const offlineError = await rejection(provider(offline).generate(brief, []));
    expect(offlineError.retryable).toBe(true);
    expect(offline.calls).toHaveLength(1);

    const aborted = gateway([new DOMException("The operation timed out.", "TimeoutError")]);
    const abortError = await rejection(provider(aborted).generate(brief, []));
    expect(abortError.message).toBe("Model request timed out");
    expect(abortError.retryable).toBe(true);
    expect(aborted.calls).toHaveLength(1);
  });

  it("drops the replacement grant when the retry after a 401 is forbidden", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([
      errorResponse(401, "authentication_failed"),
      errorResponse(403, "authorization_failed"),
      responsesResponse(),
    ]);
    const p = provider(g);
    expect((await rejection(p.generate(brief, []))).retryable).toBe(false);
    await p.generate(brief, []);
    expect(g.exchanges).toHaveLength(3);
    expect(g.calls[2]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}3`);
  });

  it.each([
    ["non-JSON", () => new Response("fixture response", { status: 200 })],
    ["a JSON scalar", () => Response.json("fixture response")],
  ])("treats a %s success body as a retryable malformed response", async (_name, reply) => {
    const g = gateway([reply]);
    const error = await rejection(provider(g).generate(brief, []));
    expect(error.message).toBe("Malformed gateway response");
    expect(error.retryable).toBe(true);
    expect(g.calls).toHaveLength(1);
  });

  it("attaches an abort signal to the exchange and every gateway call", async () => {
    const g = gateway([responsesResponse()]);
    await provider(g).generate(brief, []);
    expect(g.exchanges[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(g.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a fresh idempotency key for every repair", async () => {
    const invalid = JSON.stringify({ html: "<p>Not a document</p>" });
    const g = gateway([
      responsesResponse({ output: [message(text(invalid))] }),
      responsesResponse({ output: [message(text(invalid))] }),
      responsesResponse({ output: [message(text(invalid))] }),
    ]);
    await expect(
      generateArtifact(provider(g), brief, [], { maxModelRepairs: 2 }),
    ).rejects.toBeInstanceOf(InvalidModelOutputError);
    const keys = g.calls.map((call) => call.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(keys.map((key) => key?.split(":")[1])).toEqual([
      "generate",
      "repair",
      "repair",
    ]);
  });
});

describe("tkslopper grant cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses a grant until a minute before expiry", async () => {
    let now = 1_000_000;
    const g = gateway([responsesResponse(), responsesResponse(), responsesResponse()]);
    const p = provider(g, {}, { now: () => now });
    await p.generate(brief, []);
    now += 839_000;
    await p.generate(brief, []);
    expect(g.exchanges).toHaveLength(1);
    now += 2_000;
    await p.generate(brief, []);
    expect(g.exchanges).toHaveLength(2);
    expect(g.calls[2]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}2`);
  });

  it("reuses a short grant until halfway through its lifetime", async () => {
    let now = 1_000_000;
    const g = gateway(
      [responsesResponse(), responsesResponse(), responsesResponse()],
      (count) => grantResponse(count, 60),
    );
    const p = provider(g, {}, { now: () => now });
    await p.generate(brief, []);
    now += 29_000;
    await p.generate(brief, []);
    expect(g.exchanges).toHaveLength(1);
    now += 2_000;
    await p.generate(brief, []);
    expect(g.exchanges).toHaveLength(2);
  });

  it("shares one in-flight exchange between concurrent requests", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const g = gateway(
      Array.from({ length: 5 }, () => responsesResponse()),
      async (count) => {
        await gate;
        return grantResponse(count);
      },
    );
    const p = provider(g);
    const pending = Promise.all(
      Array.from({ length: 5 }, () => p.generate(brief, [])),
    );
    await Promise.resolve();
    release();
    await expect(pending).resolves.toHaveLength(5);
    expect(g.exchanges).toHaveLength(1);
  });

  it("shares a grant between the model provider and image inspector", async () => {
    const cache = new TkslopperGrantCache();
    const g = gateway([
      responsesResponse(),
      responsesResponse({ output: [message(text("SAFE"))] }),
    ]);
    await new TkslopperModelProvider(config(), { fetch: g.fetch, grantCache: cache })
      .generate(brief, []);
    await new TkslopperImageSafetyInspector(config(), { fetch: g.fetch, grantCache: cache })
      .inspect(new Uint8Array([1]), "image/jpeg");
    expect(g.exchanges).toHaveLength(1);
  });

  it.each([
    ["a server error", () => errorResponse(503, "internal_error"), true],
    ["a rate limit", () => errorResponse(429, "rate_limit_exceeded"), true],
    ["a malformed grant", () => Response.json({ grant_id: "x" }), true],
    ["a rejected credential", () => errorResponse(401, "authentication_failed"), false],
    ["a missing entitlement", () => errorResponse(403, "authorization_failed"), false],
  ])("surfaces %s from the exchange", async (_name, reply, retryable) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([responsesResponse()], reply);
    const error = await rejection(provider(g).generate(brief, []));
    expect(error.retryable).toBe(retryable);
    expect(g.calls).toHaveLength(0);
  });

  it("surfaces an unreachable control plane as retryable and tries again next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const g = gateway([responsesResponse()], (count) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Network connection lost");
      return grantResponse(count);
    });
    const p = provider(g);
    const error = await rejection(p.generate(brief, []));
    expect(error.retryable).toBe(true);
    await expect(p.generate(brief, [])).resolves.toEqual({ html });
    expect(g.exchanges).toHaveLength(2);
  });
});

describe("tkslopper pre-flight size guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects oversized artifact bodies before any network call", async () => {
    const g = gateway([responsesResponse()]);
    const error = await rejection(
      provider(g, { TKSLOPPER_MAX_REQUEST_BYTES: "2048" }).generate(
        { ...brief, learningObjective: "x".repeat(5_000) },
        [],
      ),
    );
    expect(error.retryable).toBe(false);
    expect(g.mock).not.toHaveBeenCalled();
  });

  it("returns unavailable for oversized images without calling fetch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([responsesResponse()]);
    await expect(
      inspector(g, { TKSLOPPER_MAX_REQUEST_BYTES: "2048" }).inspect(
        new Uint8Array(3_000),
        "image/jpeg",
      ),
    ).resolves.toEqual({ status: "unavailable" });
    expect(g.mock).not.toHaveBeenCalled();
  });
});

describe("tkslopper image safety inspector", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a strict image review body without detail", async () => {
    const g = gateway([
      responsesResponse({ model: IMAGE, output: [message(text("SAFE\nA labelled diagram."))] }),
    ]);
    await expect(
      inspector(g).inspect(new Uint8Array([1, 2, 3]), "image/jpeg"),
    ).resolves.toEqual({ status: "clear" });
    const call = g.calls[0]!;
    expect(call.url).toBe(`${GATEWAY}/v1/responses`);
    expect(call.headers["idempotency-key"]).toMatch(/^tapplet:image_review:/);
    expect(validateResponsesRequest(call.body)).toEqual([]);
    expect(call.body).toEqual({
      model: IMAGE,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: IMAGE_SAFETY_QUESTION },
            { type: "input_image", image_url: "data:image/jpeg;base64,AQID" },
          ],
        },
      ],
      max_output_tokens: 500,
      stream: false,
    });
  });

  it("returns flagged findings with their reason", async () => {
    const g = gateway([
      responsesResponse({
        output: [message(text("UN"), text("SAFE:  A pupil\nface is visible."))],
      }),
    ]);
    await expect(
      inspector(g).inspect(new Uint8Array([1]), "image/jpeg"),
    ).resolves.toEqual({ status: "flagged", reason: "A pupil face is visible." });
  });

  it.each([
    ["an invalid answer", () => responsesResponse({ output: [message(text("maybe"))] })],
    [
      "truncation",
      () => responsesResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ],
    ["an incomplete status", () => responsesResponse({ status: "in_progress" })],
    [
      "a refusal",
      () => responsesResponse({ output: [message({ type: "refusal", refusal: "No." })] }),
    ],
    ["empty text", () => responsesResponse({ output: [message(text(""))] })],
    ["a gateway error", () => errorResponse(502, "provider_unavailable")],
    ["a budget error", () => errorResponse(402, "budget_exceeded")],
    ["a network failure", () => { throw new TypeError("offline"); }],
  ])("returns unavailable for %s without logging image data", async (_name, reply) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([reply]);
    const bytes = new Uint8Array(64).fill(7);
    await expect(inspector(g).inspect(bytes, "image/jpeg")).resolves.toEqual({
      status: "unavailable",
    });
    expect(errors).toHaveBeenCalled();
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(btoa(String.fromCharCode(...bytes)).slice(0, 16));
    expect(logged).not.toContain("data:image");
  });
});

describe("tkslopper traces and secrets", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records alias, gateway request id and usage in model_call traces", async () => {
    const sink = new MemoryOperationalTraceSink();
    const trace = { requestId: "tapplet-request", sink };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = gateway([
      responsesResponse({}, "req_success"),
      errorResponse(502, "provider_unavailable"),
    ]);
    const p = provider(g);
    await p.generate(brief, [], trace);
    await rejection(p.generate(brief, [], trace));

    expect(sink.events[0]).toMatchObject({
      kind: "model_call",
      requestId: "tapplet-request",
      operation: "generate",
      provider: `tkslopper:${ARTIFACT}`,
      configuredModel: ARTIFACT,
      resolvedModel: ARTIFACT,
      responseId: "resp_1",
      gatewayRequestId: "req_success",
      status: "success",
      finishReason: "completed",
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    });
    expect(sink.events[0]).not.toHaveProperty("cachedInputTokens");
    expect(sink.events[0]).not.toHaveProperty("reasoningTokens");
    expect(sink.events[1]).toMatchObject({
      status: "error",
      gatewayRequestId: "req_error_502",
    });
  });

  it("maps Chat finish reason and usage into model_call traces", async () => {
    const sink = new MemoryOperationalTraceSink();
    const g = gateway([chatResponse({ content: artifactJson, finish: "stop" }, "req_chat")]);
    await provider(g, { TKSLOPPER_ARTIFACT_ENDPOINT: "chat" }).generate(brief, [], {
      requestId: "tapplet-request",
      sink,
    });
    expect(sink.events[0]).toMatchObject({
      configuredModel: ARTIFACT,
      resolvedModel: ARTIFACT,
      responseId: "chatcmpl_1",
      gatewayRequestId: "req_chat",
      status: "success",
      finishReason: "stop",
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 11,
    });
  });

  it("never exposes the credential or access token in traces, logs or errors", async () => {
    const sink = new MemoryOperationalTraceSink();
    const trace = { requestId: "tapplet-request", sink };
    const logs = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const errors: unknown[] = [];
    const g = gateway([
      responsesResponse(),
      errorResponse(401, "authentication_failed"),
      responsesResponse(),
      errorResponse(403, "authorization_failed"),
      errorResponse(500, "internal_error"),
      new TypeError("offline"),
      responsesResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    ]);
    const p = provider(g);
    for (let index = 0; index < 6; index += 1)
      await p.generate(brief, [], trace).catch((error: unknown) => errors.push(error));
    await inspector(g).inspect(new Uint8Array([1]), "image/jpeg");

    const failingExchange = gateway([], () => errorResponse(401, "authentication_failed"));
    await provider(failingExchange)
      .generate(brief, [], trace)
      .catch((error: unknown) => errors.push(error));

    const exposed = JSON.stringify([
      sink.events,
      logs.map((log) => log.mock.calls),
      errors.map((error) => (error instanceof Error ? [error.message, error.stack] : error)),
    ]);
    expect(sink.events.length).toBeGreaterThan(0);
    expect(exposed).not.toContain(CREDENTIAL_SECRET);
    expect(exposed).not.toContain("tksvc_");
    expect(exposed).not.toContain("cred0001abcd");
    expect(exposed).not.toContain(ACCESS_TOKEN_PREFIX);
  });
});

describe("tkslopper wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function untouchedDatabase() {
    const prepare = vi.fn(() => {
      throw new Error("The admin override must not be read");
    });
    return { database: { prepare } as unknown as D1Database, prepare };
  }

  it("keeps the direct provider path by default", async () => {
    const { database } = untouchedDatabase();
    const direct = {
      AI_PROVIDER: "fixture",
      AI_MODEL: "fixture-v1",
      AI_BASE_URL: "https://models.example.test/v1",
      DB: database,
    } as StudioEnv;
    const p = createConfiguredModelProvider(direct);
    await p.generate(brief, []);
    expect(p.name).toBe("fixture");
    expect(createImageSafetyInspector({ ...direct, OPENCODE_API_KEY: "key" }))
      .toBeInstanceOf(OpenCodeGoImageSafetyInspector);
  });

  it("ignores the admin model override in tkslopper mode", async () => {
    const g = gateway([responsesResponse()]);
    vi.stubGlobal("fetch", g.fetch);
    const { database, prepare } = untouchedDatabase();
    const values = {
      DB: database,
      ADMIN_TOKEN: adminToken,
      ADMIN_ENCRYPTION_KEY: encryptionSecret,
      TKSLOPPER_SERVICE_CREDENTIAL: "tksvc_wiring0001_override-test-secret",
    };
    const p = createConfiguredModelProvider(tkEnv(values));
    expect(p.name).toBe(`tkslopper:${ARTIFACT}`);
    await expect(p.generate(brief, [])).resolves.toEqual({ html });
    expect((await loadConfiguredModelProvider(tkEnv(values))).name).toBe(
      `tkslopper:${ARTIFACT}`,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(createImageSafetyInspector(tkEnv(values))).toBeInstanceOf(
      TkslopperImageSafetyInspector,
    );
  });

  it("returns an unavailable provider for missing configuration or an unknown transport", async () => {
    const g = gateway([]);
    vi.stubGlobal("fetch", g.fetch);
    const { database } = untouchedDatabase();
    const missing = tkEnv({ DB: database, TKSLOPPER_GATEWAY_URL: undefined });
    const p = createConfiguredModelProvider(missing);
    expect(p.name).toBe("unavailable");
    const error = await rejection(p.generate(brief, []));
    expect(error.message).toContain("TKSLOPPER_GATEWAY_URL");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      createImageSafetyInspector(missing)?.inspect(new Uint8Array([1]), "image/jpeg"),
    ).resolves.toEqual({ status: "unavailable" });
    expect(JSON.stringify(errors.mock.calls)).toContain("TKSLOPPER_GATEWAY_URL");

    const unknown = tkEnv({ DB: database, INFERENCE_TRANSPORT: "gateway" });
    const q = createConfiguredModelProvider(unknown);
    expect(q.name).toBe("unavailable");
    expect((await rejection(q.moderate(html))).message).toContain(
      "Unsupported inference transport: gateway",
    );
    expect(createImageSafetyInspector({ ...unknown, OPENCODE_API_KEY: "key" }))
      .toBeUndefined();
    expect(g.mock).not.toHaveBeenCalled();
  });

  it("uses service bindings when they are present", async () => {
    const g = gateway([responsesResponse()]);
    const unused = vi.fn(() => {
      throw new Error("The public URL must not be used");
    });
    vi.stubGlobal("fetch", unused);
    const binding = {
      fetch: (request: Request) => g.fetch(request),
    } as unknown as Fetcher;
    const p = createTkslopperModelProvider(
      tkEnv({ TKSLOPPER_GATEWAY: binding, TKSLOPPER_CONTROL_PLANE: binding }),
      { grantCache: new TkslopperGrantCache() },
    );
    await expect(p.generate(brief, [])).resolves.toEqual({ html });
    expect(g.exchanges[0]?.url).toBe("https://tkslopper.internal/v1/token");
    expect(g.calls[0]?.url).toBe("https://tkslopper.internal/v1/responses");
    expect(g.calls[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_PREFIX}1`);
    expect(unused).not.toHaveBeenCalled();
  });

  it("reports the transport and aliases in the admin overview", async () => {
    const database = {
      prepare: () => ({ first: async () => null }),
      batch: async () => [{ results: [] }, { results: [] }, { results: [] }],
    } as unknown as D1Database;
    const request = () =>
      new Request("https://api.test/v1/admin/overview", {
        headers: { authorization: `Bearer ${adminToken}` },
      });
    const admin = {
      DB: database,
      ADMIN_TOKEN: adminToken,
      ADMIN_ENCRYPTION_KEY: encryptionSecret,
    };

    const tkslopper = await handleAdminRequest(request(), tkEnv(admin));
    expect(await tkslopper?.json()).toMatchObject({
      transport: "tkslopper",
      aliases: { artifact: ARTIFACT, review: REVIEW, image: IMAGE },
    });

    const direct = await handleAdminRequest(
      request(),
      tkEnv({ ...admin, INFERENCE_TRANSPORT: undefined }),
    );
    expect(await direct?.json()).toMatchObject({ transport: "direct", aliases: null });

    const page = await handleAdminRequest(new Request("https://api.test/admin"), tkEnv(admin));
    expect(await page?.text()).toContain(
      "Transport: tkslopper (admin model override inactive)",
    );
  });
});
