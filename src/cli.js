#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_BADGR_API_URL = 'https://aibadgr.com/v1';
export const DEFAULT_HOURLY_RATE_USD = 1;
export const DEFAULT_IDLE_UTILIZATION = 10;
export const DEFAULT_IDLE_MEMORY_PERCENT = 10;
export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_WATCH_INTERVAL_SECONDS = 60;
export const DEFAULT_EMAIL_COOLDOWN_MINUTES = 60;

const COMMANDS = new Set(['check', 'watch', 'processes']);
const VALUE_FLAGS = new Set([
  '--hourly-rate',
  '--idle-utilization',
  '--idle-memory-percent',
  '--idle-minutes',
  '--interval',
  '--email',
  '--badgr-key',
  '--badgr-api-url',
  '--email-cooldown-minutes',
]);

export function parseArgs(argv) {
  const flags = {
    command: 'check',
    hourlyRate: DEFAULT_HOURLY_RATE_USD,
    idleUtilization: DEFAULT_IDLE_UTILIZATION,
    idleMemoryPercent: DEFAULT_IDLE_MEMORY_PERCENT,
    idleMinutes: DEFAULT_IDLE_MINUTES,
    interval: DEFAULT_WATCH_INTERVAL_SECONDS,
    emailCooldownMinutes: DEFAULT_EMAIL_COOLDOWN_MINUTES,
    badgrApiUrl: process.env.BADGR_API_URL || process.env.AIBADGR_API_URL || DEFAULT_BADGR_API_URL,
    badgrKey: process.env.BADGR_API_KEY || process.env.AIBADGR_API_KEY || '',
    email: '',
    json: false,
    help: false,
  };

  const args = [...argv];
  if (args[0] && COMMANDS.has(args[0])) {
    flags.command = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--watch') {
      flags.command = 'watch';
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
        i += 1;
        flags.interval = parsePositiveInteger(args[i], arg);
      }
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;

    if (arg === '--hourly-rate') flags.hourlyRate = parseNonNegativeNumber(value, arg);
    if (arg === '--idle-utilization') flags.idleUtilization = parsePercent(value, arg);
    if (arg === '--idle-memory-percent') flags.idleMemoryPercent = parsePercent(value, arg);
    if (arg === '--idle-minutes') flags.idleMinutes = parseNonNegativeNumber(value, arg);
    if (arg === '--interval') flags.interval = parsePositiveInteger(value, arg);
    if (arg === '--email-cooldown-minutes') flags.emailCooldownMinutes = parsePositiveInteger(value, arg);
    if (arg === '--email') flags.email = parseEmail(value);
    if (arg === '--badgr-key') flags.badgrKey = String(value).trim();
    if (arg === '--badgr-api-url') flags.badgrApiUrl = normalizeBaseUrl(value);
  }

  flags.badgrApiUrl = normalizeBaseUrl(flags.badgrApiUrl);

  if (flags.email && flags.command !== 'watch') {
    throw new Error('--email is only supported with the watch command');
  }
  if (flags.email && !flags.badgrKey) {
    throw new Error('--email requires --badgr-key or BADGR_API_KEY');
  }

  return flags;
}

function parseNonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parsePercent(value, flag) {
  const parsed = parseNonNegativeNumber(value, flag);
  if (parsed > 100) {
    throw new Error(`${flag} must be between 0 and 100`);
  }
  return parsed;
}

function parseEmail(value) {
  const email = String(value).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('--email must be a valid email address');
  }
  return email;
}

function normalizeBaseUrl(url) {
  const trimmed = String(url || DEFAULT_BADGR_API_URL).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

// Candidate paths in order: PATH lookup, then NVIDIA container toolkit locations.
// RunPod, Vast.ai, Lambda, and Modal GPU containers often mount the driver at
// /usr/local/nvidia/bin but don't add it to PATH in all base images.
const NVIDIA_SMI_CANDIDATES = [
  'nvidia-smi',
  '/usr/bin/nvidia-smi',
  '/usr/local/nvidia/bin/nvidia-smi',
  '/usr/local/bin/nvidia-smi',
];

async function execNvidiaSmi(args, execImpl) {
  let lastError;
  for (const bin of NVIDIA_SMI_CANDIDATES) {
    try {
      return await execImpl(bin, args);
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || '');
      // Only keep trying if the binary itself wasn't found
      if (!msg.includes('ENOENT') && !msg.includes('not found') && !msg.includes('No such file')) {
        throw err;
      }
    }
  }
  throw lastError;
}

