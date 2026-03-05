// Plan types

export interface PlanOption {
  id: number;
  title: string;
  description: string;
  approach: 'quick' | 'balanced' | 'thorough';
  estimated_time: string;
  pros: string[];
  cons: string[];
}

export interface PlanStep {
  step_number: number;
  title: string;
  description: string;
  files_to_modify: string[];
  dependencies: number[];
  can_parallel: boolean;
}

export interface Plan {
  plan_id: string;
  query: string;
  options: PlanOption[];
  steps: PlanStep[];
  created_at: string;
}

// Execution types

export interface FileChange {
  path: string;
  change_type: 'added' | 'modified' | 'deleted';
}

export interface StepExecution {
  step_number: number;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  retry_count: number;
  file_changes: FileChange[];
  lines_added: number;
  lines_removed: number;
}

export interface PlanExecution {
  plan_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  steps: StepExecution[];
  started_at?: string;
  completed_at?: string;
  current_step: number;
}

// History types

export interface HistoryEntry {
  plan_id: string;
  query: string;
  started_at: string;
  completed_at?: string;
  outcome: 'completed' | 'failed' | 'aborted' | 'unknown';
  files_changed: number;
}

export interface HistoryStats {
  total: number;
  successful: number;
  failed: number;
  success_rate: number;
  avg_duration_seconds: number;
  total_files_changed: number;
}

// Scheduled plan types

export interface ScheduledPlan {
  schedule_id: string;
  plan_id: string;
  scheduled_at: string;
  run_at: string;
  query: string;
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
}

// API request/response types

export interface GeneratePlanRequest {
  query: string;
  context_files?: string[];
}

export interface ExecutePlanRequest {
  option_id?: number;
  resume?: boolean;
}

export interface ExecutionResponse {
  plan_id: string;
  execution_id: string;
  status: string;
}

export interface SuccessResponse {
  success: boolean;
}

export interface AnalyticsResponse {
  stats: Record<string, unknown>;
}

// Component prop types

export type ViewState = 'generator' | 'selector' | 'execution' | 'history';
