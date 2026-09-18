import { homedir } from 'node:os';
import { execute, executable } from '../process.ts';
import { workerEnvironment, terminalText } from '../security.ts';
import { hash, invariant } from '../util.ts';
import type { AdapterId, Capabilities, Profile, Role } from '../types.ts';
const IDS: AdapterId[] = ['codex', 'claude', 'pi', 'opencode'];
export async function detectOne(adapter: AdapterId, binary?: string): Promise<Capabilities | undefined> {
  const path = binary ?? executable(adapter, process.cwd());
  if (!path) return undefined;
  try {
    const version = await execute([path, '--version'], { cwd: homedir(), timeoutMs: 5000, env: workerEnvironment(), maxBytes: 16_000 });
    const helpArgs = adapter === 'codex' ? ['exec', '--help'] : adapter === 'opencode' ? ['run', '--help'] : ['--help'];
    const help = await execute([path, ...helpArgs], { cwd: homedir(), timeoutMs: 5000, env: workerEnvironment(), maxBytes: 80_000 });
    if (version.code !== 0 || help.code !== 0 || version.timedOut || help.timedOut) return undefined;
    const v = terminalText(version.stdout || version.stderr).trim().slice(0, 200), h = help.stdout + help.stderr;
    const structured = adapter === 'codex' ? h.includes('--json') : adapter === 'claude' ? h.includes('--output-format') : adapter === 'pi' ? h.includes('--mode') : h.includes('--format');
    const policy = adapter === 'codex' ? h.includes('--sandbox') : adapter === 'claude' ? h.includes('--permission-mode') : adapter === 'pi' ? h.includes('--tools') && h.includes('--no-extensions') : false;
    // A capability probe is not a certification of upstream releases. Pin this exact version/help to the explicitly approved profile.
    return { adapter, binary: path, version: v, auth: 'unverified', structuredEvents: structured,
      resumeById: adapter === 'codex' ? h.includes('resume') : h.includes('--resume') || h.includes('--session'),
      modelSelection: h.includes('--model'), modelIdentityObservable: adapter !== 'codex', structuredFinalReport: structured,
      usageTelemetry: structured ? 'tokens-and-cache' : 'none', delegationControl: adapter === 'pi' || adapter === 'claude',
      executionPolicyControl: policy, isolation: adapter === 'codex' && policy ? 'sandboxed' : 'workspace-only',
      projectTrustControl: adapter === 'pi' && h.includes('--no-approve') && h.includes('--no-context-files'),
      level: structured ? 'trusted-local' : 'assisted', helpHash: hash({ v, h }),
      note: 'Authentication is not tested by discovery. Local tools/configuration must be trusted; worktrees are not an OS sandbox.' };
  } catch { return undefined; }
}
export async function detectAll(): Promise<Capabilities[]> { return (await Promise.all(IDS.map(id => detectOne(id)))).filter((v): v is Capabilities => !!v); }
export function profileFrom(capability: Capabilities, id = capability.adapter, roles: Role[] = ['scout', 'planner', 'implementer', 'reviewer', 'explainer']): Profile {
  invariant(capability.structuredEvents, 'CLI does not expose a supported structured protocol');
  return { id, adapter: capability.adapter, binary: capability.binary, version: capability.version, roles, enabled: true,
    level: capability.level, capabilityHash: capability.helpHash, maxTurns: 30, timeoutMs: 600_000 };
}
export async function validateInstalled(profile: Profile): Promise<void> {
  const current = await detectOne(profile.adapter, profile.binary);
  invariant(current && current.version === profile.version && current.helpHash === profile.capabilityHash,
    `CLI ${profile.id} changed or is unavailable. Run jvo setup to inspect and explicitly re-approve its version.`);
  invariant(current.structuredEvents, 'CLI no longer exposes structured events');
}