export async function readGpuSamples(execImpl = execFileAsync) {
  const query = 'index,name,utilization.gpu,memory.used,memory.total,power.draw';
  const { stdout } = await execNvidiaSmi([
    `--query-gpu=${query}`,
    '--format=csv,noheader,nounits',
  ], execImpl);
  return parseNvidiaSmi(stdout);
}

export function parseNvidiaSmi(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, utilizationGpu, memoryUsed, memoryTotal, powerDraw] = line.split(',').map((part) => part.trim());
      const used = Number(memoryUsed);
      const total = Number(memoryTotal);
      const power = Number(powerDraw);
      return {
        index: Number(index),
        name,
        utilizationGpu: Number(utilizationGpu),
        memoryUsedMb: used,
        memoryTotalMb: total,
        memoryUsedPercent: total > 0 ? (used / total) * 100 : 0,
        powerDrawWatts: Number.isFinite(power) ? power : null,
      };
    })
    .filter((gpu) => Number.isInteger(gpu.index) && gpu.name && Number.isFinite(gpu.utilizationGpu));
}

export function parseComputeApps(stdout, gpuIndex) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, processName, usedMemory] = line.split(',').map((p) => p.trim());
      const usedMb = Number(usedMemory);
      return {
        gpuIndex,
        pid: Number(pid),
        processName: String(processName || ''),
        usedMemoryMb: Number.isFinite(usedMb) ? usedMb : 0,
      };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

export async function readGpuProcesses(execImpl = execFileAsync) {
  const gpus = await readGpuSamples(execImpl);
  const result = [];
  for (const gpu of gpus) {
    let processes = [];
    try {
      const { stdout } = await execNvidiaSmi([
        `--id=${gpu.index}`,
        '--query-compute-apps=pid,process_name,used_gpu_memory',
        '--format=csv,noheader,nounits',
      ], execImpl);
      processes = parseComputeApps(stdout, gpu.index);
    } catch (_) {
      // process query failed — show empty list rather than crashing
    }
    result.push({ gpu, processes });
  }
  return result;
}

export function createWatchState() {
  return {
    idleSinceByGpu: new Map(),
    lastEmailSentByGpu: new Map(),
  };
}

export function analyzeGpuCosts(gpus, flags, state = createWatchState(), nowMs = Date.now()) {
  const hourlyRate = flags.hourlyRate ?? DEFAULT_HOURLY_RATE_USD;
  const idleMinutes = flags.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const thresholdMs = idleMinutes * 60 * 1000;
  const estimatedWastePerGpu = hourlyRate * (idleMinutes / 60);
  const seenKeys = new Set();

  const results = gpus.map((gpu) => {
    const key = String(gpu.index);
    seenKeys.add(key);
    const utilizationIdle = gpu.utilizationGpu <= flags.idleUtilization;
    const memoryIdle = gpu.memoryUsedPercent <= flags.idleMemoryPercent;
    const idle = utilizationIdle && memoryIdle;
    const staleMemory = utilizationIdle && !memoryIdle;

    if (idle && !state.idleSinceByGpu.has(key)) {
      state.idleSinceByGpu.set(key, nowMs);
    }
    if (!idle) {
      state.idleSinceByGpu.delete(key);
    }

    const idleSinceMs = idle ? state.idleSinceByGpu.get(key) : null;
    const idleDurationMs = idleSinceMs === null || idleSinceMs === undefined ? 0 : Math.max(0, nowMs - idleSinceMs);
    const idleDurationMinutes = idleDurationMs / 60_000;
    const alertReady = idle && idleDurationMs >= thresholdMs;

    return {
      ...gpu,
      idle,
      staleMemory,
      alertReady,
      status: idle ? 'idle' : 'active',
      idleSince: idleSinceMs === null || idleSinceMs === undefined ? null : new Date(idleSinceMs).toISOString(),
      idleDurationMs,
      idleDurationMinutes,
      estimatedWasteUsd: alertReady ? estimatedWastePerGpu : 0,
      reasons: [
        utilizationIdle ? `utilization <= ${flags.idleUtilization}%` : `utilization > ${flags.idleUtilization}%`,
        memoryIdle ? `memory <= ${flags.idleMemoryPercent}%` : `memory > ${flags.idleMemoryPercent}%`,
      ],
    };
  });

  for (const key of state.idleSinceByGpu.keys()) {
    if (!seenKeys.has(key)) state.idleSinceByGpu.delete(key);
  }

  const idleGpus = results.filter((gpu) => gpu.idle);
  const alertReadyGpus = results.filter((gpu) => gpu.alertReady);
  const staleMemoryGpus = results.filter((gpu) => gpu.staleMemory);
  const totalWasteUsd = alertReadyGpus.reduce((sum, gpu) => sum + gpu.estimatedWasteUsd, 0);
  return {
    checkedAt: new Date(nowMs).toISOString(),
    mode: flags.command || 'check',
    gpuCount: results.length,
    idleCount: idleGpus.length,
    alertReadyCount: alertReadyGpus.length,
    staleMemoryCount: staleMemoryGpus.length,
    activeCount: results.length - idleGpus.length,
    hourlyRateUsd: hourlyRate,
    idleMinutes,
    idleUtilization: flags.idleUtilization,
    idleMemoryPercent: flags.idleMemoryPercent,
    intervalSeconds: flags.interval ?? DEFAULT_WATCH_INTERVAL_SECONDS,
    emailConfigured: Boolean(flags.email),
    totalWasteUsd,
    nextCheckAt: flags.command === 'watch' ? new Date(nowMs + (flags.interval ?? DEFAULT_WATCH_INTERVAL_SECONDS) * 1000).toISOString() : null,
    gpus: results,
  };
}

