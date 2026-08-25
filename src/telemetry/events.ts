export type TelemetryOutcome = 'success' | 'error';

export type SemanticTelemetryEvent =
  | {
      event_type: 'claim_evaluated';
      task_flow_id: string;
      claim_mode: 'new_claim' | 'claim' | 'assignment' | 'handoff' | 'reopen';
      checked_task_count: number;
      overlap_count: number;
      overlap_kinds: string[];
      breadth_warning_count: number;
    }
  | {
      event_type: 'edit_guard_evaluated';
      task_flow_id: string | null;
      result: 'clear' | 'warned' | 'blocked';
      conflicting_task_count: number;
    }
  | {
      event_type: 'message_delivery';
      task_flow_id: string | null;
      message_kind: 'prompt' | 'reply';
      stage: 'send' | 'receive';
      result: 'delivered' | 'queued' | 'failed' | 'replied';
      delivery_mode: 'inject' | 'steer' | 'pull' | null;
      error_code: string | null;
      latency_ms: number | null;
    }
  | {
      event_type: 'task_lifecycle';
      task_flow_id: string;
      transition:
        'finish' | 'assign' | 'accept' | 'decline' | 'release' | 'reassign' | 'offer' | 'reopen';
      status: string;
      elapsed_ms: number | null;
    }
  | {
      event_type: 'reported_outcome';
      task_flow_id: string;
      source: 'agent' | 'ci' | 'review' | 'human';
      acceptance: 'accepted' | 'rejected' | 'not_checked';
      integration: 'passed' | 'failed' | 'not_checked';
      human_intervention_ms: number | null;
      rework_ms: number | null;
    };

export interface TelemetryRecorder {
  taskPseudonym(taskId: string): string | null;
  recordOperation(operation: string, outcome: TelemetryOutcome, durationMs: number): void;
  recordEvent(event: SemanticTelemetryEvent, workspaceRoot?: string): void;
}
