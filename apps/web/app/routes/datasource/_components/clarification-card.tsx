import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@qwery/ui/button';
import { Textarea } from '@qwery/ui/textarea';

interface Question {
  question: string;
  assumption: string;
}

interface Props {
  questions: Question[];
  disabled: boolean;
  onAnswer: (text: string) => void;
  onProceedWithAssumptions: () => void;
}

export function ClarificationCard({
  questions,
  disabled,
  onAnswer,
  onProceedWithAssumptions,
}: Props) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && answer.trim()) {
      e.preventDefault();
      onAnswer(answer.trim());
      setAnswer('');
    }
  };

  const handleAnswer = () => {
    if (!answer.trim()) return;
    onAnswer(answer.trim());
    setAnswer('');
  };

  return (
    <div className="mt-2 rounded-xl border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-800 dark:bg-blue-950/20">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-blue-700 dark:text-blue-400">
        <HelpCircle className="h-4 w-4" />
        {t('datasource.agent.clarificationNeeded', {
          defaultValue: 'Clarification needed',
        })}
      </div>

      <div className="mb-3 space-y-2">
        {questions.map((q, i) => (
          <div key={i}>
            <p className="text-sm font-medium">{q.question}</p>
            {q.assumption && (
              <p className="text-muted-foreground text-xs">
                {t('datasource.agent.assumption', {
                  defaultValue: 'Assumption',
                })}
                : {q.assumption}
              </p>
            )}
          </div>
        ))}
      </div>

      <Textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('datasource.agent.clarificationPlaceholder', {
          defaultValue: 'Type your answer… (Enter to submit)',
        })}
        className="mb-2 min-h-[60px] resize-none text-sm"
        disabled={disabled}
        data-test="clarification-input"
      />

      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onProceedWithAssumptions}
          data-test="proceed-with-assumptions"
        >
          {t('datasource.agent.proceedWithAssumptions', {
            defaultValue: 'Proceed with assumptions',
          })}
        </Button>
        <Button
          size="sm"
          disabled={disabled || !answer.trim()}
          onClick={handleAnswer}
          data-test="submit-clarification"
        >
          {t('datasource.agent.answer', { defaultValue: 'Answer' })}
        </Button>
      </div>
    </div>
  );
}
