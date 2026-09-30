export type ModelOperation = "generate" | "revise" | "repair" | "moderate";
export type ArtifactOperation = "generate" | "revise";

export interface ModelCallTrace {
  kind: "model_call";
  requestId: string;
  operation: ModelOperation;
  provider: string;
  configuredModel: string;
  resolvedModel?: string;
  responseId?: string;
  gatewayRequestId?: string;
  status: "success" | "error";
  durationMs: number;
  systemBytes: number;
  inputBytes: number;
  finishReason?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ArtifactValidationTrace {
  kind: "artifact_validation";
  requestId: string;
  operation: ArtifactOperation;
  attempt: number;
  maxRepairs: number;
  status: "accepted" | "rejected";
  issueKinds: string[];
  issueCount: number;
  outputBytes?: number;
  hostInsertedAssetCount: number;
}

export interface RetrievalTrace {
  kind: "retrieval";
  requestId: string;
  mode: "automatic" | "preferred" | "none";
  entries: Array<{
    revisionId: string;
    rank: number;
    curated?: boolean;
  }>;
  durationMs: number;
}

export interface ArtifactCommitTrace {
  kind: "artifact_commit";
  requestId: string;
  operation: ArtifactOperation;
  artifactId: string;
  revisionId: string;
  sourceHash: string;
  outputBytes: number;
  exemplarRevisionIds: string[];
  durationMs: number;
}

export type OperationalTraceEvent =
  | ModelCallTrace
  | ArtifactValidationTrace
  | RetrievalTrace
  | ArtifactCommitTrace;

export interface OperationalTraceSink {
  emit(event: OperationalTraceEvent): void;
}

export interface OperationalTraceContext {
  requestId: string;
  sink: OperationalTraceSink;
}

export function emitOperationalTrace(
  sink: OperationalTraceSink,
  event: OperationalTraceEvent,
): void {
  try {
    sink.emit(event);
  } catch {
    console.warn("Tapplet operational trace sink unavailable.");
  }
}

export class MemoryOperationalTraceSink implements OperationalTraceSink {
  readonly events: OperationalTraceEvent[] = [];

  emit(event: OperationalTraceEvent): void {
    this.events.push(structuredClone(event));
  }
}

export const consoleOperationalTraceSink: OperationalTraceSink = {
  emit(event) {
    console.info(JSON.stringify({ event: "tapplet_operational_trace", ...event }));
  },
};