export function getEmailAlerts(report, flags, state, nowMs = Date.now()) {
  if (!flags.email) return [];
  const cooldownMs = (flags.emailCooldownMinutes ?? DEFAULT_EMAIL_COOLDOWN_MINUTES) * 60 * 1000;
  return report.gpus.filter((gpu) => {
    if (!gpu.alertReady) return false;
    const key = String(gpu.index);
    if (!state.lastEmailSentByGpu.has(key)) return true;
    const lastSentAt = state.lastEmailSentByGpu.get(key);
    return nowMs - lastSentAt >= cooldownMs;
  });
}

export function markEmailAlertsSent(gpus, state, nowMs = Date.now()) {
  for (const gpu of gpus) {
    state.lastEmailSentByGpu.set(String(gpu.index), nowMs);
  }
}

export async function sendBadgrEmailAlert(report, gpus, flags, fetchImpl = globalThis.fetch) {
  if (!gpus.length) return { sent: false, count: 0 };
  if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');

  const response = await fetchImpl(`${flags.badgrApiUrl}/alerts/gpu-idle-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${flags.badgrKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: flags.email,
      idle_minutes: flags.idleMinutes,
      hourly_rate_usd: flags.hourlyRate,
      estimated_waste_usd: report.totalWasteUsd,
      checked_at: report.checkedAt,
      gpus: gpus.map((gpu) => ({
        index: gpu.index,
        name: gpu.name,
        utilization_gpu: gpu.utilizationGpu,
        memory_used_mb: gpu.memoryUsedMb,
        memory_total_mb: gpu.memoryTotalMb,
        memory_used_percent: gpu.memoryUsedPercent,
        idle_duration_minutes: gpu.idleDurationMinutes,
        estimated_waste_usd: gpu.estimatedWasteUsd,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Badgr email alert failed (HTTP ${response.status}): ${detail || response.statusText}`);
  }
  return { sent: true, count: gpus.length };
}

