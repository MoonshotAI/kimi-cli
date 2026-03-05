import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, X, Clock, ArrowRight, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Plan, PlanOption } from '../types';

interface PlanOptionSelectorProps {
  plan: Plan;
  onSelect: (optionId: number) => void;
  onCancel: () => void;
}

export function PlanOptionSelector({ plan, onSelect, onCancel }: PlanOptionSelectorProps) {
  const [selectedOptionId, setSelectedOptionId] = useState<number>(plan.options[0]?.id ?? 0);

  const handleSubmit = () => {
    onSelect(selectedOptionId);
  };

  const getApproachColor = (approach: string): string => {
    switch (approach) {
      case 'quick':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-200';
      case 'balanced':
        return 'bg-blue-500/10 text-blue-600 border-blue-200';
      case 'thorough':
        return 'bg-green-500/10 text-green-600 border-green-200';
      default:
        return 'bg-gray-500/10 text-gray-600 border-gray-200';
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Select an Option</h3>
        <p className="text-sm text-muted-foreground">
          Query: {plan.query}
        </p>
      </div>

      <div className="space-y-4">
        {plan.options.map((option) => (
          <OptionCard
            key={option.id}
            option={option}
            isSelected={selectedOptionId === option.id}
            onSelect={() => setSelectedOptionId(option.id)}
            approachColor={getApproachColor(option.approach)}
          />
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSubmit}>
          Execute Selected
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}

interface OptionCardProps {
  option: PlanOption;
  isSelected: boolean;
  onSelect: () => void;
  approachColor: string;
}

function OptionCard({ option, isSelected, onSelect, approachColor }: OptionCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:border-primary/50',
        isSelected && 'ring-2 ring-primary border-primary'
      )}
      onClick={onSelect}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
                isSelected
                  ? 'bg-primary border-primary'
                  : 'border-muted-foreground'
              )}
            >
              {isSelected && <CheckCircle className="w-3.5 h-3.5 text-primary-foreground" />}
            </div>
            <CardTitle className="text-lg">{option.title}</CardTitle>
          </div>
          <Badge variant="outline" className={approachColor}>
            {option.approach}
          </Badge>
        </div>
        <CardDescription className="mt-2">{option.description}</CardDescription>
      </CardHeader>
      <CardContent className="pb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <Clock className="w-4 h-4" />
          {option.estimated_time || 'Unknown duration'}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="font-medium text-green-600 mb-2 flex items-center gap-1">
              <Check className="w-4 h-4" />
              Pros
            </div>
            <ul className="space-y-1.5">
              {option.pros.map((pro, i) => (
                <li key={i} className="flex items-start gap-2 text-muted-foreground">
                  <span className="text-green-500 mt-0.5">•</span>
                  <span>{pro}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-medium text-red-600 mb-2 flex items-center gap-1">
              <X className="w-4 h-4" />
              Cons
            </div>
            <ul className="space-y-1.5">
              {option.cons.map((con, i) => (
                <li key={i} className="flex items-start gap-2 text-muted-foreground">
                  <span className="text-red-500 mt-0.5">•</span>
                  <span>{con}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
