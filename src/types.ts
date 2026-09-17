export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AdapterId = 'codex' | 'claude' | 'pi' | 'opencode';
export type Role = 'scout' | 'planner' | 'implementer' | 'reviewer' | 'explainer';
export type Question =
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { kind: 'boolean'; probability: number }
  | { kind: 'choice'; selected: string; probabilities: Record<string, number>; confidence?: number }
  | { kind: 'score'; value: number; levels: string[]; probabilities: Record<string, number>; confidence?: number };
export interface Usage {
  inputTotal?: number; inputCacheRead?: number; inputCacheWrite?: number;
  inputUncached?: number; outputTotal?: number; observedCost?: number;
  estimatedCost?: number; currency?: string;
  basis: 'provider-reported' | 'adapter-derived' | 'estimated' | 'unavailable';
}
export interface Evaluation {
  answers: Record<string, Answer>; requestedModel: string; resolvedModel?: string;
  provider: 'typesafe' | 'vercel'; usage: Usage;
}
export interface DecisionProvider {
  identity: string;
  evaluate(state: Json, questions: Record<string, Question>, signal?: AbortSignal): Promise<Evaluation>;
}
export interface Capabilities {
  adapter: AdapterId; binary: string; version: string;
  auth: 'verified' | 'unverified' | 'unavailable';
  structuredEvents: boolean; resumeById: boolean; modelSelection: boolean;
  modelIdentityObservable: boolean; structuredFinalReport: boolean;
  usageTelemetry: 'tokens-and-cache' | 'tokens-only' | 'none';
  delegationControl: boolean; executionPolicyControl: boolean;
  isolation: 'sandboxed' | 'workspace-only' | 'unknown';
  level: 'managed' | 'trusted-local' | 'assisted' | 'unavailable';
  helpHash: string; note: string;
}
export interface Profile {
  tier?: 'fast' | 'standard' | 'deep' | 'review';
  id: string; adapter: AdapterId; binary: string; version: string;
  model?: string; provider?: string; thinking?: string;
  roles: Role[]; enabled: boolean; level: Capabilities['level'];
  capabilityHash: string; maxTurns: number; timeoutMs: number;
}
export interface CommandSpec { argv: string[]; timeoutMs: number; env?: Record<string, string>; }
export interface Trust {
  repo: string; shareCode: boolean; allowLocalExecution: boolean;
  allowNoTests: boolean; tests: CommandSpec[]; setup: CommandSpec[];
  exclude: string[]; maxEvidenceBytes: number; approvedAt: string;
  skills: string[];
}
export interface Config {
  version: 1;
  decision: {
    provider: 'typesafe' | 'vercel'; model: string;
    transport: 'http' | 'sdk'; timeoutMs: number; retries: number;
    endpoint?: string; immutableModel: boolean;
    keyStore: 'environment' | 'keychain';
    gatewayOptions: Record<string, Json>;
  };
  runtime: {
    maxParallel: number; maxRepairs: number; maxSameFailure: number;
    maxWorkerStarts: number; maxDecisions: number; maxRunMs: number;
    maxTasks: number; maxLogBytes: number;
  };
  thresholds: { route: number; accept: number; highRiskAccept: number; evidence: number; };
  profiles: Profile[]; trusts: Record<string, Trust>;
}
export interface TaskSpec {
  id: string; title: string; instruction: string; acceptance: string[];
  dependsOn: string[]; readPaths: string[]; writePaths: string[]; resources: string[];
}
export type Phase = 'assess' | 'plan-review' | 'implement' | 'verify' | 'review' | 'judge' | 'stage' | 'done' | 'blocked';
export type TaskStatus = 'queued' | 'ready' | 'running' | 'reported' | 'verifying' | 'reviewing' | 'rework' | 'accepted' | 'staging' | 'blocked' | 'done';
export interface Finding {
  id: string; requirement: string; snapshot: string;
  severity: 'info' | 'warning' | 'blocker'; evidence: string; reproduce: string;
  status: 'open' | 'fixed' | 'disputed' | 'not-applicable';
  sources: string[]; duplicateOf?: string;
}
export interface WorkerReport {
  summary: string; claims: string[]; questions: string[];
  plan?: TaskSpec[]; findings?: Omit<Finding, 'snapshot' | 'sources'>[];
}
export interface Evidence {
  id: string; kind: 'user-request' | 'code-diff' | 'test' | 'review' | 'observation';
  sourceHash: string; snapshot: string; excerpt: string; producer: string;
  trust: 'runtime-observed' | 'worker-claimed' | 'user-specified'; truncated: boolean;
}
export interface Task {
  id: string; runId: string; spec: TaskSpec; version: number;
  phase: Phase; status: TaskStatus; kind: 'work' | 'conflict' | 'integration';
  workspace?: string; branch?: string; base?: string; snapshot?: string;
  profileId?: string; activeProfileId?: string; activeRole?: Role; sessionId?: string; sessionFingerprint?: string; observedModel?: string;
  attempts: number; diagnoses: number; reviewCount: number; requiredReviews: number;
  evidence: Evidence[]; findings: Finding[]; proposedPlan?: TaskSpec[];
  assessments?: Record<string, Answer>;
  lastReport?: WorkerReport; lastFailure?: string; sameFailure: number;
  testsPassed?: boolean; testedSnapshot?: string; reviewedSnapshot?: string;
  staged: boolean; activeOperation?: string; lastActivity?: string;
  blockReason?: string; contextIds: string[];
}
export interface Run {
  id: string; repo: string; repoId: string; goal: string; scopeVersion: number;
  createdAt: string; updatedAt: string;
  status: 'running' | 'paused' | 'blocked' | 'ready_for_user_apply' | 'applied' | 'cancelled';
  base: string; checkoutHead: string; checkoutFingerprint: string;
  integration: string; integrationBranch: string; integrationHead: string;
  mode: 'worktree' | 'in-place'; config: Config; trust: Trust;
  workerStarts: number; decisionCalls: number; instructionVersion: string;
  finalSnapshot?: string; inPlaceFingerprint?: string; pendingMessage?: string;
  blockReason?: string; detached: boolean; activeMs?: number; activeSince?: string;
}
export type ActionKind = 'REQUEST_SCOUT' | 'REQUEST_PLAN' | 'ACCEPT_PLAN' | 'START_TASK'
  | 'REQUEST_REVIEW' | 'REQUEST_EVIDENCE' | 'REWORK_SAME_SESSION' | 'REASSIGN_TASK'
  | 'ACCEPT_TASK' | 'STAGE_INTEGRATION' | 'ASK_USER' | 'PAUSE' | 'CANCEL';
