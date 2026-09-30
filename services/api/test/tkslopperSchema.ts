// Strict request validator for tests. It mirrors the allowed keys and enums of
// tkslopper packages/shared/src/schemas.ts at commit 9f93d8e
// (responsesRequestSchema, chatRequestSchema and tokenExchangeSchema) so every
// body Tapplet builds is checked against the gateway's strict schema without
// adding zod as a dependency.

type Issues = string[];

const CAPABILITY = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/u;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u;
const EFFORTS = new Set(["low", "medium", "high"]);
const ROLES = new Set(["system", "developer", "user", "assistant"]);
const DETAILS = new Set(["auto", "low", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  issues: Issues,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      issues.push(`${path}.${key} is not allowed`);
  for (const key of required)
    if (value[key] === undefined) issues.push(`${path}.${key} is required`);
  return true;
}

function string(value: unknown, path: string, max: number, issues: Issues) {
  if (typeof value !== "string" || value.length > max)
    issues.push(`${path} must be a string of at most ${max} characters`);
}

function capability(value: unknown, path: string, issues: Issues) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 100 ||
    !CAPABILITY.test(value)
  )
    issues.push(`${path} must be a capability alias`);
}

function identifier(value: unknown, path: string, issues: Issues) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 100 ||
    !IDENTIFIER.test(value)
  )
    issues.push(`${path} must be an identifier`);
}

function numberRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  integer: boolean,
  issues: Issues,
) {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  )
    issues.push(`${path} must be a number from ${min} to ${max}`);
}

function optionalEnum(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  issues: Issues,
) {
  if (value !== undefined && (typeof value !== "string" || !allowed.has(value)))
    issues.push(`${path} must be one of ${[...allowed].join(", ")}`);
}

function imageUrl(value: unknown, path: string, issues: Issues) {
  if (
    typeof value !== "string" ||
    value.length > 8_000_000 ||
    !(value.startsWith("https://") || value.startsWith("data:image/"))
  )
    issues.push(`${path} must be an https or image data URL`);
}

function stream(value: unknown, path: string, issues: Issues) {
  if (value !== undefined && value !== false)
    issues.push(`${path} must be false when present`);
}

function jsonSchemaFields(value: Record<string, unknown>, path: string, issues: Issues) {
  identifier(value.name, `${path}.name`, issues);
  if (value.description !== undefined)
    string(value.description, `${path}.description`, 1000, issues);
  if (value.strict !== undefined && typeof value.strict !== "boolean")
    issues.push(`${path}.strict must be a boolean`);
  if (!isRecord(value.schema)) issues.push(`${path}.schema must be an object`);
}

function messageContent(
  content: unknown,
  path: string,
  part: (value: unknown, path: string, issues: Issues) => void,
  issues: Issues,
) {
  if (typeof content === "string") {
    string(content, path, 2_000_000, issues);
    return;
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > 100) {
    issues.push(`${path} must be a string or 1 to 100 parts`);
    return;
  }
  content.forEach((value, index) => part(value, `${path}[${index}]`, issues));
}

function responsesPart(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  if (value.type === "input_text") {
    if (strictObject(value, path, ["type", "text"], [], issues))
      string(value.text, `${path}.text`, 2_000_000, issues);
  } else if (value.type === "input_image") {
    if (strictObject(value, path, ["type", "image_url"], ["detail"], issues)) {
      imageUrl(value.image_url, `${path}.image_url`, issues);
      optionalEnum(value.detail, `${path}.detail`, DETAILS, issues);
    }
  } else {
    issues.push(`${path}.type is not allowed`);
  }
}

function chatPart(value: unknown, path: string, issues: Issues) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  if (value.type === "text") {
    if (strictObject(value, path, ["type", "text"], [], issues))
      string(value.text, `${path}.text`, 2_000_000, issues);
  } else if (value.type === "image_url") {
    if (
      strictObject(value, path, ["type", "image_url"], [], issues) &&
      strictObject(value.image_url, `${path}.image_url`, ["url"], ["detail"], issues)
    ) {
      const image = value.image_url as Record<string, unknown>;
      imageUrl(image.url, `${path}.image_url.url`, issues);
      optionalEnum(image.detail, `${path}.image_url.detail`, DETAILS, issues);
    }
  } else {
    issues.push(`${path}.type is not allowed`);
  }
}

function message(
  value: unknown,
  path: string,
  part: (value: unknown, path: string, issues: Issues) => void,
  issues: Issues,
) {
  if (!strictObject(value, path, ["role", "content"], [], issues)) return;
  optionalEnum(value.role, `${path}.role`, ROLES, issues);
  messageContent(value.content, `${path}.content`, part, issues);
}

