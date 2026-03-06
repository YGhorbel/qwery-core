import type { ReasoningStep } from './cot-reasoner';

export function formatReasoningSteps(steps: ReasoningStep[]): string {
  return steps
    .map((step, index) => {
      const stepNumber = index + 1;
      const stepTitle = formatStepTitle(step.type);
      const stepData = formatStepData(step.data, step.type);

      return `## Step ${stepNumber}: ${stepTitle}\n\n${step.description}\n\n${stepData}`;
    })
    .join('\n\n');
}

function formatStepTitle(type: ReasoningStep['type']): string {
  const titles: Record<ReasoningStep['type'], string> = {
    concept_identification: 'Concept Identification',
    path_finding: 'Relationship Path Finding',
    property_resolution: 'Property Resolution',
    join_planning: 'Join Planning',
    optimization: 'Query Optimization',
  };
  return titles[type] || type;
}

function formatStepData(data: unknown, type: ReasoningStep['type']): string {
  if (!data || typeof data !== 'object') {
    return '';
  }

  const dataObj = data as Record<string, unknown>;

  switch (type) {
    case 'concept_identification': {
      const concepts = dataObj.concepts as string[] | undefined;
      if (concepts && Array.isArray(concepts)) {
        return `**Concepts identified:**\n${concepts.map((c) => `- ${c}`).join('\n')}`;
      }
      return '';
    }

    case 'path_finding': {
      const paths = dataObj.paths as Array<{ from: string; to: string; type: string }> | undefined;
      if (paths && Array.isArray(paths)) {
        return `**Relationship paths:**\n${paths.map((p) => `- ${p.from} → ${p.to} (${p.type})`).join('\n')}`;
      }
      return '';
    }

    case 'property_resolution': {
      const properties = dataObj.properties as string[] | undefined;
      if (properties && Array.isArray(properties)) {
        return `**Properties resolved:**\n${properties.map((p) => `- ${p}`).join('\n')}`;
      }
      return '';
    }

    case 'join_planning': {
      const joins = dataObj.joins as Array<{ from: string; to: string; type: string }> | undefined;
      if (joins && Array.isArray(joins)) {
        return `**Joins planned:**\n${joins.map((j) => `- ${j.from} JOIN ${j.to} (${j.type})`).join('\n')}`;
      }
      return '';
    }

    case 'optimization': {
      const optimizations = dataObj.optimizations as Record<string, unknown> | undefined;
      if (optimizations) {
        return `**Optimizations applied:**\n${JSON.stringify(optimizations, null, 2)}`;
      }
      return '';
    }

    default:
      return '';
  }
}

export function formatReasoningChain(reasoningChain: {
  steps: ReasoningStep[];
  finalPlan: unknown;
}): string {
  const stepsFormatted = formatReasoningSteps(reasoningChain.steps);
  const planSummary = formatPlanSummary(reasoningChain.finalPlan);

  return `${stepsFormatted}\n\n## Final Semantic Plan\n\n${planSummary}`;
}

function formatPlanSummary(plan: unknown): string {
  if (!plan || typeof plan !== 'object') {
    return 'No plan details available';
  }

  const planObj = plan as Record<string, unknown>;
  const parts: string[] = [];

  if (planObj.concepts && Array.isArray(planObj.concepts)) {
    parts.push(`**Concepts:** ${(planObj.concepts as string[]).join(', ')}`);
  }

  if (planObj.properties && Array.isArray(planObj.properties)) {
    parts.push(`**Properties:** ${(planObj.properties as string[]).join(', ')}`);
  }

  if (planObj.relationships && Array.isArray(planObj.relationships)) {
    const rels = planObj.relationships as Array<{ from: string; to: string; type: string }>;
    parts.push(`**Relationships:** ${rels.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
  }

  return parts.join('\n\n') || 'Plan details not available';
}
