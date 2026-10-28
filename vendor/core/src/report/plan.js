// Stakeholder-first planning: given a report type and a stakeholder, the section order is decided by the
// stakeholder's priority metrics, nothing else. Pure; the registries are passed in.

export function planReport(reportTypes, stakeholders, reportTypeId, stakeholderId) {
  const type = reportTypes.report_types.find((r) => r.id === reportTypeId);
  if (!type) throw new RangeError(`unknown report type ${reportTypeId}`);
  const who = stakeholders.stakeholders.find((s) => s.id === stakeholderId);
  if (!who) throw new RangeError(`unknown stakeholder ${stakeholderId}`);
  if (!type.stakeholders.includes(stakeholderId)) throw new RangeError(`report type ${reportTypeId} is not offered to ${stakeholderId}`);
  const rank = (m) => { const i = who.priority_metrics.indexOf(m); return i === -1 ? Infinity : i; };
  const byRank = (items, key) => items
    .map((item, index) => ({ item, index, r: key(item) }))
    .sort((p, q) => (p.r === q.r ? p.index - q.index : p.r < q.r ? -1 : 1))
    .map((p) => p.item);
  const sections = byRank(type.sections, (s) => Math.min(...s.metrics.map(rank)))
    .map((s) => ({ id: s.id, title: s.title, metrics: byRank(s.metrics, rank) }));
  return { report_type: type.id, stakeholder: who.id, sections };
}
