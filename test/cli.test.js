import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeGpuCosts,
  createWatchState,
  formatProcessesReport,
  formatTextReport,
  getEmailAlerts,
  markEmailAlertsSent,
  parseArgs,
  parseComputeApps,
  parseNvidiaSmi,
  readGpuProcesses,
  runCli,
  runOnce,
  sendBadgrEmailAlert,
} from '../src/cli.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const idleGpuCsv = '0, NVIDIA A100, 0, 512, 40960, 45\n';

describe('gpu-monitor CLI', () => {
  it('exposes the gpu-monitor bin command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

    expect(packageJson.bin).toMatchObject({
      'gpu-monitor': 'src/cli.js',
    });
  });

  it('parses check defaults and user-supplied watch/email thresholds', () => {
    expect(parseArgs(['check'])).toMatchObject({
      command: 'check',
      hourlyRate: 1,
      idleUtilization: 10,
      idleMemoryPercent: 10,
      idleMinutes: 30,
      interval: 60,
      emailCooldownMinutes: 60,
      json: false,
    });

    expect(parseArgs([
      'watch',
      '--hourly-rate', '2.5',
      '--idle-utilization', '5',
      '--idle-memory-percent', '20',
      '--idle-minutes', '30',
      '--interval', '300',
      '--email', 'you@example.com',
      '--badgr-key', 'badgr_test',
      '--email-cooldown-minutes', '90',
      '--json',
    ])).toMatchObject({
      command: 'watch',
      hourlyRate: 2.5,
      idleUtilization: 5,
      idleMemoryPercent: 20,
      idleMinutes: 30,
      interval: 300,
      email: 'you@example.com',
      badgrKey: 'badgr_test',
      emailCooldownMinutes: 90,
      json: true,
    });
  });

  it('parses the processes command', () => {
    expect(parseArgs(['processes'])).toMatchObject({ command: 'processes' });
    expect(parseArgs(['processes', '--json'])).toMatchObject({ command: 'processes', json: true });
  });

  it('keeps the legacy --watch flag as a watch alias', () => {
    expect(parseArgs(['--watch', '5'])).toMatchObject({ command: 'watch', interval: 5 });
  });

  it('rejects invalid flags, invalid percentages, and email without a Badgr key', () => {
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument: --unknown');
    expect(() => parseArgs(['check', '--hourly-rate'])).toThrow('Missing value for --hourly-rate');
    expect(() => parseArgs(['check', '--idle-utilization', '101'])).toThrow('--idle-utilization must be between 0 and 100');
    expect(() => parseArgs(['watch', '--interval', '0'])).toThrow('--interval must be a positive integer');
    expect(() => parseArgs(['watch', '--email', 'you@example.com'])).toThrow('--email requires --badgr-key or BADGR_API_KEY');
    expect(() => parseArgs(['check', '--email', 'you@example.com', '--badgr-key', 'k'])).toThrow('--email is only supported with the watch command');
  });

  it('parses nvidia-smi CSV rows into GPU samples', () => {
    const gpus = parseNvidiaSmi(`${idleGpuCsv}1, NVIDIA L40S, 85, 16000, 46080, 240\n`);

    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA A100',
      utilizationGpu: 0,
      memoryUsedMb: 512,
      memoryTotalMb: 40960,
      powerDrawWatts: 45,
    });
    expect(gpus[0].memoryUsedPercent).toBeCloseTo(1.25);
  });

  it('tracks idle duration and estimates waste only after idle-minutes threshold', () => {
    const flags = parseArgs(['watch', '--hourly-rate', '2.5', '--idle-minutes', '30']);
    const state = createWatchState();
    const gpus = [
      { index: 0, name: 'NVIDIA A100', utilizationGpu: 0, memoryUsedMb: 512, memoryTotalMb: 40960, memoryUsedPercent: 1.25, powerDrawWatts: 45 },
      { index: 1, name: 'NVIDIA L40S', utilizationGpu: 75, memoryUsedMb: 16000, memoryTotalMb: 46080, memoryUsedPercent: 34.7, powerDrawWatts: 240 },
    ];

    const first = analyzeGpuCosts(gpus, flags, state, 0);
    expect(first.idleCount).toBe(1);
    expect(first.alertReadyCount).toBe(0);
    expect(first.totalWasteUsd).toBe(0);
    expect(first.gpus[0].idleDurationMinutes).toBe(0);

    const second = analyzeGpuCosts(gpus, flags, state, 30 * 60 * 1000);
    expect(second.alertReadyCount).toBe(1);
    expect(second.totalWasteUsd).toBe(1.25);
    expect(second.gpus[0].status).toBe('idle');
    expect(second.gpus[1].status).toBe('active');
  });

  it('flags stale memory when utilization is low but VRAM is high', () => {
    const flags = parseArgs(['check', '--idle-utilization', '10', '--idle-memory-percent', '10']);
    const state = createWatchState();
    // GPU 0: util low, memory high → stale memory (not idle, not active-computing)
    // GPU 1: both low → idle
    // GPU 2: both high → active
    const gpus = [
      { index: 0, name: 'A100', utilizationGpu: 2, memoryUsedMb: 8192, memoryTotalMb: 40960, memoryUsedPercent: 20, powerDrawWatts: 50 },
      { index: 1, name: 'L40S', utilizationGpu: 0, memoryUsedMb: 512, memoryTotalMb: 46080, memoryUsedPercent: 1.1, powerDrawWatts: 45 },
      { index: 2, name: 'H100', utilizationGpu: 90, memoryUsedMb: 40000, memoryTotalMb: 80000, memoryUsedPercent: 50, powerDrawWatts: 700 },
    ];

    const report = analyzeGpuCosts(gpus, flags, state, 0);
    expect(report.gpus[0].staleMemory).toBe(true);
    expect(report.gpus[0].idle).toBe(false);
    expect(report.gpus[0].status).toBe('active');
    expect(report.gpus[1].staleMemory).toBe(false);
    expect(report.gpus[1].idle).toBe(true);
    expect(report.gpus[2].staleMemory).toBe(false);
    expect(report.staleMemoryCount).toBe(1);
  });

  it('includes stale memory warning in text report', () => {
    const flags = parseArgs(['check', '--idle-utilization', '10', '--idle-memory-percent', '10']);
    const state = createWatchState();
    const gpus = [
      { index: 0, name: 'A100', utilizationGpu: 2, memoryUsedMb: 8192, memoryTotalMb: 40960, memoryUsedPercent: 20, powerDrawWatts: 50 },
    ];
    const report = analyzeGpuCosts(gpus, flags, state, 0);
    const text = formatTextReport(report);
    expect(text).toContain('stale memory');
    expect(text).toContain('a process may be holding memory');
  });

  it('formats required state fields in text reports', () => {
    const flags = parseArgs(['watch', '--hourly-rate', '1.25', '--idle-minutes', '30']);
    const state = createWatchState();
    analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 0);
    const report = analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 30 * 60 * 1000);

    const text = formatTextReport(report);
    expect(text).toContain('GPU cost watcher');
    expect(text).toContain('GPU 0 NVIDIA A100: idle');
    expect(text).toContain('utilization: 0%');
    expect(text).toContain('memory: 512/40960 MB');
    expect(text).toContain('idle duration: 30.0m');
    expect(text).toContain('Hourly rate: $1.25/hr');
    expect(text).toContain('Estimated waste: $0.63');
    expect(text).toContain('Next check:');
  });

  it('runs nvidia-smi through an injectable exec implementation', async () => {
    const execImpl = async (cmd, args) => {
      expect(cmd).toBe('nvidia-smi');
      expect(args.join(' ')).toContain('--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw');
      return { stdout: idleGpuCsv };
    };

    const report = await runOnce(parseArgs(['check', '--hourly-rate', '3']), createWatchState(), execImpl, 0);
    expect(report.idleCount).toBe(1);
    expect(report.totalWasteUsd).toBe(0);
  });

  it('prints JSON from the check command', async () => {
    const chunks = [];
    const code = await runCli(['check', '--json'], {
      execImpl: async () => ({ stdout: idleGpuCsv }),
      write: (text) => { chunks.push(text); },
      writeError: () => {},
      nowImpl: () => 0,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.mode).toBe('check');
    expect(parsed.idleCount).toBe(1);
    expect(parsed.gpus[0].status).toBe('idle');
  });

  it('runs once immediately and schedules repeated checks in watch mode', async () => {
    const chunks = [];
    let scheduledCallback;
    let scheduledDelay;
    let calls = 0;
    let now = 0;
    const code = await runCli(['watch', '--interval', '5', '--json'], {
      execImpl: async () => {
        calls += 1;
        return { stdout: `${calls - 1}, NVIDIA A100, 0, 512, 40960, 45\n` };
      },
      setIntervalImpl: (callback, delay) => {
        scheduledCallback = callback;
        scheduledDelay = delay;
        return 123;
      },
      write: (text) => { chunks.push(text); },
      writeError: () => {},
      nowImpl: () => now,
    });

    expect(code).toBe(0);
    expect(scheduledDelay).toBe(5000);
    expect(calls).toBe(1);

    now = 5_000;
    await scheduledCallback();
    expect(calls).toBe(2);
    const reports = chunks.map((chunk) => JSON.parse(chunk));
    expect(reports).toHaveLength(2);
    expect(reports[0].gpus[0].index).toBe(0);
    expect(reports[1].gpus[0].index).toBe(1);
  });

  it('sends Badgr email only after idle threshold and cooldown have passed', async () => {
    const chunks = [];
    const fetchCalls = [];
    let scheduledCallback;
    let now = 0;
    const code = await runCli([
      'watch',
      '--hourly-rate', '2.5',
      '--idle-minutes', '30',
      '--interval', '60',
      '--email', 'you@example.com',
      '--badgr-key', 'badgr_test',
      '--email-cooldown-minutes', '60',
      '--json',
    ], {
      execImpl: async () => ({ stdout: idleGpuCsv }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return { ok: true, status: 200, text: async () => 'ok' };
      },
      setIntervalImpl: (callback) => { scheduledCallback = callback; return 123; },
      write: (text) => { chunks.push(text); },
      writeError: () => {},
      nowImpl: () => now,
    });

    expect(code).toBe(0);
    expect(fetchCalls).toHaveLength(0);

    now = 30 * 60 * 1000;
    await scheduledCallback();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://aibadgr.com/v1/alerts/gpu-idle-email');
    expect(fetchCalls[0].options.headers.Authorization).toBe('Bearer badgr_test');
    expect(JSON.parse(fetchCalls[0].options.body)).toMatchObject({
      email: 'you@example.com',
      idle_minutes: 30,
      hourly_rate_usd: 2.5,
      estimated_waste_usd: 1.25,
    });

    now = 31 * 60 * 1000;
    await scheduledCallback();
    expect(fetchCalls).toHaveLength(1);

    now = 91 * 60 * 1000;
    await scheduledCallback();
    expect(fetchCalls).toHaveLength(2);
    expect(chunks.map((chunk) => JSON.parse(chunk).emailConfigured)).toContain(true);
  });

  it('does not return duplicate email alerts during cooldown helper calls', () => {
    const flags = parseArgs(['watch', '--email', 'you@example.com', '--badgr-key', 'badgr_test', '--email-cooldown-minutes', '60']);
    const state = createWatchState();
    const report = analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 0);
    const readyReport = analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 30 * 60 * 1000);

    expect(getEmailAlerts(report, flags, state, 0)).toHaveLength(0);
    const alerts = getEmailAlerts(readyReport, flags, state, 30 * 60 * 1000);
    expect(alerts).toHaveLength(1);
    markEmailAlertsSent(alerts, state, 30 * 60 * 1000);
    expect(getEmailAlerts(readyReport, flags, state, 31 * 60 * 1000)).toHaveLength(0);
  });

  it('posts a Badgr email alert payload with idle GPU details', async () => {
    const flags = parseArgs(['watch', '--email', 'you@example.com', '--badgr-key', 'badgr_test', '--badgr-api-url', 'https://example.test']);
    const state = createWatchState();
    analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 0);
    const report = analyzeGpuCosts(parseNvidiaSmi(idleGpuCsv), flags, state, 30 * 60 * 1000);
    const calls = [];

    const result = await sendBadgrEmailAlert(report, report.gpus, flags, async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => 'ok' };
    });

    expect(result).toEqual({ sent: true, count: 1 });
    expect(calls[0].url).toBe('https://example.test/v1/alerts/gpu-idle-email');
    expect(JSON.parse(calls[0].options.body).gpus[0]).toMatchObject({
      name: 'NVIDIA A100',
      idle_duration_minutes: 30,
    });
  });

  it('returns non-zero with help text for invalid CLI args', async () => {
    let stderr = '';
    const code = await runCli(['--bad-flag'], {
      execImpl: async () => ({ stdout: '' }),
      write: () => {},
      writeError: (text) => { stderr += text; },
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Unknown argument: --bad-flag');
    expect(stderr).toContain('npx gpu-monitor check');
  });

  it('returns non-zero when nvidia-smi is unavailable', async () => {
    let stderr = '';
    const code = await runCli(['check'], {
      execImpl: async () => { throw new Error('command not found'); },
      write: () => {},
      writeError: (text) => { stderr += text; },
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Could not run nvidia-smi');
    expect(stderr).toContain('command not found');
  });

  // --- processes command ---

  it('parses nvidia-smi compute-apps CSV into process records', () => {
    const rows = parseComputeApps('12345, python3, 4096\n67890, jupyter, 512\n', 0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ gpuIndex: 0, pid: 12345, processName: 'python3', usedMemoryMb: 4096 });
    expect(rows[1]).toMatchObject({ gpuIndex: 0, pid: 67890, processName: 'jupyter', usedMemoryMb: 512 });
  });

  it('ignores blank lines and non-integer PIDs in compute-apps output', () => {
    expect(parseComputeApps('', 0)).toHaveLength(0);
    expect(parseComputeApps('\n\n', 0)).toHaveLength(0);
    expect(parseComputeApps('N/A, python3, 0\n', 0)).toHaveLength(0);
  });

  it('readGpuProcesses returns per-GPU process lists', async () => {
    let callCount = 0;
    const execImpl = async (_cmd, args) => {
      callCount += 1;
      const joined = args.join(' ');
      if (joined.includes('--query-gpu')) return { stdout: '0, NVIDIA A100, 5, 8192, 40960, 50\n' };
      if (joined.includes('--query-compute-apps') && joined.includes('--id=0')) {
        return { stdout: '12345, python3, 8000\n' };
      }
      return { stdout: '' };
    };

    const result = await readGpuProcesses(execImpl);
    expect(result).toHaveLength(1);
    expect(result[0].gpu.index).toBe(0);
    expect(result[0].processes).toHaveLength(1);
    expect(result[0].processes[0]).toMatchObject({ pid: 12345, processName: 'python3', usedMemoryMb: 8000 });
  });

  it('readGpuProcesses returns empty process list when compute-apps query fails', async () => {
    const execImpl = async (_cmd, args) => {
      if (args.join(' ').includes('--query-gpu')) return { stdout: '0, NVIDIA A100, 0, 512, 40960, 45\n' };
      throw new Error('unsupported query');
    };

    const result = await readGpuProcesses(execImpl);
    expect(result).toHaveLength(1);
    expect(result[0].processes).toHaveLength(0);
  });

  it('formats a processes report with PID list and memory totals', () => {
    const gpuProcesses = [
      {
        gpu: { index: 0, name: 'NVIDIA A100', utilizationGpu: 2, memoryUsedMb: 8192, memoryTotalMb: 40960, memoryUsedPercent: 20, powerDrawWatts: 50 },
        processes: [
          { gpuIndex: 0, pid: 12345, processName: 'python3', usedMemoryMb: 6000 },
          { gpuIndex: 0, pid: 67890, processName: 'jupyter', usedMemoryMb: 2000 },
        ],
      },
      {
        gpu: { index: 1, name: 'NVIDIA L40S', utilizationGpu: 90, memoryUsedMb: 20000, memoryTotalMb: 46080, memoryUsedPercent: 43.4, powerDrawWatts: 300 },
        processes: [],
      },
    ];

    const text = formatProcessesReport(gpuProcesses);
    expect(text).toContain('GPU processes');
    expect(text).toContain('GPU 0 NVIDIA A100');
    expect(text).toContain('PID 12345');
    expect(text).toContain('python3');
    expect(text).toContain('6000 MB');
    expect(text).toContain('held: 8000 MB');
    expect(text).toContain('GPU 1 NVIDIA L40S');
    expect(text).toContain('no compute processes');
  });

  it('shows stale memory warning in processes report when utilization is low but VRAM is high', () => {
    const gpuProcesses = [
      {
        gpu: { index: 0, name: 'A100', utilizationGpu: 2, memoryUsedMb: 8192, memoryTotalMb: 40960, memoryUsedPercent: 20, powerDrawWatts: 50 },
        processes: [{ gpuIndex: 0, pid: 12345, processName: 'python3', usedMemoryMb: 8000 }],
      },
    ];
    const text = formatProcessesReport(gpuProcesses);
    expect(text).toContain('stale memory');
  });

  it('runs the processes command and outputs a text report', async () => {
    let output = '';
    let callCount = 0;
    const code = await runCli(['processes'], {
      execImpl: async (_cmd, args) => {
        callCount += 1;
        const joined = args.join(' ');
        if (joined.includes('--query-gpu')) return { stdout: '0, NVIDIA A100, 5, 8192, 40960, 50\n' };
        if (joined.includes('--query-compute-apps')) return { stdout: '12345, python3, 8000\n' };
        return { stdout: '' };
      },
      write: (text) => { output += text; },
      writeError: () => {},
    });

    expect(code).toBe(0);
    expect(output).toContain('GPU processes');
    expect(output).toContain('GPU 0 NVIDIA A100');
    expect(output).toContain('PID 12345');
    expect(output).toContain('python3');
  });

  it('runs the processes command with --json flag', async () => {
    let output = '';
    const code = await runCli(['processes', '--json'], {
      execImpl: async (_cmd, args) => {
        if (args.join(' ').includes('--query-gpu')) return { stdout: '0, NVIDIA A100, 5, 8192, 40960, 50\n' };
        return { stdout: '12345, python3, 8000\n' };
      },
      write: (text) => { output += text; },
      writeError: () => {},
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].gpu.index).toBe(0);
    expect(parsed[0].processes[0].pid).toBe(12345);
  });
});
