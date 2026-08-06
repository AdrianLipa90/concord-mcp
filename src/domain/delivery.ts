/**
 * How a message reaches an agent, and what an agent can be reached *during*.
 *
 * A Concord `agent_id` is the standard identity; `agent_endpoints` is the
 * routing table that says how to get to it. Everything harness-specific lives
 * behind these two closed unions, so adding a client means adding a case the
 * compiler forces you to handle — not a new branch in the send path.
 */

/** Delivery direction for a registered endpoint. */
export const transports = ['pull', 'app-server'] as const;
export type Transport = (typeof transports)[number];

/**
 * Which states an agent can be reached in.
 *
 * `busy` — a turn is running, so a tool-result hook will be hit.
 * `idle`  — sitting at the prompt with nothing scheduled; only a background
 *           watcher or an external push gets in.
 *
 * Codex hooks are `busy` only: an idle Codex session runs no hook and does not
 * see a queued message until its next turn. Telling the sender that is the
 * difference between "queued" and "silently ignored for an hour".
 */
export const reaches = ['busy', 'idle'] as const;
type Reach = (typeof reaches)[number];

interface EndpointCapability {
  transport: Transport;
  reach: readonly Reach[];
}

const CAPABILITIES: Record<string, EndpointCapability> = {
  // A plugin monitor polls for the life of the session, so an idle Claude
  // Code agent is reachable; the hooks cover the busy case.
  'claude-code': { transport: 'pull', reach: ['busy', 'idle'] },
  // Hooks only. See the note above about idle Codex sessions.
  codex: { transport: 'pull', reach: ['busy'] },
};

const FALLBACK: EndpointCapability = { transport: 'pull', reach: ['busy'] };

/** What a given client can do. Unknown clients get the conservative answer. */
export function capabilityFor(provider: string): EndpointCapability {
  return CAPABILITIES[provider] ?? FALLBACK;
}

/** Serialize a capability for the endpoint row's `capabilities` column. */
export function encodeCapabilities(capability: EndpointCapability): string[] {
  return [capability.transport, ...capability.reach];
}

/** Read reach back off a stored endpoint. */
function decodeReach(capabilities: readonly string[]): Reach[] {
  return reaches.filter((reach) => capabilities.includes(reach));
}

/**
 * What to tell the sender about a message that has been accepted but not yet
 * seen. An agent that cannot be reached while idle may sit on it indefinitely,
 * and a sender that believes otherwise will wait on a reply that never comes.
 */
export function deliveryOutlook(capabilities: readonly string[]): string {
  return decodeReach(capabilities).includes('idle')
    ? 'It will arrive on its own, whether that agent is working or idle.'
    : 'That agent only checks between steps of its own work, so an idle session ' +
        'will not see this until its next turn.';
}
