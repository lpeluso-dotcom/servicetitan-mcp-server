export interface ReportParam {
  name: string;
  value: unknown;
}

export function reportRunIdentity(args: {
  categoryId?: string | number;
  reportId?: string | number;
  parameters?: ReportParam[];
  page: unknown;
  pageSize: unknown;
}): string {
  const params = [...(args.parameters ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    c: String(args.categoryId),
    r: String(args.reportId),
    p: args.page,
    s: args.pageSize,
    params,
  });
}
