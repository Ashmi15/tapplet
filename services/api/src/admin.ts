import {
  createModelProvider,
  UnavailableModelProvider,
} from "./ai/createProvider";
import type { ModelProviderConfig } from "./ai/createProvider";
import type { ModelProvider } from "./ai/provider";
import {
  createTkslopperModelProvider,
  inferenceTransport,
  readTkslopperConfig,
} from "./ai/tkslopper";
import { sha256 } from "./auth";
import type { StudioEnv } from "./env";
import { apiError, HttpError, json, readJson } from "./http";

interface ModelSettingsRow {
  provider: string;
  model: string;
  base_url: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  updated_at: string;
}

interface CountRow {
  name: string;
  value: number;
}

interface UsageRow {
  date: string;
  generations: number;
  revisions: number;
  uploads: number;
  upload_bytes: number;
}

interface ModelUsageRow {
  model: string;
  count: number;
}

const ADMIN_PATHS = new Set([
  "/admin",
  "/admin/",
  "/v1/admin/overview",
  "/v1/admin/model",
  "/v1/admin/class-codes",
]);
const MODEL_PROVIDERS = new Set([
  "openai-compatible",
  "opencode",
  "opencode-go",
  "openrouter",
  "fixture",
]);

function environmentApiKey(env: StudioEnv, provider: string): string | undefined {
  if (provider === "opencode" || provider === "opencode-go")
    return env.OPENCODE_API_KEY;
  if (provider === "openrouter") return env.OPENROUTER_API_KEY;
  return env.AI_API_KEY;
}

function environmentBaseUrl(env: StudioEnv, provider: string): string {
  if (provider === "opencode") return "https://opencode.ai/zen/v1";
  if (provider === "opencode-go") return "https://opencode.ai/zen/go/v1";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return env.AI_BASE_URL;
}

function configured(env: StudioEnv): boolean {
  return !!(
    env.ADMIN_TOKEN &&
    env.ADMIN_TOKEN.length >= 32 &&
    env.ADMIN_ENCRYPTION_KEY &&
    env.ADMIN_ENCRYPTION_KEY.length >= 32
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function modelKeyScope(provider: string, baseUrl: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      `tapplet-admin-model-key:v1:${JSON.stringify([1, provider, baseUrl])}`,
    ),
  );
}

export async function encryptAdminApiKey(
  value: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: modelKeyScope(provider, baseUrl) },
    await encryptionKey(secret),
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptAdminApiKey(
  ciphertext: string,
  iv: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(iv),
      additionalData: modelKeyScope(provider, baseUrl),
    },
    await encryptionKey(secret),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function authorised(request: Request, env: StudioEnv): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || !header?.startsWith("Bearer ")) return false;
  const [actual, expected] = await Promise.all([
    digest(header.slice(7)),
    digest(env.ADMIN_TOKEN),
  ]);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual[index]! ^ (expected[index] ?? 0);
  return difference === 0;
}

async function settings(env: StudioEnv): Promise<ModelSettingsRow | null> {
  return env.DB.prepare(
    "SELECT provider,model,base_url,api_key_ciphertext,api_key_iv,updated_at FROM admin_model_settings WHERE id=1",
  ).first<ModelSettingsRow>();
}

function modelSummary(env: StudioEnv, row: ModelSettingsRow | null) {
  return row
    ? {
        provider: row.provider,
        model: row.model,
        baseUrl: row.base_url,
        keyConfigured: !!row.api_key_ciphertext,
        source: "admin" as const,
        updatedAt: row.updated_at,
      }
    : {
        provider: env.AI_PROVIDER,
        model: env.AI_MODEL,
        baseUrl: environmentBaseUrl(env, env.AI_PROVIDER),
        keyConfigured: !!environmentApiKey(env, env.AI_PROVIDER),
        source: "environment" as const,
        updatedAt: null,
      };
}

/**
 * Returns the provider for a non-direct inference transport, or undefined when
 * the direct providers (and the D1 admin override) are in use. The tkslopper
 * transport deliberately ignores the admin override: its aliases are managed
 * in tkslopper, and admin_model_settings cannot store a tkslopper provider.
 */
