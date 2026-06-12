# gpu-monitor

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/gpu-monitor)](https://www.npmjs.com/package/gpu-monitor)

Watch your GPU boxes for idle spend. Local checks are free. Email alerts use Badgr.

`gpu-monitor` is a CLI watcher that runs on the GPU machine — rented GPU pods, cloud GPU instances, local workstation, or any Linux box with NVIDIA drivers — and alerts when a GPU has been idle long enough to waste money.

**This CLI is MIT-licensed open source.** You can read every line it runs before you put it on a machine with SSH access, API keys, or customer data.

Hosted alerts, alert history, team features, and automated actions are commercial features provided by [Badgr](https://badgr.dev).

---

## Quick Start

One-time local check, no account required:

```bash
npx gpu-monitor check --hourly-rate 2.50
```

Continuous local watcher, no account required:

```bash
npx gpu-monitor watch --hourly-rate 2.50
```

See which processes are holding VRAM:

```bash
npx gpu-monitor processes
```

Continuous watcher with Badgr email alerts:

```bash
npx gpu-monitor watch \
  --hourly-rate 2.50 \
  --idle-minutes 30 \
  --email you@example.com \
  --badgr-key $BADGR_API_KEY
```

Email alerts require a Badgr account and API key.

---

## Commands

### `check`

Runs one `nvidia-smi` sample and prints the current GPU state.

```bash
npx gpu-monitor check --hourly-rate 2.50
```

### `watch`

Runs in the terminal and checks every interval.

```bash
npx gpu-monitor watch --hourly-rate 2.50 --interval 60
```

If a GPU stays idle for at least `--idle-minutes`, it becomes alert-ready. With `--email` and `--badgr-key`, the watcher sends an email alert through Badgr, then waits for the email cooldown before sending another alert for the same GPU.

### `processes`

Shows which PIDs are holding VRAM on each GPU.

```bash
npx gpu-monitor processes
npx gpu-monitor processes --json
```

Useful when a GPU shows high memory but low utilization — a stale process is likely holding VRAM without doing any work. See [Stale Memory](#stale-memory) below.

---

## Keeping watch alive after SSH disconnect

`watch` only works while the process is alive. To keep it running after you disconnect:

**tmux** (recommended for interactive sessions):

```bash
tmux new -s gpu-monitor
npx gpu-monitor watch --hourly-rate 2.50 --email you@example.com --badgr-key $BADGR_API_KEY
# Ctrl-b d  to detach
# tmux attach -t gpu-monitor  to reattach
```

**screen**:

```bash
screen -S gpu-monitor
npx gpu-monitor watch --hourly-rate 2.50 --email you@example.com --badgr-key $BADGR_API_KEY
# Ctrl-a d  to detach
# screen -r gpu-monitor  to reattach
```

**nohup** (fire-and-forget, no reattach):

```bash
nohup npx gpu-monitor watch \
  --hourly-rate 2.50 \
  --email you@example.com \
  --badgr-key $BADGR_API_KEY \
  >> gpu-monitor.log 2>&1 &
echo $!   # save the PID to kill later
tail -f gpu-monitor.log
```

---

## Defaults

```text
interval: 60 seconds
idle-minutes: 30
idle-utilization: 10%
idle-memory-percent: 10%
email cooldown: 60 minutes per GPU
hourly-rate: 1.00
```

---

## CLI Options

```bash
--hourly-rate <usd>             Hourly cost per GPU (default: 1)
--idle-minutes <minutes>        Alert after this much idle time (default: 30)
--interval <seconds>            Watch interval (default: 60)
--idle-utilization <pct>        GPU utilization at or below this is idle (default: 10)
--idle-memory-percent <pct>     Memory use at or below this is idle (default: 10)
--json                          Print JSON report
--email <address>               Send idle alerts through Badgr (watch only)
--badgr-key <key>               Badgr API key for email alerts
--email-cooldown-minutes <min>  Email cooldown per GPU (default: 60)
--help                          Show help
```

---

## How It Works

Every interval, `check` and `watch` run:

```bash
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits
```

`processes` additionally runs per GPU:

```bash
nvidia-smi --id=<index> --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits
```

A GPU is idle when both are true:

```text
utilization <= idle-utilization threshold
memory % <= idle-memory threshold
```

The watcher tracks how long each GPU has stayed idle. It alerts only when:

```text
GPU has been idle for >= idle-minutes
AND email cooldown has passed
```

It does not email every interval. Multi-GPU machines are tracked per GPU index.

If `nvidia-smi` is missing, the CLI exits non-zero and prints the driver visibility issue instead of guessing.

The API key is never printed to stdout or stderr.

---

## Stale Memory

A GPU is flagged as **stale memory** when:

```text
utilization <= idle threshold   (GPU is not computing)
memory > memory threshold       (something is holding VRAM)
```

This is the classic "forgot to free after training finished" situation. The job exited but the process never released its memory allocation, leaving the GPU occupied without doing any work.

`check` and `watch` print a warning line for stale-memory GPUs:

```text
✓ GPU 0 NVIDIA A100-SXM4-40GB: active
  utilization: 2%
  memory: 8192/40960 MB (20.0%)
  idle duration: 0s
  power draw: 50 W
  ⚠ stale memory: high VRAM, low utilization — a process may be holding memory
```

Run `gpu-monitor processes` to see the PID:

```text
GPU processes

GPU 0 NVIDIA A100-SXM4-40GB  8192/40960 MB (20.0%)
  PID 12345     python3                   8000 MB
  held: 8000 MB / 40960 MB (19.5%)
  ⚠ stale memory: low utilization but high VRAM — run `gpu-monitor processes` to see PIDs
```

---

## Waste Calculation

```text
estimated waste = hourly rate × idle minutes / 60
```

Example:

```text
$2.50/hr × 30/60 = $1.25 wasted after 30 idle minutes
```

---

## Output

### check / watch

```text
GPU cost watcher

Checked at: 2026-06-09T06:00:00.000Z
GPUs checked: 2
Idle GPUs: 1
Alert-ready GPUs: 1
Hourly rate: $2.50/hr
Idle threshold: 30 min (utilization <= 10%, memory <= 10%)
Estimated waste: $1.25
Next check: 2026-06-09T06:01:00.000Z

⚠ GPU 0 NVIDIA A100-SXM4-40GB: idle
  utilization: 0%
  memory: 512/40960 MB (1.3%)
  idle duration: 30.0m
  power draw: 45 W
  estimated waste: $1.25 after 30 min idle

✓ GPU 1 NVIDIA L40S: active
  utilization: 85%
  memory: 16000/46080 MB (34.7%)
  idle duration: 0s
  power draw: 240 W
```

### processes

```text
GPU processes

GPU 0 NVIDIA A100-SXM4-40GB  8192/40960 MB (20.0%)
  PID 12345     python3                   6000 MB
  PID 67890     jupyter                   2000 MB
  held: 8000 MB / 40960 MB (19.5%)
  ⚠ stale memory: low utilization but high VRAM — run `gpu-monitor processes` to see PIDs

GPU 1 NVIDIA L40S  16000/46080 MB (34.7%)
  no compute processes
```

---

## Install Globally

```bash
npm install -g gpu-monitor
gpu-monitor watch --hourly-rate 2.50
```

---

## Requirements

* Node.js 18+
* NVIDIA drivers with `nvidia-smi` available
* A GPU machine for live readings
* A Badgr API key for email alerts

### GPU cloud containers (RunPod, Vast.ai, Lambda Labs, Modal, CoreWeave)

Plain images like `node:20` do not include `nvidia-smi`. Use a CUDA runtime image and install Node.js in it:

```bash
# Example base image
nvcr.io/nvidia/cuda:12.6-runtime-ubuntu22.04

# Then install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

Or use a pre-built CUDA + Node image from the provider's image registry.

`gpu-monitor` tries these paths automatically before giving up:

```text
nvidia-smi
/usr/bin/nvidia-smi
/usr/local/nvidia/bin/nvidia-smi   ← NVIDIA container toolkit default
/usr/local/bin/nvidia-smi
```

If all paths fail, the tool prints a clear message explaining which image type to use.

---

## Open Source

`gpu-monitor` is MIT-licensed. Source is at [github.com/michaelmanly/gpu-monitor](https://github.com/michaelmanly/gpu-monitor).

**What is open source:**

* `check` — one-time GPU status
* `watch` — continuous monitoring with idle detection, waste estimate, power draw, email alerts, cooldown
* `processes` — per-GPU PID list showing which processes hold VRAM
* Stale memory detection
* All `nvidia-smi` parsing logic
* JSON output

**What is commercial (Badgr):**

* Hosted email alerts and alert history
* Team and fleet dashboards
* Automated actions and auto-shutdown
* Paid monitoring features

Bugs and pull requests welcome on GitHub.
