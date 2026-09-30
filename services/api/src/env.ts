export interface StudioEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  AI_PROVIDER: string;
  AI_MODEL: string;
  AI_BASE_URL: string;
  AI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  IMAGE_SAFETY_MODEL: string;
  INFERENCE_TRANSPORT?: string;
  TKSLOPPER_CONTROL_PLANE_URL?: string;
  TKSLOPPER_GATEWAY_URL?: string;
  TKSLOPPER_SERVICE_CREDENTIAL?: string;
  TKSLOPPER_ARTIFACT_ALIAS?: string;
  TKSLOPPER_REVIEW_ALIAS?: string;
  TKSLOPPER_IMAGE_ALIAS?: string;
  TKSLOPPER_ARTIFACT_EFFORT?: string;
  TKSLOPPER_REVIEW_EFFORT?: string;
  TKSLOPPER_IMAGE_EFFORT?: string;
  TKSLOPPER_ARTIFACT_ENDPOINT?: string;
  TKSLOPPER_MAX_REQUEST_BYTES?: string;
  TKSLOPPER_GATEWAY?: Fetcher;
  TKSLOPPER_CONTROL_PLANE?: Fetcher;
  ADMIN_TOKEN?: string;
  ADMIN_ENCRYPTION_KEY?: string;
  DEVICE_TOKEN_SIGNING_SECRET?: string;
  STUDIO_SEED_IMPORT_TOKEN?: string;
  PUBLIC_PLAYER_ORIGIN: string;
  ALLOWED_ORIGINS: string;
  DAILY_GENERATION_LIMIT: string;
  DAILY_NETWORK_GENERATION_LIMIT: string;
  DAILY_SAFETY_REVIEW_LIMIT: string;
  DAILY_NETWORK_SAFETY_REVIEW_LIMIT: string;
  DAILY_NETWORK_UPLOAD_LIMIT: string;
  DAILY_NETWORK_UPLOAD_BYTES: string;
  DAILY_DRAFT_CREATION_LIMIT: string;
  DAILY_NETWORK_DRAFT_CREATION_LIMIT: string;
  DAILY_NETWORK_REGISTRATION_LIMIT: string;
  DAILY_NETWORK_CLASS_CODE_FAILURE_LIMIT: string;
  CLASS_CODE_FAILURE_LOCKOUT: string;
  MAXIMUM_DRAFTS_PER_OWNER: string;
  PUBLICATION_TTL_DAYS: string;
}

export interface StudioConfig {
  publicPlayerOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  dailyGenerationLimit: number;
  dailyNetworkGenerationLimit: number;
  dailySafetyReviewLimit: number;
  dailyNetworkSafetyReviewLimit: number;
  dailyNetworkUploadLimit: number;
  dailyNetworkUploadBytes: number;
  dailyDraftCreationLimit: number;
  dailyNetworkDraftCreationLimit: number;
  maximumDraftsPerOwner: number;
  dailyNetworkRegistrationLimit: number;
  dailyNetworkClassCodeFailureLimit: number;
  classCodeFailureLockout: number;
  publicationTtlDays: number;
  deviceTokenSigningSecret: string;
  seedImportToken?: string;
}

function boundedInteger(
  value: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function readConfig(env: StudioEnv): StudioConfig {
  if (
    !env.DEVICE_TOKEN_SIGNING_SECRET ||
    env.DEVICE_TOKEN_SIGNING_SECRET.length < 32
  ) {
    throw new Error(
      "DEVICE_TOKEN_SIGNING_SECRET must be configured with at least 32 characters.",
    );
  }
  return {
    publicPlayerOrigin: env.PUBLIC_PLAYER_ORIGIN.replace(/\/$/, ""),
    allowedOrigins: new Set(
      env.ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    dailyGenerationLimit: boundedInteger(
      env.DAILY_GENERATION_LIMIT,
      20,
      1,
      500,
    ),
    dailyNetworkGenerationLimit: boundedInteger(
      env.DAILY_NETWORK_GENERATION_LIMIT,
      1_000,
      20,
      10_000,
    ),
    dailySafetyReviewLimit: boundedInteger(
      env.DAILY_SAFETY_REVIEW_LIMIT,
      50,
      5,
      500,
    ),
    dailyNetworkSafetyReviewLimit: boundedInteger(
      env.DAILY_NETWORK_SAFETY_REVIEW_LIMIT,
      1_000,
      20,
      10_000,
    ),
    dailyNetworkUploadLimit: boundedInteger(
      env.DAILY_NETWORK_UPLOAD_LIMIT,
      200,
      20,
      2_000,
    ),
    dailyNetworkUploadBytes: boundedInteger(
      env.DAILY_NETWORK_UPLOAD_BYTES,
      200_000_000,
      20_000_000,
      1_000_000_000,
    ),
    dailyDraftCreationLimit: boundedInteger(
      env.DAILY_DRAFT_CREATION_LIMIT,
      50,
      5,
      500,
    ),
    dailyNetworkDraftCreationLimit: boundedInteger(
      env.DAILY_NETWORK_DRAFT_CREATION_LIMIT,
      500,
      20,
      5_000,
    ),
    maximumDraftsPerOwner: boundedInteger(
      env.MAXIMUM_DRAFTS_PER_OWNER,
      100,
      10,
      1_000,
    ),
    dailyNetworkRegistrationLimit: boundedInteger(
      env.DAILY_NETWORK_REGISTRATION_LIMIT,
      100,
      5,
      500,
    ),
    dailyNetworkClassCodeFailureLimit: boundedInteger(
      env.DAILY_NETWORK_CLASS_CODE_FAILURE_LIMIT,
      500,
      20,
      5_000,
    ),
    classCodeFailureLockout: boundedInteger(
      env.CLASS_CODE_FAILURE_LOCKOUT,
      10,
      1,
      100,
    ),
    publicationTtlDays: boundedInteger(env.PUBLICATION_TTL_DAYS, 90, 1, 365),
    deviceTokenSigningSecret: env.DEVICE_TOKEN_SIGNING_SECRET,
    ...(env.STUDIO_SEED_IMPORT_TOKEN?.trim()
      ? { seedImportToken: env.STUDIO_SEED_IMPORT_TOKEN.trim() }
      : {}),
  };
}
