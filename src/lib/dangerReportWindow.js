// Calendar days in Japan, independent of the server's timezone.
export function dangerReportHomeWindow(now = new Date()) {
  const offset = 9 * 60 * 60 * 1000;
  const japan = new Date(now.getTime() + offset);
  const today = Date.UTC(japan.getUTCFullYear(), japan.getUTCMonth(), japan.getUTCDate()) - offset;
  return { $gte: new Date(today - 24 * 60 * 60 * 1000), $lte: now };
}
