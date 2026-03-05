import { useState, useCallback, useEffect, useRef } from 'react';
import { getAuthToken } from '@/lib/auth';
import type { PlanExecution, StepExecution } from './types';

interface UsePlanExecutionReturn {
  execution: PlanExecution | null;
  isConnected: boolean;
  error: string | null;
  startStreaming: () => void;
  stopStreaming: () => void;
}

interface SSEEventData {
  type: string;
  execution?: PlanExecution;
  step?: StepExecution;
}

export function usePlanExecution(planId: string | null): UsePlanExecutionReturn {
  const [execution, setExecution] = useState<PlanExecution | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const stopStreaming = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    }
  }, []);

  const startStreaming = useCallback(() => {
    if (!planId) return;

    // Close existing connection
    stopStreaming();
    setError(null);

    // Build URL with auth token if available
    const token = getAuthToken();
    let url = `/api/plans/${planId}/execute/stream`;
    if (token) {
      url += `?token=${encodeURIComponent(token)}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data: SSEEventData = JSON.parse(event.data);
        
        if (data.type === 'execution_update' && data.execution) {
          setExecution(data.execution);
        } else if (data.type === 'step_complete' && data.step) {
          setExecution((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              steps: prev.steps.map((s) =>
                s.step_number === data.step!.step_number ? data.step! : s
              ),
            };
          });
        } else if (data.type === 'complete') {
          if (data.execution) {
            setExecution(data.execution);
          }
          es.close();
          setIsConnected(false);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    es.onerror = () => {
      setError('Connection error');
      setIsConnected(false);
      es.close();
    };
  }, [planId, stopStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return {
    execution,
    isConnected,
    error,
    startStreaming,
    stopStreaming,
  };
}
