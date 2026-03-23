export function getDefaultReviewPort(): number {
  const parsed = Number.parseInt(process.env.RELAY_PORT ?? '4480', 10);
  return Number.isNaN(parsed) ? 4480 : parsed;
}

export function buildReviewUrl(params: {
  projectName: string;
  workspaceName: string;
  port?: number;
}): string {
  const url = new URL(`http://localhost:${params.port ?? getDefaultReviewPort()}`);
  url.searchParams.set('view', 'review');
  url.searchParams.set('workspace', params.workspaceName);
  url.searchParams.set('project', params.projectName);
  return url.toString();
}
