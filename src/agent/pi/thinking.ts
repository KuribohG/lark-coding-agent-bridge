/** Map bridge reasoning efforts to Pi thinking levels. */
export function piThinkingLevel(effort: string): string {
  if (effort === 'max') return 'xhigh';
  if (effort === 'none') return 'off';
  return effort;
}
