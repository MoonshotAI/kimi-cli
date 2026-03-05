import { useState, useCallback } from 'react';
import { getApiBaseUrl } from '@/hooks/utils';
import { getAuthHeader } from '@/lib/auth';
import type { 
  Plan, 
  PlanExecution, 
  HistoryEntry, 
  HistoryStats,
  GeneratePlanRequest,
  ExecutePlanRequest,
  ExecutionResponse,
  SuccessResponse,
  ScheduledPlan,
} from './types';

const API_BASE = '/api/plans';

interface UsePlansReturn {
  loading: boolean;
  error: string | null;
  listPlans: () => Promise<Plan[]>;
  getPlan: (planId: string) => Promise<Plan>;
  generatePlan: (query: string, contextFiles?: string[]) => Promise<Plan>;
  executePlan: (planId: string, optionId?: number, resume?: boolean) => Promise<ExecutionResponse>;
  getExecutionStatus: (planId: string) => Promise<PlanExecution>;
  deletePlan: (planId: string) => Promise<void>;
  getHistory: () => Promise<{ entries: HistoryEntry[]; stats: HistoryStats }>;
  listScheduled: () => Promise<ScheduledPlan[]>;
  getAnalytics: () => Promise<Record<string, unknown>>;
}

async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeader(),
    ...options?.headers,
  };
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(errorData.detail || `Request failed: ${response.statusText}`);
  }
  
  return response;
}

export function usePlans(): UsePlansReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listPlans = useCallback(async (): Promise<Plan[]> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/`);
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plans';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const getPlan = useCallback(async (planId: string): Promise<Plan> => {
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/${planId}`);
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Plan not found';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const generatePlan = useCallback(async (query: string, contextFiles?: string[]): Promise<Plan> => {
    setLoading(true);
    setError(null);
    try {
      const body: GeneratePlanRequest = { query, context_files: contextFiles };
      const res = await fetchWithAuth(`${API_BASE}/generate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate plan';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const executePlan = useCallback(async (planId: string, optionId?: number, resume?: boolean): Promise<ExecutionResponse> => {
    setError(null);
    try {
      const body: ExecutePlanRequest = { option_id: optionId, resume };
      const res = await fetchWithAuth(`${API_BASE}/${planId}/execute`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start execution';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const getExecutionStatus = useCallback(async (planId: string): Promise<PlanExecution> => {
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/${planId}/execution`);
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Execution not found';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const deletePlan = useCallback(async (planId: string): Promise<void> => {
    setError(null);
    try {
      await fetchWithAuth(`${API_BASE}/${planId}`, { method: 'DELETE' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete plan';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const getHistory = useCallback(async (): Promise<{ entries: HistoryEntry[]; stats: HistoryStats }> => {
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/history/session`);
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch history';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const listScheduled = useCallback(async (): Promise<ScheduledPlan[]> => {
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/scheduled/list`);
      return await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch scheduled plans';
      setError(message);
      throw new Error(message);
    }
  }, []);

  const getAnalytics = useCallback(async (): Promise<Record<string, unknown>> => {
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/analytics/overall`);
      const data = await res.json();
      return data.stats;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch analytics';
      setError(message);
      throw new Error(message);
    }
  }, []);

  return {
    loading,
    error,
    listPlans,
    getPlan,
    generatePlan,
    executePlan,
    getExecutionStatus,
    deletePlan,
    getHistory,
    listScheduled,
    getAnalytics,
  };
}
