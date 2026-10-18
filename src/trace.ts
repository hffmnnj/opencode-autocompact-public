/**
 * One decision the compactor made. Entries carry session IDs and timings only, never conversation content or
 * native error text, so the log is safe to keep and share.
 */
export type Trace =
  | { readonly event: "loaded"; readonly idleSeconds: number; readonly cacheTtlSeconds: number; readonly includeSubagents: boolean }
  | { readonly event: "disposed" }
  | { readonly event: "owned"; readonly sessionID: string; readonly via: "prompt" | "context" }
  | { readonly event: "armed"; readonly sessionID: string; readonly via: "settled" | "keepalive"; readonly fireInMs: number }
  | { readonly event: "disarmed"; readonly sessionID: string; readonly why: "prompt" | "model-call" | "execution-started" | "compaction-seen" | "forgotten" }
  | { readonly event: "keepalive-ignored"; readonly sessionID: string; readonly why: "running" | "already-compacted" }
  | { readonly event: "settle-ignored"; readonly sessionID: string; readonly why: "already-compacted" }
  | { readonly event: "skipped"; readonly sessionID: string; readonly why: "cache-expired" | "ineligible" | "activity-during-lookup"; readonly idleMs: number }
  | { readonly event: "compacting"; readonly sessionID: string; readonly idleMs: number }
  | { readonly event: "compaction-seen"; readonly sessionID: string; readonly by: "plugin" | "other" }
  | { readonly event: "compact-result"; readonly sessionID: string; readonly ok: boolean; readonly errorName?: string };

export type TraceSink = (trace: Trace) => void;
