export const AUTOMATION_CONDITIONS = Object.freeze([
  'If no reply → continue', 'If opened → continue', 'If clicked → continue',
  'If replied → stop', 'If not opened → continue'
]);

export function evaluateAutomationCondition(condition, { replied = false, opened = false, clicked = false } = {}) {
  const normalized = String(condition || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'if no reply → continue' || normalized === 'if no reply -> continue') return { known: true, continue: !replied, reason: replied ? 'replied' : null };
  if (normalized === 'if replied → stop' || normalized === 'if replied -> stop') return { known: true, continue: !replied, reason: replied ? 'replied' : null };
  if (normalized === 'if opened → continue' || normalized === 'if opened -> continue') return { known: true, continue: opened, reason: opened ? null : 'not_opened' };
  if (normalized === 'if not opened → continue' || normalized === 'if not opened -> continue') return { known: true, continue: !opened, reason: !opened ? null : 'opened' };
  if (normalized === 'if clicked → continue' || normalized === 'if clicked -> continue') return { known: true, continue: clicked, reason: clicked ? null : 'not_clicked' };
  return { known: false, continue: false, reason: 'unsupported_condition' };
}
