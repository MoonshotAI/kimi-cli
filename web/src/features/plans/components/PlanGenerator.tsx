import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, Sparkles } from 'lucide-react';
import { usePlans } from '../usePlans';
import type { Plan } from '../types';

interface PlanGeneratorProps {
  onPlanGenerated: (plan: Plan) => void;
}

export function PlanGenerator({ onPlanGenerated }: PlanGeneratorProps) {
  const [query, setQuery] = useState('');
  const { generatePlan, loading } = usePlans();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    try {
      const plan = await generatePlan(query);
      onPlanGenerated(plan);
    } catch (err) {
      // Error handled by hook
      console.error('Failed to generate plan:', err);
    }
  };

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          Generate Plan
        </CardTitle>
        <CardDescription>
          Describe what you want to accomplish and we&apos;ll generate a plan with multiple options.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="plan-query" className="text-sm font-medium">
              What would you like to do?
            </label>
            <Input
              id="plan-query"
              placeholder="e.g., Refactor the authentication system..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
              className="w-full"
            />
          </div>
          <Button type="submit" disabled={loading || !query.trim()} className="w-full">
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Plan
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
