import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle, XCircle, AlertCircle, Clock, Trash2, BarChart3, RotateCw } from 'lucide-react';
import { usePlans } from '../usePlans';
import type { HistoryEntry, HistoryStats } from '../types';
import { cn } from '@/lib/utils';

interface PlanHistoryViewProps {
  onSelectPlan?: (planId: string) => void;
}

export function PlanHistoryView({ onSelectPlan }: PlanHistoryViewProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { getHistory, deletePlan } = usePlans();

  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getHistory();
      setEntries(data.entries);
      setStats(data.stats);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setIsLoading(false);
    }
  }, [getHistory]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleDelete = async (planId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deletePlan(planId);
      loadHistory();
    } catch (err) {
      console.error('Failed to delete plan:', err);
    }
  };

  return (
    <div className="space-y-4">
      {stats && (
        <StatsCard stats={stats} />
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recent Plans</CardTitle>
            <CardDescription>Plans executed in this session</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={loadHistory}
            disabled={isLoading}
          >
            <RotateCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          </Button>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            <div className="space-y-2 pr-4">
              {entries.length === 0 ? (
                <EmptyState />
              ) : (
                entries.map((entry) => (
                  <HistoryItem
                    key={entry.plan_id}
                    entry={entry}
                    onClick={() => onSelectPlan?.(entry.plan_id)}
                    onDelete={(e) => handleDelete(entry.plan_id, e)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function StatsCard({ stats }: { stats: HistoryStats }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <BarChart3 className="w-5 h-5" />
          Session Statistics
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatItem label="Total Plans" value={stats.total} />
          <StatItem
            label="Success Rate"
            value={`${stats.success_rate.toFixed(0)}%`}
            className="text-green-600"
          />
          <StatItem label="Successful" value={stats.successful} className="text-green-600" />
          <StatItem label="Failed" value={stats.failed} className="text-red-600" />
        </div>
      </CardContent>
    </Card>
  );
}

function StatItem({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className="text-center p-2 bg-muted/50 rounded-lg">
      <div className={cn('text-2xl font-bold', className)}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center text-muted-foreground py-8 border-2 border-dashed border-border rounded-lg">
      <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
      <p>No plans executed yet</p>
      <p className="text-sm mt-1">Generate and execute a plan to see it here</p>
    </div>
  );
}

function HistoryItem({
  entry,
  onClick,
  onDelete,
}: {
  entry: HistoryEntry;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent cursor-pointer transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <OutcomeIcon outcome={entry.outcome} />
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{entry.query}</div>
          <div className="text-xs text-muted-foreground">
            {new Date(entry.started_at).toLocaleString()}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <OutcomeBadge outcome={entry.outcome} />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function OutcomeIcon({ outcome }: { outcome: HistoryEntry['outcome'] }) {
  const icons = {
    completed: <CheckCircle className="w-4 h-4 text-green-500" />,
    failed: <XCircle className="w-4 h-4 text-red-500" />,
    aborted: <AlertCircle className="w-4 h-4 text-yellow-500" />,
    unknown: <Clock className="w-4 h-4 text-gray-400" />,
  };

  return icons[outcome] || icons.unknown;
}

function OutcomeBadge({ outcome }: { outcome: HistoryEntry['outcome'] }) {
  const variants: Record<string, { className: string; label: string }> = {
    completed: { className: 'bg-green-500 hover:bg-green-500', label: 'Completed' },
    failed: { className: 'bg-red-500 hover:bg-red-500', label: 'Failed' },
    aborted: { className: 'bg-gray-500 hover:bg-gray-500', label: 'Aborted' },
    unknown: { className: 'bg-gray-400 hover:bg-gray-400', label: 'Unknown' },
  };

  const variant = variants[outcome] || variants.unknown;

  return (
    <Badge variant="default" className={variant.className}>
      {variant.label}
    </Badge>
  );
}