function transportModelProvider(env: StudioEnv): ModelProvider | undefined {
  const transport = inferenceTransport(env);
  if (transport === "direct") return undefined;
  if (transport === "tkslopper") return createTkslopperModelProvider(env);
  return new UnavailableModelProvider(
    `Unsupported inference transport: ${transport}`,
  );
}

export async function loadConfiguredModelProvider(
  env: StudioEnv,
): Promise<ModelProvider> {
  const transportProvider = transportModelProvider(env);
  if (transportProvider) return transportProvider;
  if (!configured(env)) return createModelProvider(env);
  const row = await settings(env);
  if (!row) return createModelProvider(env);
  let apiKey: string | undefined;
  if (row.api_key_ciphertext && row.api_key_iv) {
    try {
      apiKey = await decryptAdminApiKey(
        row.api_key_ciphertext,
        row.api_key_iv,
        env.ADMIN_ENCRYPTION_KEY!,
        row.provider,
        row.base_url,
      );
    } catch (error) {
      console.error(
        `Admin model key decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const override: ModelProviderConfig = {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    ...(apiKey ? { apiKey } : {}),
  };
  return createModelProvider(env, override);
}

export function createConfiguredModelProvider(env: StudioEnv): ModelProvider {
  const transportProvider = transportModelProvider(env);
  if (transportProvider) return transportProvider;
  let loaded: ModelProvider | undefined;
  let loading: Promise<ModelProvider> | undefined;
  const load = async () => {
    loading ??= loadConfiguredModelProvider(env);
    loaded ??= await loading;
    return loaded;
  };
  return {
    get name() {
      return loaded?.name ?? "configured";
    },
    generate: (...args) => load().then((provider) => provider.generate(...args)),
    revise: (...args) => load().then((provider) => provider.revise(...args)),
    repair: (...args) => load().then((provider) => provider.repair(...args)),
    moderate: (...args) => load().then((provider) => provider.moderate(...args)),
  };
}

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, { status: response.status, headers });
}

async function overview(env: StudioEnv): Promise<Response> {
  const [row, results] = await Promise.all([
    settings(env),
    env.DB.batch([
      env.DB.prepare(
        `SELECT 'artifacts' name,count(*) value FROM artifacts
         UNION ALL SELECT 'revisions',count(*) FROM revisions
         UNION ALL SELECT 'activePublications',count(*) FROM publications WHERE revoked_at IS NULL AND datetime(expires_at)>datetime('now')
         UNION ALL SELECT 'activeClassCodes',count(*) FROM class_codes WHERE use_count<maximum_uses AND datetime(expires_at)>datetime('now')
         UNION ALL SELECT 'unreviewedReports',count(*) FROM content_reports WHERE reviewed_at IS NULL`,
      ),
      env.DB.prepare(
        `WITH RECURSIVE dates(date) AS (
           SELECT date('now','-13 days') UNION ALL SELECT date(date,'+1 day') FROM dates WHERE date<date('now')
         ), revision_counts AS (
           SELECT substr(created_at,1,10) date,
             sum(CASE WHEN kind='generation' THEN 1 ELSE 0 END) generations,
             sum(CASE WHEN kind='revision' THEN 1 ELSE 0 END) revisions
           FROM revisions WHERE created_at>=date('now','-13 days') GROUP BY substr(created_at,1,10)
         ), upload_counts AS (
           SELECT usage_date date,sum(upload_count) uploads,sum(total_bytes) upload_bytes
           FROM asset_usage WHERE usage_date>=date('now','-13 days') AND owner_hash NOT LIKE 'network:%' GROUP BY usage_date
         )
         SELECT dates.date,coalesce(generations,0) generations,coalesce(revisions,0) revisions,
           coalesce(uploads,0) uploads,coalesce(upload_bytes,0) upload_bytes
         FROM dates LEFT JOIN revision_counts USING(date) LEFT JOIN upload_counts USING(date) ORDER BY dates.date`,
      ),
      env.DB.prepare(
        "SELECT model_version model,count(*) count FROM revisions GROUP BY model_version ORDER BY count DESC LIMIT 8",
      ),
    ]),
  ]);
  const counts = Object.fromEntries(
    ((results[0]?.results ?? []) as unknown as CountRow[]).map((item) => [
      item.name,
      item.value,
    ]),
  );
  const transport = inferenceTransport(env);
  const tkslopperConfig =
    transport === "tkslopper" ? readTkslopperConfig(env) : undefined;
  return json({
    transport,
    transportProblem:
      transport !== "direct" && transport !== "tkslopper"
        ? `Unsupported inference transport: ${transport}`
        : tkslopperConfig && !tkslopperConfig.ok
          ? tkslopperConfig.reason
          : null,
    aliases:
      transport === "tkslopper"
        ? {
            artifact: env.TKSLOPPER_ARTIFACT_ALIAS?.trim() || null,
            review: env.TKSLOPPER_REVIEW_ALIAS?.trim() || null,
            image: env.TKSLOPPER_IMAGE_ALIAS?.trim() || null,
          }
        : null,
    model: modelSummary(env, row),
    counts,
    usage: (results[1]?.results ?? []) as unknown as UsageRow[],
    models: (results[2]?.results ?? []) as unknown as ModelUsageRow[],
  });
}

async function updateModel(request: Request, env: StudioEnv): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 8_000);
  const provider = body.provider;
  const model = body.model;
  const baseUrl = body.baseUrl;
  if (typeof provider !== "string" || !MODEL_PROVIDERS.has(provider))
    return apiError(422, "INVALID_PROVIDER", "Choose an available provider.");
  if (typeof model !== "string" || !model.trim() || model.trim().length > 200)
    return apiError(422, "INVALID_MODEL", "Enter a model name.");
  if (typeof baseUrl !== "string" || baseUrl.length > 500)
    return apiError(422, "INVALID_BASE_URL", "Enter a valid provider URL.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return apiError(422, "INVALID_BASE_URL", "Enter a valid provider URL.");
  }
  if (parsedUrl.protocol !== "https:")
    return apiError(422, "INVALID_BASE_URL", "Provider URLs must use HTTPS.");

  const normalisedBaseUrl = parsedUrl.toString().replace(/\/$/, "");
  const current = await settings(env);
  let ciphertext: string | null = null;
  let iv: string | null = null;
  const preserveApiKey = body.clearApiKey !== true &&
    (body.apiKey === undefined || body.apiKey === "");
  const canPreserveApiKey = !!(
    current?.api_key_ciphertext &&
    current.api_key_iv &&
    current.provider === provider &&
    current.base_url === normalisedBaseUrl
  );
  if (preserveApiKey && provider !== "fixture" && !canPreserveApiKey)
    return apiError(
      422,
      "API_KEY_REQUIRED",
      "Enter an API key when creating an override or changing its provider URL.",
    );
  if (!preserveApiKey && body.clearApiKey !== true) {
    if (typeof body.apiKey !== "string" || body.apiKey.length > 2_000)
      return apiError(422, "INVALID_API_KEY", "The API key is too long.");
    const encrypted = await encryptAdminApiKey(
      body.apiKey,
      env.ADMIN_ENCRYPTION_KEY!,
      provider,
      normalisedBaseUrl,
    );
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv;
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_model_settings(id,provider,model,base_url,api_key_ciphertext,api_key_iv,updated_at)
     VALUES(1,?1,?2,?3,?4,?5,?6)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,base_url=excluded.base_url,
       api_key_ciphertext=CASE WHEN ?7=1 AND admin_model_settings.provider=excluded.provider AND admin_model_settings.base_url=excluded.base_url THEN admin_model_settings.api_key_ciphertext ELSE excluded.api_key_ciphertext END,
       api_key_iv=CASE WHEN ?7=1 AND admin_model_settings.provider=excluded.provider AND admin_model_settings.base_url=excluded.base_url THEN admin_model_settings.api_key_iv ELSE excluded.api_key_iv END,
       updated_at=excluded.updated_at`,
  )
    .bind(
      provider,
      model.trim(),
      normalisedBaseUrl,
      ciphertext,
      iv,
      updatedAt,
      preserveApiKey ? 1 : 0,
    )
    .run();
  return json({ model: modelSummary(env, await settings(env)) });
}

async function resetModel(env: StudioEnv): Promise<Response> {
  await env.DB.prepare("DELETE FROM admin_model_settings WHERE id=1").run();
  return json({ model: modelSummary(env, null) });
}

const CLASS_CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

function createClassCode(classNumber: string): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(
    random,
    (value) => CLASS_CODE_LETTERS[value % CLASS_CODE_LETTERS.length],
  ).join("");
  return `${classNumber}${suffix}`;
}

async function mintClassCode(request: Request, env: StudioEnv): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 2_000);
  const classNumber = body.classNumber;
  const maximumUses = body.maximumUses;
  const expiresAt = body.expiresAt;
  if (typeof classNumber !== "string" || !/^\d{4}$/.test(classNumber))
    return apiError(422, "INVALID_CLASS_NUMBER", "Enter a four-digit class number.");
  if (
    typeof maximumUses !== "number" ||
    !Number.isSafeInteger(maximumUses) ||
    maximumUses < 1 ||
    maximumUses > 100
  )
    return apiError(422, "INVALID_MAXIMUM_USES", "Activations must be from 1 to 100.");
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(Date.parse(expiresAt)).toISOString() !== expiresAt ||
    Date.parse(expiresAt) <= Date.now()
  )
    return apiError(422, "INVALID_EXPIRY", "Choose a future expiry date and time.");

  const code = createClassCode(classNumber);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO class_codes(code_hash,label,maximum_uses,expires_at,created_at)
     VALUES(?1,?2,?3,?4,?5)`,
  )
    .bind(
      await sha256(`class-code:${code}`),
      `Class ${classNumber}`,
      maximumUses,
      expiresAt,
      createdAt,
    )
    .run();
  return json(
    {
      code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`,
      classNumber,
      maximumUses,
      expiresAt,
      createdAt,
    },
    { status: 201 },
  );
}

