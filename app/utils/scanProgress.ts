// task_run.phase of a discovery scan = `stage|nmap task|percent` (written by runScan).
// Anything else (a task-runner phase, an empty value) → null: show the plain spinner.
export interface ScanPhase { stage: 'sweep' | 'services', task: string, percent: number }

export function parseScanPhase(phase: string | null | undefined): ScanPhase | null {
  const [stage, task, percent] = (phase ?? '').split('|')
  if ((stage !== 'sweep' && stage !== 'services') || percent === undefined || Number.isNaN(Number(percent)))
    return null
  return { stage, task: task ?? '', percent: Number(percent) }
}

// "Finding hosts · Ping Scan 43%" — the stage label is ours (translated); the nmap task name
// is a technical value and stays as nmap prints it (its % restarts at 0 for each task).
export function scanProgressText(phase: string | null | undefined, t: (key: string) => string): string {
  const p = parseScanPhase(phase)
  if (!p)
    return ''
  const stage = t(p.stage === 'sweep' ? 'discovery.progressSweep' : 'discovery.progressServices')
  return p.task ? `${stage} · ${p.task} ${p.percent}%` : stage
}