export interface Candidate {
  id: string; kind: ActionKind; taskId: string; profileId?: string;
  sessionId?: string; workspace?: string; evidenceIds: string[];
  reason: string; specialization?: string; findingResolutions?: Record<string, Finding['status']>;
}
export interface Decision {
  id: string; runId: string; taskId: string; refs: Record<string, number>;
  semanticHash: string; questionArtifact?: string; candidateHash: string; questionVersion: string; policyHash: string;
  provider: string; requestedModel: string; resolvedModel?: string;
  answers: Record<string, Answer>; selected?: Candidate;
  outcome: 'execute' | 'abstain' | 'invalid' | 'stale' | 'policy-denied';
  evidenceIds: string[]; sourceDecisionId?: string; createdAt: string;
}
export interface Operation {
  id: string; runId: string; taskId: string; decisionId: string; candidate: Candidate;
  state: 'pending' | 'running' | 'done' | 'unknown' | 'failed';
  startedAt?: string; pid?: number; birth?: string; receipt?: string; error?: string;
}
export interface AgentEvent {
  type: 'session' | 'text' | 'tool' | 'usage' | 'error' | 'done';
  text?: string; sessionId?: string; model?: string; usage?: Usage; key?: string;
}
export interface Invocation {
  id: string; runId: string; taskId: string; role: Role; profile: Profile;
  cwd: string; prompt: string; sessionId?: string; sessionDir: string;
  signal: AbortSignal; onEvent: (event: AgentEvent) => void;
  onSpawn?: (pid: number, birth?: string) => void;
}
export interface AgentResult {
  status: 'reported' | 'failed' | 'interrupted' | 'unknown';
  sessionId?: string; report?: WorkerReport; text: string; error?: string;
  usage: Usage[]; model?: string;
}
export interface AgentAdapter { run(invocation: Invocation): Promise<AgentResult>; }
export interface View {
  run?: Run; tasks: Task[];
  events: { time: string; kind: string; text: string; taskId?: string }[];
  agents: Profile[]; usage: Usage[]; decisions: Decision[];
}