export async function handleAdminRequest(
  request: Request,
  env: StudioEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!ADMIN_PATHS.has(pathname)) return null;
  if (!configured(env)) return new Response("Not found.", { status: 404 });
  if (pathname === "/admin" || pathname === "/admin/") {
    if (request.method !== "GET") return new Response("Not found.", { status: 404 });
    return secured(
      new Response(ADMIN_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      }),
    );
  }
  if (!(await authorised(request, env)))
    return secured(apiError(401, "ADMIN_UNAUTHORIZED", "Admin access required."));
  try {
    if (pathname === "/v1/admin/overview" && request.method === "GET")
      return secured(await overview(env));
    if (pathname === "/v1/admin/model" && request.method === "PATCH")
      return secured(await updateModel(request, env));
    if (pathname === "/v1/admin/model" && request.method === "DELETE")
      return secured(await resetModel(env));
    if (pathname === "/v1/admin/class-codes" && request.method === "POST")
      return secured(await mintClassCode(request, env));
    return secured(apiError(404, "NOT_FOUND", "Endpoint not found."));
  } catch (error) {
    if (error instanceof HttpError)
      return secured(apiError(error.status, error.code, error.message, error.details));
    console.error(
      `Admin request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return secured(apiError(500, "INTERNAL_ERROR", "Admin request failed."));
  }
}

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tapplet operations</title><style>
:root{color-scheme:light;--canvas:#f8f6f1;--surface:#fff;--ink:#171718;--muted:#6f6d67;--border:#dfdeda;--accent:#bd3a34;--soft:#fbeeed;--good:#25623b;--danger:#9a2c27}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:42px 0 80px}.top{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:30px}.eyebrow{color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.09em;font-size:12px}h1{font-size:clamp(30px,5vw,48px);line-height:1.05;margin:4px 0 7px;letter-spacing:-.04em}h2{font-size:20px;margin:0 0 18px}p{margin:0;color:var(--muted)}.card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:22px;box-shadow:0 8px 28px rgba(23,23,24,.04)}.login{max-width:480px;margin:12vh auto 0}.login form{display:grid;gap:14px;margin-top:22px}.hidden{display:none!important}.grid{display:grid;grid-template-columns:1.35fr .65fr;gap:18px}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}.stat{padding:18px}.stat b{display:block;font-size:28px;letter-spacing:-.04em}.stat span{font-size:12px;color:var(--muted)}label{display:grid;gap:6px;font-weight:700}input,select{width:100%;border:1px solid #76736c;border-radius:10px;padding:10px 12px;background:#fff;color:var(--ink)}input:focus,select:focus,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.wide{grid-column:1/-1}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}button{border:0;border-radius:10px;padding:10px 15px;font-weight:800;cursor:pointer;background:var(--accent);color:#fff}button.secondary{background:#ece8df;color:var(--ink)}button.danger{background:#fbe7e5;color:var(--danger)}button:disabled{opacity:.55;cursor:wait}.pill{display:inline-flex;border-radius:999px;background:#ece8df;padding:5px 9px;font-size:12px;font-weight:800}.pill.good{background:#e7f3e9;color:var(--good)}.note{font-size:13px;margin-top:8px}.chart{height:210px;display:flex;align-items:end;gap:7px;border-bottom:1px solid var(--border);padding-top:20px}.bar-group{height:100%;flex:1;display:flex;align-items:end;gap:2px;position:relative}.bar{min-height:2px;flex:1;background:var(--accent);border-radius:4px 4px 0 0}.bar.revision{background:#171718}.bar-group span{position:absolute;bottom:-28px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--muted)}.legend{display:flex;gap:16px;margin-top:35px;font-size:12px;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:var(--accent)}.dot.dark{background:#171718}.models{display:grid;gap:12px}.model-row{display:grid;grid-template-columns:1fr auto;gap:12px}.meter{height:6px;background:#ece8df;border-radius:99px;overflow:hidden;margin-top:5px}.meter i{display:block;height:100%;background:var(--accent)}.status{min-height:24px;margin-top:10px;font-size:13px}.error{color:var(--danger)}@media(max-width:800px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.fields{grid-template-columns:1fr}.wide{grid-column:auto}.top{align-items:start;flex-direction:column}}@media(max-width:480px){main{width:min(100% - 20px,1120px);padding-top:24px}.stats{grid-template-columns:1fr 1fr}.stat{padding:14px}}
</style></head><body><main>
<section id="login" class="card login"><div class="eyebrow">Tapplet</div><h1>Operations</h1><p>Enter the admin token configured on the Worker. It stays in this browser tab only.</p><form id="login-form"><label>Admin token<input id="token" type="password" autocomplete="current-password" required></label><button>Open dashboard</button><div id="login-error" class="status error" role="alert"></div></form></section>
<section id="dashboard" class="hidden"><header class="top"><div><div class="eyebrow">Tapplet</div><h1>Operations</h1><p>Models, activity and service configuration.</p></div><button id="sign-out" class="secondary">Sign out</button></header>
<div id="stats" class="stats"></div><div class="grid"><section class="card"><h2>Model configuration</h2><form id="model-form"><div class="fields"><label>Provider<select id="provider"><option value="opencode-go">OpenCode Go</option><option value="opencode">OpenCode Zen</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI-compatible</option><option value="fixture">Fixture (testing only)</option></select></label><label>Model<input id="model" required maxlength="200"></label><label class="wide">Base URL<input id="base-url" type="url" required maxlength="500"></label><label class="wide">Replace API key<input id="api-key" type="password" maxlength="2000" autocomplete="new-password" placeholder="Leave blank to keep the existing key"></label></div><p id="key-state" class="note"></p><p id="transport" class="note"></p><p id="transport-problem" class="note error" role="alert"></p><div class="actions"><button id="save-model">Save configuration</button><button id="clear-key" type="button" class="danger">Remove key</button><button id="reset-model" type="button" class="secondary">Use environment defaults</button><span id="source" class="pill"></span></div><div id="model-status" class="status" role="status"></div></form></section>
<section class="card"><h2>Mint class access code</h2><form id="code-form"><div class="fields"><label>Class number<input id="class-number" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" placeholder="1234" required></label><label>Maximum activations<input id="maximum-uses" type="number" min="1" max="100" value="30" required></label><label class="wide">Expires at<input id="expires-at" type="datetime-local" required></label></div><div class="actions"><button id="mint-code">Mint code</button></div><div id="code-result" class="status" role="status"></div><p class="note">The code is shown once. Copy it to a protected location before leaving this page; only its hash is stored.</p></form></section>
<section class="card"><h2>Models used</h2><div id="models" class="models"></div><p class="note">Based on persisted revisions. Token and spend telemetry is not available from the current provider contract.</p></section>
<section class="card"><h2>Activity · last 14 days</h2><div id="chart" class="chart" aria-hidden="true"></div><div class="legend" aria-hidden="true"><span><i class="dot"></i>Generations</span><span><i class="dot dark"></i>Revisions</span></div><div id="activity-summary" class="models"></div></section>
<section class="card"><h2>Uploads · last 14 days</h2><div id="upload-summary"></div><p class="note">Counts successful owner upload reservations; network safety counters are excluded.</p></section></div></section>
</main><script>
const $=id=>document.getElementById(id);let token=sessionStorage.getItem('tapplet-admin-token')||'';let data;
async function api(path,options={}){const response=await fetch(path,{...options,headers:{authorization:'Bearer '+token,...(options.body?{'content-type':'application/json'}:{}),...options.headers}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error?.message||'Request failed');return body}
function number(value){return new Intl.NumberFormat().format(value||0)}
function render(){const counts=data.counts;const cards=[['Artifacts',counts.artifacts],['Revisions',counts.revisions],['Live shares',counts.activePublications],['Active class codes',counts.activeClassCodes],['Reports to review',counts.unreviewedReports]];$('stats').innerHTML=cards.map(([label,value])=>'<div class="card stat"><b>'+number(value)+'</b><span>'+label+'</span></div>').join('');const m=data.model;$('provider').value=m.provider;$('model').value=m.model;$('base-url').value=m.baseUrl;$('api-key').value='';$('key-state').textContent=m.source==='environment'?'Enter a key to create an admin override.':m.keyConfigured?'A key is configured. Enter a new one only to replace it.':'No API key is configured.';$('source').textContent=m.source==='admin'?'Admin override':'Environment default';$('source').className='pill '+(m.keyConfigured?'good':'');$('clear-key').disabled=!m.keyConfigured||m.source!=='admin';$('reset-model').disabled=m.source!=='admin';$('transport').textContent=data.transport==='tkslopper'?'Transport: tkslopper (admin model override inactive)'+(data.aliases?' · Aliases: '+[data.aliases.artifact,data.aliases.review,data.aliases.image].map(x=>x||'not set').join(', '):''):'Transport: '+data.transport;$('transport-problem').textContent=data.transportProblem||'';const max=Math.max(1,...data.usage.map(x=>x.generations+x.revisions));$('chart').innerHTML=data.usage.map((x,i)=>'<div class="bar-group"><i class="bar" style="height:'+Math.max(1,x.generations/max*100)+'%"></i><i class="bar revision" style="height:'+Math.max(1,x.revisions/max*100)+'%"></i>'+(i%3===0||i===data.usage.length-1?'<span>'+x.date.slice(5)+'</span>':'')+'</div>').join('');$('activity-summary').innerHTML=data.usage.map(x=>'<div class="model-row"><span>'+escapeHtml(x.date)+'</span><span>'+number(x.generations)+' generations · '+number(x.revisions)+' revisions</span></div>').join('');const modelMax=Math.max(1,...data.models.map(x=>x.count));$('models').innerHTML=data.models.length?data.models.map(x=>'<div class="model-row"><div><strong>'+escapeHtml(x.model)+'</strong><div class="meter"><i style="width:'+(x.count/modelMax*100)+'%"></i></div></div><b>'+number(x.count)+'</b></div>').join(''):'<p>No revisions yet.</p>';const uploads=data.usage.reduce((a,x)=>({count:a.count+x.uploads,bytes:a.bytes+x.upload_bytes}),{count:0,bytes:0});$('upload-summary').innerHTML='<p><strong style="font-size:28px">'+number(uploads.count)+'</strong> uploads</p><p style="margin-top:12px"><strong>'+new Intl.NumberFormat(undefined,{style:'unit',unit:'megabyte',maximumFractionDigits:1}).format(uploads.bytes/1000000)+'</strong> processed</p>'}
function escapeHtml(value){const node=document.createElement('span');node.textContent=value;return node.innerHTML}
async function load(){data=await api('/v1/admin/overview');$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');render()}
$('provider').onchange=()=>{const defaults={'opencode':'https://opencode.ai/zen/v1','opencode-go':'https://opencode.ai/zen/go/v1','openrouter':'https://openrouter.ai/api/v1','openai-compatible':'https://api.openai.com/v1','fixture':'https://models.example.test/v1'};$('base-url').value=defaults[$('provider').value]};
$('login-form').onsubmit=async event=>{event.preventDefault();token=$('token').value;$('login-error').textContent='';try{await load();sessionStorage.setItem('tapplet-admin-token',token)}catch(error){token='';$('login-error').textContent=error.message}};
$('model-form').onsubmit=async event=>{event.preventDefault();const button=$('save-model');button.disabled=true;$('model-status').className='status';$('model-status').textContent='Saving…';try{await api('/v1/admin/model',{method:'PATCH',body:JSON.stringify({provider:$('provider').value,model:$('model').value,baseUrl:$('base-url').value,apiKey:$('api-key').value})});await load();$('model-status').textContent='Configuration saved.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{button.disabled=false}};
$('code-form').onsubmit=async event=>{event.preventDefault();const button=$('mint-code');button.disabled=true;$('code-result').className='status';$('code-result').textContent='Minting…';try{const expiry=new Date($('expires-at').value);const result=await api('/v1/admin/class-codes',{method:'POST',body:JSON.stringify({classNumber:$('class-number').value,maximumUses:Number($('maximum-uses').value),expiresAt:expiry.toISOString()})});$('code-result').innerHTML='Class access code: <strong style="font-size:20px">'+escapeHtml(result.code)+'</strong><br>Copy it now — it cannot be retrieved later.';try{data=await api('/v1/admin/overview');render()}catch{}}catch(error){$('code-result').className='status error';$('code-result').textContent=error.message}finally{button.disabled=false}};
$('clear-key').onclick=async()=>{if(!confirm('Remove the stored API key? Model requests will stop until another key is configured.'))return;const button=$('clear-key'),m=data.model;let completed=false;button.disabled=true;$('model-status').className='status';$('model-status').textContent='Removing…';try{await api('/v1/admin/model',{method:'PATCH',body:JSON.stringify({provider:m.provider,model:m.model,baseUrl:m.baseUrl,clearApiKey:true})});await load();completed=true;$('model-status').textContent='API key removed.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{if(!completed)button.disabled=false}};
$('reset-model').onclick=async()=>{if(!confirm('Discard the admin override and use Worker environment defaults?'))return;const button=$('reset-model');let completed=false;button.disabled=true;$('model-status').className='status';$('model-status').textContent='Resetting…';try{await api('/v1/admin/model',{method:'DELETE'});await load();completed=true;$('model-status').textContent='Using environment defaults.'}catch(error){$('model-status').className='status error';$('model-status').textContent=error.message}finally{if(!completed)button.disabled=false}};
$('sign-out').onclick=()=>{sessionStorage.removeItem('tapplet-admin-token');location.reload()};if(token)load().catch(()=>{sessionStorage.removeItem('tapplet-admin-token');token=''})
</script></body></html>`;
