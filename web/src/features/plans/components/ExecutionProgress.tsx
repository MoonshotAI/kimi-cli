import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, CheckCircle, XCircle, AlertCircle, Clock, FileCode } from 'lucide-react';
import { usePlanExecution } from '../usePlanExecution';
import type { PlanExecution, StepExecution } from '../types';
import { cn } from '@/lib/utils';

interface ExecutionProgressProps {
  planId: string;
  execution?: PlanExecution | null;
}

export function ExecutionProgress({ planId, execution: propExecution }: ExecutionProgressProps) {
  const { execution: streamedExecution, isConnected, startStreaming, stopStreaming } = usePlanExecution(planId);

  const execution = propExecution || streamedExecution;

  useEffect(() => {
    if (planId && !propExecution) {
      startStreaming();
    }
    return () => stopStreaming();
  }, [planId, propExecution, startStreaming, stopStreaming]);

  if (!execution) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          Loading execution status...
        </CardContent>
      </Card>
    );
  }

  const totalSteps = execution.steps.length;
  const completedSteps = execution.steps.filter((s) => s.status === 'completed').length;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Execution Progress</CardTitle>
          <StatusBadge status={execution.status} />
        </div>
        {isConnected && (
          <div className="text-xs text-green-600 flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            Live updates
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Overall Progress</span>
            <span className="font-medium">
              {completedSteps}/{totalSteps} steps
            </span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        <ScrollArea className="h-64">
          <div className="space-y-2 pr-4">
            {execution.steps.map((step) => (
              <StepItem key={step.step_number} step={step} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: PlanExecution['status'] }) {
  const variants: Record<string, { className: string; label: string }> = {
    running: { className: 'bg-blue-500 hover:bg-blue-500', label: 'Running' },
    completed: { className: 'bg-green-500 hover:bg-green-500', label: 'Completed' },
    failed: { className: 'bg-red-500 hover:bg-red-500', label: 'Failed' },
    aborted: { className: 'bg-gray-500 hover:bg-gray-500', label: 'Aborted' },
    pending: { className: 'bg-gray-400 hover:bg-gray-400', label: 'Pending' },
  };

  const variant = variants[status] || variants.pending;

  return (
    <Badge variant="default" className={variant.className}>
      {variant.label}
    </Badge>
  );
}

function StepItem({ step }: { step: StepExecution }) {
  const getStatusIcon = (status: StepExecution['status']) => {
    switch (status) {
      case 'running':
        return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'skipped':
        return <AlertCircle className="w-4 h-4 text-yellow-500" />;
      default:
        return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  const getStatusClassName = (status: StepExecution['status']) => {
    switch (status) {
      case 'running':
        return 'bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-800';
      case 'completed':
        return 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800';
      case 'failed':
        return 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800';
      case 'skipped':
        return 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/20 dark:border-yellow-800';
      default:
        return 'bg-gray-50 border-gray-200 dark:bg-gray-900 dark:border-gray-800';
    }
  };

  return (
    <div
      className={cn(
        'p-3 rounded-lg border transition-colors',
        getStatusClassName(step.status)
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getStatusIcon(step.status)}
          <span className="font-medium text-sm">
            Step {step.step_number}: {step.title}
          </span>
        </div>
        {step.file_changes.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileCode className="w-3 h-3" />
            {step.file_changes.length} files
          </div>
        )}
      </div>
      {step.error_message && (
        <div className="mt-2 text-xs text-red-600 bg-red-100 dark:bg-red-950/30 p-2 rounded">
          {step.error_message}
        </div>
      )}
    </div>
  );
}