export function validateResponsesRequest(body: unknown): string[] {
  const issues: Issues = [];
  if (
    !strictObject(
      body,
      "body",
      ["model", "input"],
      [
        "instructions",
        "stream",
        "temperature",
        "top_p",
        "max_output_tokens",
        "reasoning",
        "text",
      ],
      issues,
    )
  )
    return issues;
  capability(body.model, "body.model", issues);
  if (typeof body.input === "string") {
    string(body.input, "body.input", 2_000_000, issues);
  } else if (
    Array.isArray(body.input) &&
    body.input.length >= 1 &&
    body.input.length <= 1000
  ) {
    body.input.forEach((item, index) =>
      message(item, `body.input[${index}]`, responsesPart, issues),
    );
  } else {
    issues.push("body.input must be a string or 1 to 1000 items");
  }
  if (body.instructions !== undefined)
    string(body.instructions, "body.instructions", 2_000_000, issues);
  stream(body.stream, "body.stream", issues);
  numberRange(body.temperature, "body.temperature", 0, 2, false, issues);
  numberRange(body.top_p, "body.top_p", 0, 1, false, issues);
  numberRange(body.max_output_tokens, "body.max_output_tokens", 1, 200_000, true, issues);
  if (
    body.reasoning !== undefined &&
    strictObject(body.reasoning, "body.reasoning", ["effort"], [], issues)
  )
    optionalEnum(body.reasoning.effort, "body.reasoning.effort", EFFORTS, issues);
  if (
    body.text !== undefined &&
    strictObject(body.text, "body.text", ["format"], [], issues)
  ) {
    const format = body.text.format;
    if (isRecord(format) && (format.type === "text" || format.type === "json_object")) {
      strictObject(format, "body.text.format", ["type"], [], issues);
    } else if (isRecord(format) && format.type === "json_schema") {
      if (
        strictObject(
          format,
          "body.text.format",
          ["type", "name", "schema"],
          ["description", "strict"],
          issues,
        )
      )
        jsonSchemaFields(format, "body.text.format", issues);
    } else {
      issues.push("body.text.format.type is not allowed");
    }
  }
  return issues;
}

export function validateChatRequest(body: unknown): string[] {
  const issues: Issues = [];
  if (
    !strictObject(
      body,
      "body",
      ["model", "messages"],
      [
        "stream",
        "temperature",
        "top_p",
        "max_tokens",
        "max_completion_tokens",
        "response_format",
        "reasoning_effort",
        "stop",
        "seed",
      ],
      issues,
    )
  )
    return issues;
  capability(body.model, "body.model", issues);
  if (
    Array.isArray(body.messages) &&
    body.messages.length >= 1 &&
    body.messages.length <= 1000
  ) {
    body.messages.forEach((item, index) =>
      message(item, `body.messages[${index}]`, chatPart, issues),
    );
  } else {
    issues.push("body.messages must have 1 to 1000 items");
  }
  stream(body.stream, "body.stream", issues);
  numberRange(body.temperature, "body.temperature", 0, 2, false, issues);
  numberRange(body.top_p, "body.top_p", 0, 1, false, issues);
  numberRange(body.max_tokens, "body.max_tokens", 1, 200_000, true, issues);
  numberRange(
    body.max_completion_tokens,
    "body.max_completion_tokens",
    1,
    200_000,
    true,
    issues,
  );
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    issues.push("max_tokens and max_completion_tokens are mutually exclusive");
  const format = body.response_format;
  if (format !== undefined) {
    if (isRecord(format) && format.type === "json_object") {
      strictObject(format, "body.response_format", ["type"], [], issues);
    } else if (isRecord(format) && format.type === "json_schema") {
      if (
        strictObject(format, "body.response_format", ["type", "json_schema"], [], issues) &&
        strictObject(
          format.json_schema,
          "body.response_format.json_schema",
          ["name", "schema"],
          ["description", "strict"],
          issues,
        )
      )
        jsonSchemaFields(
          format.json_schema as Record<string, unknown>,
          "body.response_format.json_schema",
          issues,
        );
    } else {
      issues.push("body.response_format.type is not allowed");
    }
  }
  optionalEnum(body.reasoning_effort, "body.reasoning_effort", EFFORTS, issues);
  if (body.stop !== undefined) {
    if (typeof body.stop === "string") string(body.stop, "body.stop", 500, issues);
    else if (Array.isArray(body.stop) && body.stop.length <= 20)
      body.stop.forEach((value, index) =>
        string(value, `body.stop[${index}]`, 500, issues),
      );
    else issues.push("body.stop must be a string or at most 20 strings");
  }
  if (body.seed !== undefined && !Number.isInteger(body.seed))
    issues.push("body.seed must be an integer");
  return issues;
}

export function validateTokenExchangeRequest(body: unknown): string[] {
  const issues: Issues = [];
  if (!strictObject(body, "body", [], ["capabilities", "ttl_seconds"], issues))
    return issues;
  if (body.capabilities !== undefined) {
    if (
      !Array.isArray(body.capabilities) ||
      body.capabilities.length < 1 ||
      body.capabilities.length > 50
    )
      issues.push("body.capabilities must have 1 to 50 items");
    else
      body.capabilities.forEach((value, index) =>
        capability(value, `body.capabilities[${index}]`, issues),
      );
  }
  numberRange(body.ttl_seconds, "body.ttl_seconds", 60, 3600, true, issues);
  return issues;
}