function formatDuration(minutes) {
  if (minutes < 1) return `${Math.floor(minutes * 60)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function formatTextReport(report) {
  if (report.gpuCount === 0) {
    return [
      'GPU cost check',
      '',
      'No NVIDIA GPUs were reported by nvidia-smi.',
      'If this machine should have GPUs, check driver visibility first.',
      `Hourly rate: $${report.hourlyRateUsd.toFixed(2)}/hr`,
      `Next check: ${report.nextCheckAt || 'not scheduled'}`,
      '',
    ].join('\n');
  }

  const lines = [
    report.mode === 'watch' ? 'GPU cost watcher' : 'GPU cost check',
    '',
    `Checked at: ${report.checkedAt}`,
    `GPUs checked: ${report.gpuCount}`,
    `Idle GPUs: ${report.idleCount}`,
    `Alert-ready GPUs: ${report.alertReadyCount}`,
    `Hourly rate: $${report.hourlyRateUsd.toFixed(2)}/hr`,
    `Idle threshold: ${report.idleMinutes} min (utilization <= ${report.idleUtilization}%, memory <= ${report.idleMemoryPercent}%)`,
    `Estimated waste: $${report.totalWasteUsd.toFixed(2)}`,
    `Next check: ${report.nextCheckAt || 'not scheduled'}`,
    '',
  ];

  for (const gpu of report.gpus) {
    lines.push(
      `${gpu.status === 'idle' ? '⚠' : '✓'} GPU ${gpu.index} ${gpu.name}: ${gpu.status}`,
      `  utilization: ${gpu.utilizationGpu}%`,
      `  memory: ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB (${gpu.memoryUsedPercent.toFixed(1)}%)`,
      `  idle duration: ${formatDuration(gpu.idleDurationMinutes)}`,
    );
    if (gpu.powerDrawWatts !== null) {
      lines.push(`  power draw: ${gpu.powerDrawWatts} W`);
    }
    if (gpu.alertReady) {
      lines.push(`  estimated waste: $${gpu.estimatedWasteUsd.toFixed(2)} after ${report.idleMinutes} min idle`);
    }
    if (gpu.staleMemory) {
      lines.push(`  ⚠ stale memory: high VRAM, low utilization — a process may be holding memory`);
    }
  }

  if (report.emailConfigured) {
    lines.push('', 'Email alerts: enabled through Badgr');
  }
  lines.push('', 'Watch your GPU boxes for idle spend. Local checks are free. Email alerts use Badgr.', '');
  return lines.join('\n');
}

export function formatProcessesReport(gpuProcesses) {
  if (gpuProcesses.length === 0) {
    return 'No NVIDIA GPUs found.\n';
  }

  const lines = ['GPU processes', ''];

  for (const { gpu, processes } of gpuProcesses) {
    const memPct = gpu.memoryTotalMb > 0
      ? ` (${((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100).toFixed(1)}%)`
      : '';
    lines.push(`GPU ${gpu.index} ${gpu.name}  ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB${memPct}`);

    if (processes.length === 0) {
      lines.push('  no compute processes');
    } else {
      for (const proc of processes) {
        lines.push(`  PID ${String(proc.pid).padEnd(8)}  ${proc.processName.padEnd(24)}  ${proc.usedMemoryMb} MB`);
      }
      const totalMb = processes.reduce((s, p) => s + p.usedMemoryMb, 0);
      const heldPct = gpu.memoryTotalMb > 0
        ? ` (${((totalMb / gpu.memoryTotalMb) * 100).toFixed(1)}%)`
        : '';
      lines.push(`  held: ${totalMb} MB / ${gpu.memoryTotalMb} MB${heldPct}`);
    }

    if (gpu.utilizationGpu <= DEFAULT_IDLE_UTILIZATION && gpu.memoryUsedPercent > DEFAULT_IDLE_MEMORY_PERCENT) {
      lines.push('  ⚠ stale memory: low utilization but high VRAM — run `gpu-monitor processes` to see PIDs');
    }

    lines.push('');
  }

  return lines.join('\n');
}

export function formatNvidiaSmiUnavailable(error) {
  const message = String(error?.message || error || 'nvidia-smi unavailable');
  return [
    'GPU cost check',
    '',
    'Could not run nvidia-smi on this machine.',
    '',
    'On GPU cloud providers, this usually means one of:',
    '  1. The container image does not include nvidia-utils.',
    '     Fix: use a CUDA image instead of a plain node/python image.',
    '     Example: nvcr.io/nvidia/cuda:12.6-runtime-ubuntu22.04',
    '     Then install Node.js in the same image, or use a pre-built CUDA+Node image.',
    '  2. RunPod / Vast.ai / Lambda / Modal: drivers are mounted but not in PATH.',
    '     The tool tries /usr/local/nvidia/bin/nvidia-smi automatically.',
    '     If that also fails, the container image does not have nvidia-smi.',
    '  3. This machine has no NVIDIA GPU.',
    '',
    `Details: ${message}`,
    '',
  ].join('\n');
}

export function formatHelp() {
  return [
    'gpu-monitor — watch GPU boxes for idle spend',
    '',
    'Usage:',
    '  npx gpu-monitor check [flags]',
    '  npx gpu-monitor watch [flags]',
    '  npx gpu-monitor processes',
    '  gpu-monitor check [flags]',
    '  gpu-monitor watch [flags]',
    '  gpu-monitor processes',
    '',
    'Commands:',
    '  check       One-time local check. No Badgr account required.',
    '  watch       Continuous local watcher. Email alerts require Badgr.',
    '  processes   Show which PIDs are holding VRAM on each GPU.',
    '',
    'Flags:',
    '  --hourly-rate <usd>             Hourly cost per GPU (default: 1)',
    '  --idle-minutes <minutes>        Alert after this much idle time (default: 30)',
    '  --interval <seconds>            Watch interval (default: 60)',
    '  --idle-utilization <pct>        GPU utilization at or below this is idle (default: 10)',
    '  --idle-memory-percent <pct>     Memory use at or below this is idle (default: 10)',
    '  --email <address>               Send idle alerts through Badgr (watch only)',
    '  --badgr-key <key>               Badgr API key for email alerts',
    '  --email-cooldown-minutes <min>  Email cooldown per GPU (default: 60)',
    '  --json                          Print JSON report',
    '  --help                          Show this help',
    '',
  ].join('\n');
}

export async function runOnce(flags, state = createWatchState(), execImpl = execFileAsync, nowMs = Date.now()) {
  const gpus = await readGpuSamples(execImpl);
  return analyzeGpuCosts(gpus, flags, state, nowMs);
}

async function runAndAlert(flags, state, options, nowMs) {
  const report = await runOnce(flags, state, options.execImpl, nowMs);
  const alertGpus = getEmailAlerts(report, flags, state, nowMs);
  if (alertGpus.length > 0) {
    await sendBadgrEmailAlert(report, alertGpus, flags, options.fetchImpl);
    markEmailAlertsSent(alertGpus, state, nowMs);
  }
  return report;
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const write = options.write || ((text) => process.stdout.write(text));
  const writeError = options.writeError || ((text) => process.stderr.write(text));
  const state = options.state || createWatchState();
  const nowImpl = options.nowImpl || Date.now;
  let flags;

  try {
    flags = parseArgs(argv);
  } catch (error) {
    writeError(`${String(error?.message || error)}\n\n${formatHelp()}`);
    return 1;
  }

  if (flags.help) {
    write(formatHelp());
    return 0;
  }

  const optionsWithDefaults = {
    execImpl: options.execImpl || execFileAsync,
    fetchImpl: options.fetchImpl || globalThis.fetch,
  };

  if (flags.command === 'processes') {
    try {
      const gpuProcesses = await readGpuProcesses(optionsWithDefaults.execImpl);
      write(flags.json ? `${JSON.stringify(gpuProcesses, null, 2)}\n` : formatProcessesReport(gpuProcesses));
    } catch (error) {
      if (flags.json) {
        write(`${JSON.stringify({ ok: false, error: 'gpu-monitor failed', detail: String(error?.message || error) }, null, 2)}\n`);
      } else {
        writeError(formatNvidiaSmiUnavailable(error));
      }
      return 1;
    }
    return 0;
  }

  const emitReport = async () => {
    const nowMs = nowImpl();
    const report = await runAndAlert(flags, state, optionsWithDefaults, nowMs);
    write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatTextReport(report));
  };

  try {
    await emitReport();
  } catch (error) {
    if (flags.json) {
      write(`${JSON.stringify({ ok: false, error: 'gpu-monitor failed', detail: String(error?.message || error) }, null, 2)}\n`);
    } else {
      writeError(formatNvidiaSmiUnavailable(error));
    }
    return 1;
  }

  if (flags.command !== 'watch') return 0;

  const timer = options.setIntervalImpl || setInterval;
  timer(async () => {
    try {
      await emitReport();
    } catch (error) {
      if (flags.json) {
        write(`${JSON.stringify({ ok: false, error: 'gpu-monitor failed', detail: String(error?.message || error) }, null, 2)}\n`);
      } else {
        writeError(formatNvidiaSmiUnavailable(error));
      }
    }
  }, flags.interval * 1000);
  return 0;
}

const isDirectRun = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
