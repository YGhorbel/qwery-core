'use client';

import * as React from 'react';
import { AlertCircle, ChevronRight, XCircle } from 'lucide-react';
import type { ZodError, ZodIssue } from 'zod';
import { cn } from '@qwery/ui/utils';
import { Alert, AlertDescription, AlertTitle } from '@qwery/ui/alert';

interface ZodErrorVisualizerProps {
    error: ZodError | null;
    className?: string;
    title?: string;
}

export function ZodErrorVisualizer({
    error,
    className,
    title = 'Validation Errors',
}: ZodErrorVisualizerProps) {
    if (!error || error.issues.length === 0) {
        return null;
    }

    // Group issues by path for better visualization
    const issuesByPath = error.issues.reduce<Record<string, ZodIssue[]>>(
        (acc, issue) => {
            const path = issue.path.join('.') || 'General';
            if (!acc[path]) acc[path] = [];
            acc[path].push(issue);
            return acc;
        },
        {},
    );

    return (
        <div
            className={cn(
                'animate-in fade-in slide-in-from-top-2 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50/50 p-4 transition-all dark:border-red-900/50 dark:bg-red-950/20',
                className,
            )}
        >
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <XCircle className="size-5 shrink-0" />
                <h4 className="text-sm font-bold uppercase tracking-wider">{title}</h4>
                <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold dark:bg-red-900/50">
                    {error.issues.length}
                </span>
            </div>

            <div className="space-y-3">
                {Object.entries(issuesByPath).map(([path, issues]) => (
                    <div key={path} className="group relative">
                        <div className="flex items-center gap-2 px-1">
                            <span className="text-muted-foreground/60">
                                <ChevronRight className="size-3" />
                            </span>
                            <span className="text-[11px] font-semibold text-red-800/70 uppercase dark:text-red-400/70">
                                {path.replace(/_/g, ' ')}
                            </span>
                        </div>
                        <ul className="mt-1 space-y-1.5 pl-6">
                            {issues.map((issue, idx) => (
                                <li
                                    key={`${path}-${idx}`}
                                    className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300"
                                >
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-red-400/50" />
                                    <span className="leading-relaxed font-medium">
                                        {issue.message}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>

            <div className="mt-1 flex items-center gap-2 border-t border-red-200/50 pt-3 text-[11px] font-medium text-red-600/60 dark:border-red-900/30 dark:text-red-400/40">
                <AlertCircle className="size-3" />
                <span>Please correct the highlighted fields above to continue.</span>
            </div>
        </div>
    );
}
