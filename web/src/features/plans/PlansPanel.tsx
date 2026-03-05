import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PlanGenerator } from './components/PlanGenerator';
import { PlanOptionSelector } from './components/PlanOptionSelector';
import { ExecutionProgress } from './components/ExecutionProgress';
import { PlanHistoryView } from './components/PlanHistoryView';
import { Plus, History, Play, ChevronLeft } from 'lucide-react';
import { usePlans } from './usePlans';
import type { Plan, PlanExecution, ViewState } from './types';
import { cn } from '@/lib/utils';

interface PlansPanelProps {
  className?: string;
}

export function PlansPanel({ className }: PlansPanelProps) {
  const [view, setView] = useState<ViewState>('generator');
  const [currentPlan, setCurrentPlan] = useState<Plan | null>(null);
  const [currentExecution, setCurrentExecution] = useState<PlanExecution | null>(null);
  const { executePlan, getExecutionStatus, getPlan } = usePlans();

  const handlePlanGenerated = useCallback((plan: Plan) => {
    setCurrentPlan(plan);
    setView('selector');
  }, []);

  const handleOptionSelected = useCallback(
    async (optionId: number) => {
      if (!currentPlan) return;

      try {
        await executePlan(currentPlan.plan_id, optionId);

        // Poll for initial execution status
        const status = await getExecutionStatus(currentPlan.plan_id);
        setCurrentExecution(status);
        setView('execution');
      } catch (err) {
        console.error('Failed to start execution:', err);
      }
    },
    [currentPlan, executePlan, getExecutionStatus]
  );

  const handleSelectFromHistory = useCallback(
    async (planId: string) => {
      try {
        // Try to get execution status first
        const status = await getExecutionStatus(planId);
        setCurrentExecution(status);
        setView('execution');
      } catch {
        // If no execution, try to load the plan
        try {
          const plan = await getPlan(planId);
          setCurrentPlan(plan);
          setView('selector');
        } catch (err) {
          console.error('Failed to load plan:', err);
        }
      }
    },
    [getExecutionStatus, getPlan]
  );

  const handleNewPlan = useCallback(() => {
    setCurrentPlan(null);
    setCurrentExecution(null);
    setView('generator');
  }, []);

  const handleBack = useCallback(() => {
    if (view === 'execution') {
      setView('history');
    } else if (view === 'selector') {
      setView('generator');
    } else {
      setView('history');
    }
  }, [view]);

  return (
    <div className={cn('h-full flex flex-col', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <div className="flex items-center gap-2">
          {view !== 'generator' && (
            <Button variant="ghost" size="icon" onClick={handleBack} className="mr-1">
              <ChevronLeft className="w-4 h-4" />
            </Button>
          )}
          <div>
            <CardTitle className="text-lg">Plans</CardTitle>
            <p className="text-xs text-muted-foreground">
              {view === 'generator' && 'Generate a new plan'}
              {view === 'selector' && 'Choose an execution option'}
              {view === 'execution' && 'Monitor execution progress'}
              {view === 'history' && 'View past executions'}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === 'history' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView('history')}
          >
            <History className="w-4 h-4 mr-2" />
            History
          </Button>
          <Button size="sm" onClick={handleNewPlan}>
            <Plus className="w-4 h-4 mr-2" />
            New Plan
          </Button>
        </div>
      </CardHeader>

      <Separator />

      <div className="flex-1 overflow-auto p-4">
        {view === 'generator' && (
          <div className="flex justify-center pt-8">
            <PlanGenerator onPlanGenerated={handlePlanGenerated} />
          </div>
        )}

        {view === 'selector' && currentPlan && (
          <div className="max-w-3xl mx-auto">
            <PlanOptionSelector
              plan={currentPlan}
              onSelect={handleOptionSelected}
              onCancel={() => setView('generator')}
            />
          </div>
        )}

        {view === 'execution' && (
          <div className="max-w-2xl mx-auto">
            <ExecutionProgress
              planId={currentPlan?.plan_id || currentExecution?.plan_id || ''}
              execution={currentExecution}
            />
          </div>
        )}

        {view === 'history' && (
          <div className="max-w-2xl mx-auto">
            <PlanHistoryView onSelectPlan={handleSelectFromHistory} />
          </div>
        )}
      </div>
    </div>
  );
}
