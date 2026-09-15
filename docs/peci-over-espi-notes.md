# PECI-over-eSPI: stuck upstream engine (notes)

Notes for the fix in `src/app/main/peci.c` addressing permanent PECI failures
after USB-C/TBT display hotplug on boards with `CONFIG_PECI_OVER_ESPI=y`
(lemp13-b affected). Not part of the mdbook; orphan on purpose.

Upstream references: [issue #369], [issue #525], [draft PR #530].
Step-by-step flashing/recovery operations: `lemp13-b-flash-runbook.md`.

[issue #369]: https://github.com/system76/ec/issues/369
[issue #525]: https://github.com/system76/ec/issues/525
[draft PR #530]: https://github.com/system76/ec/pull/530

## Branch and base

Work lives on branch `fix/peci-espi-recovery`, based on `44668469` — the EC
commit pinned by firmware-open master since 2026-08-19 (the previous pin was
`39f1a9e2`, 2026-01-27). Deliberately NOT ec master: the two commits on top
of the pin (`fan: Re-add interpolation-based algorithm`, `fan: Default to
interpolation algorithm`) are unreleased fan-behavior changes unrelated to
this fix.

Compatibility of the 12-commit delta from the previous pin (`39f1a9e2`) was
reviewed: internal refactors (security/usbpd/dgpu moves), additive ectool
commands, PNP register fixes per the ITE programming guide, and the e-flash
signature move 0x40->0x80 (boot-neutral: the hardware scans 0x40-0xF0). None
of them change the EC<->BIOS interface or require a BIOS rebuild; the fix
itself touches only the PECI transaction layer. coreboot never reflashes the
EC (no flashing logic in its `src/ec/system76/ec/` driver — it only
write-locks it). For a guaranteed-matched pair, build BIOS+EC together from a
firmware-open branch pointing its `ec` submodule at this branch.


## Symptoms

- Unplugging a display from the USB-C/TBT port makes CPU temperature read 0
  (`sensors` via ACPI, and EC fan control loses its input).
- EC debug log shows `peci_get_temp: upstream timeout` repeating forever.
- Warm reboot does **not** help (EC keeps standby power). Full power off **and
  unplugging AC** (or removing the battery) recovers — i.e. only an EC
  power-on reset clears the state.
- Sometimes the reading drops to 0 for a few seconds after plug/unplug and
  recovers by itself (transient variant of the same race).

## Hardware verdict (2026-09-15): host-side, NOT the EC

Proven on lemp13-b by flashing an instrumented ROM
(`2026-09-14_646c703-dirty`, sha256 `2b4b89ce…`) that dumps the eSPI OOB
engine registers on every `response timeout` (one line per distinct state).
Reproduced with USB-C/TBT DP **monitor suspend + wake**; full log in `lastlog2`.

In the permanent stall the EC OOB engine is **completely healthy** and the dump
line never changes across 130+ consecutive timeouts:

```
peci oob state: C2CAC0=13 USCTRL0=0 OSCTRL0=0 OSCTRL4=6
```

- `C2CAC0=0x13`: OOB channel ENABLE(b0)=1 **and READY(b1)=1** — channel is up.
- `USCTRL0=0x00`: upstream ENABLE/GO/CH_DISABLED/DONE/**BUSY all 0** — the
  upstream engine is idle and clean, not stranded.
- `OSCTRL0=0x00`: PUT_OOB STATUS=0 — no downstream response arrived.

Decisive point: the **transient (recoverable) and permanent stalls are
register-identical** (`C2CAC0=13 USCTRL0=0 OSCTRL0=0`; a transient one even
caught `OSCTRL0=80`, STATUS=1, a response landing right at the 10 ms edge). So
from the EC's registers there is *no difference* between "will recover" and
"stuck forever," and **there is no EC-side state to reset.** The EC transmits
the request (upstream DONE fires, no upstream error), the channel stays
enabled+ready, and the **PCH simply stops sending the downstream PUT_OOB PECI
response.** Transient = PCH answers slowly (~10 ms, occasionally a short
`len 6 < 7`); permanent = PCH never answers.

This **refutes every EC-side theory**, including the one the fix below was built
on (upstream stranding), plus RX re-arm and the ready-check OR-logic — all read
healthy. It is why flashing the fix did not change the symptoms. `warm reboot
doesn't help, only cold power-off does` is *consistent* with a PCH/Thunderbolt
side wedge (a warm reset does not reset the PCH eSPI-OOB / TBT controller
state); it is **not** evidence of an EC-side latch as previously assumed.

Root cause therefore lives host-side: PCH PECI-over-eSPI responder, coreboot
eSPI OOB channel configuration, or an Intel erratum around PECI-over-eSPI with
TBT/DP hotplug. Trigger is the USB-C/TBT DP path (monitor suspend/resume,
hotplug). An upstream report exists (issues #369 / #525) but is unattended. Next
work belongs in coreboot / the BIOS+EC pairing, not in `peci.c`.

Do not re-attempt EC-register recovery for this bug — the engine is not stuck.

### Corroborating upstream findings (issues #369 / #525)

- **It is Thunderbolt-specific.** Maintainer (crawfxrd): `addw4` uses
  PECI-over-eSPI but has **no TBT** and does **not** exhibit the bug; the other
  affected boards (lemp13, lemp13-b, oryp11, oryp12) all route DP over TBT.
  Trigger is the USB-C/TBT DP path — unplug, hotplug, or display suspend.
  (Reported worse with some monitors, e.g. Philips/Samsung USB-C.)
- **The disruption is not PECI-only.** heydemo (2026-06-11, stock
  `2025-07-24_c242738`): right after PECI dies, `SMFI` host commands also fail
  intermittently (`Protocol(1)`) for a few minutes, then SMFI recovers while
  PECI never does. So a TBT event briefly perturbs the whole eSPI host
  interface; only the **OOB channel** fails to re-establish. Consistent with our
  register verdict (EC side healthy, PCH-side OOB responder wedged).
- **Real thermal impact.** With PECI dead the fan curve never engages: CPU sits
  pinned at PROCHOT (pkg 95–99 °C, fan 0 RPM) until cold power-off. Only CPU
  self-throttling protects the silicon.

### Candidate fix at the right place

- **Bypass the fragile transport — use legacy H_PECI on lemp13-b.** The board
  physically wires the dedicated PECI pin (`GPF6`/`H_PECI`, currently `GPIO_ALT`
  but the controller is disabled via `GCR2=0` in favor of eSPI). Legacy PECI is
  a direct EC↔CPU wire that does **not** touch the PCH eSPI OOB channel, so it
  should be immune to the TBT/OOB disruption. Open question (see #370): does the
  Meteor Lake CPU still answer on the dedicated PECI wire, or was eSPI chosen
  because the pin path needs coreboot/FSP support that is not present? Testable:
  build lemp13-b with `CONFIG_PECI_OVER_ESPI` off and check both that temps read
  AND that the TBT-unplug repro no longer kills them. This is the most promising
  concrete lever we control.
- **Host-side (coreboot/FSP/Intel).** If legacy PECI is not viable, the real fix
  is re-establishing the eSPI OOB channel after a TBT disruption — coreboot eSPI
  OOB config, FSP, or an Intel PECI-over-eSPI + TBT erratum. Likely outside the
  EC repo entirely.

## Root cause (original theory — REFUTED on hardware, see verdict above)

Trigger: during TBT/DP hotplug the PCH briefly fails to complete the EC's
in-flight eSPI OOB upstream transaction (host busy in SMI/hotplug handling, or
the master resets the OOB channel — offset 13h bit0: clearing Enable "triggers
a reset to the OOB Message channel such as during error handling").

The permanent failure is an EC driver bug. From the IT81202E datasheet (the
public equivalent of the IT5570E docs per README), `ESUCTRL0` (offset B0h):

- bit6 GO: "Write-1 to initiate an eSPI upstream transaction **if not
  'Upstream Busy'**. **Write-0 is ignored.**"
- bit0 BUSY: read-only.
- bit7 ENABLE: R/W (writing 0 disables — the only software abort).
- bits 1/2 DONE / CH_DISABLED: write-1-clear status.

Old code on timeout returned without cleanup: ENABLE=1 and GO=1 stayed set and
the transaction stayed pending (BUSY=1). On the next call,
`ESUCTRL0 = ESUCTRL0` (read-back write) preserved ENABLE/GO — GO cannot be
zeroed by software — and `ESUCTRL0 |= GO` writes 1 to GO, which hardware
**ignores while BUSY=1**. No new transaction is ever initiated, DONE never
arrives, and every call times out until the EC is power-cycled. The UDB/length
registers were also rewritten mid-transaction.

The Zephyr `espi_it8xxx2.c` driver (same ITE eSPI slave IP) confirms the
correct handling: refuse to start when the engine is BUSY or the OOB channel
is not ready, and clear DONE + disable ENABLE after completion.

## Fix

Each transaction (`peci_get_temp`, `peci_wr_pkg_config`) now follows one
lifecycle, so any stranded state self-heals on the next call (250 ms cadence):

1. Skip if the OOB channel is down: `ESC2CAC0` (offset 13h) bit0 Enable /
   bit1 Ready. Accept either bit (OR) so a part that does not drive Ready
   still passes.
2. Abort: `ESUCTRL0 = DONE | CH_DISABLED` (writes ENABLE=0, GO write-0 is
   ignored by hardware), clear `ESOCTRL0` status.
3. Configure cycle type/length/UDB while the engine is disabled.
4. `ESUCTRL0 = ENABLE | DONE | CH_DISABLED` — GO written as 0 here, because a
   write of 1 would initiate even if GO already reads 1 from a stranded
   transaction.
5. Bounded wait (10 ms) for `!BUSY` — lets an aborted transaction drain; a GO
   write while busy would be ignored.
6. Clear status again (a draining transaction may have set DONE), then
   `|= GO` to initiate.
7. Bounded wait for `DONE | CH_DISABLED`; CH_DISABLED exits fast with a
   distinct log line (host dropped the channel mid-transaction).
8. On every failure return, the engine is left disabled and status cleared.
9. Response phase unchanged except `ESOCTRL4 & 0x7F` (bit 7 is reserved).

Worst-case blocking grew from 20 ms to 30 ms per call (three bounded 10 ms
waits) in failure cases only; the healthy path adds a few register writes.

### Unverified assumption (check on first boot)

VERIFIED on hardware 2026-09-14, see below. Kept for reference.

IT5570E behavior of `ESC2CAC0` (0x3113) bits 0/1 is assumed identical to
IT81202E/IT8xxx2 (NDA datasheet not available). If the bits read 0 during
normal operation, the ready check would disable PECI entirely — immediately
visible as `oob channel not ready` in the log every 250 ms plus 0 temperature
from the first boot. Revert path: delete the `espi_oob_ready()` check; the
rest of the fix does not depend on it. This cannot brick the EC.

### Hardware verification (lemp13-b, 2026-09-14)

ROM `2026-09-14_346d8ff` (fix + ins-prtsc keymap, container-built with SDCC
4.2.0) flashed in-band over stock `2025-03-28_25772d2` (= ec `fdefd16` built
via firmware-open `25772d2`; note firmware-open overrides the EC VERSION with
its own date_rev and submodule dirt does not surface as `-dirty`). Result:
boots normally, `sensors` shows CPU temperature immediately — the ESC2CAC0
Enable/Ready check passes on real IT5570E, fan control works, and the
renumbered fan-mode commands work with the patched fan_control_service
(FanGetMode=23/FanSetMode=24, commit `8837cec` on `manual-fan-control`).
Rollback images: `backup.rom` (byte-exact pre-flash dump, sha256 `9a9cace6…`)
and `~/ec-stock-rollback-fdefd16.rom` (rebuilt equivalent, version string
matched to stock). DP-unplug reproduction test: pending — the definitive
check that the original bug is gone.

### Reading the log if it still misbehaves

- persistent `upstream busy` → BUSY survives the ENABLE=0 abort and the host
  never accepts the pending cycle; would need link-level recovery (deliberate
  next step, evidence-based — not implemented).
- persistent `response timeout` (upstream phase OK) → PCH answers OOB not at
  all. Confirmed on hardware to be a **host-side** wedge that the EC cannot
  clear (see "Hardware verdict" above); the EC engine reads healthy throughout.
  It does NOT reliably recover on its own — this is the actual lemp13-b failure.
- persistent `channel disabled` / `oob channel not ready` → host holds the
  OOB channel down.

## Build

The repo requires SDCC 4.2.x (CI: Ubuntu 24.04). SDCC >= 4.3 rejects the
existing `__code` declarations (error 356) — that failure mode is safe (no
ROM produced). The dangerous failure mode is a **mixed-toolchain link**: if
another SDCC's `share/sdcc` is reachable (e.g. system 4.6 at
`/usr/share/sdcc`), the linker pulls `crtstart.rel`/`libsdcc.lib` from it
while objects were compiled by 4.2 (visible as `?ASlink-Warning-Definition
of public symbol '__gptrget' found more than once`). The ROM builds "clean"
but has a runtime ABI mismatch — this is a confirmed bricking cause on this
machine from an earlier flash attempt.

On distros with newer SDCC, run 4.2.0 isolated, e.g. via debs + bwrap (bind
the 4.2 `share/sdcc` over `/usr/share/sdcc` so every search path resolves to
4.2):

```
bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc \
    --bind "$PWD" "$PWD" --bind /tmp/opencode /tmp/opencode \
    --bind /tmp/opencode/sdcc42/root/usr/share/sdcc /usr/share/sdcc \
    env PATH=/tmp/opencode/sdcc42/root/usr/bin:$PATH \
    make BOARD=system76/lemp13-b
```

Verified: builds for all PECI-over-eSPI boards (lemp13-b, lemp13, oryp11,
oryp12, addw4); uncrustify/shellcheck pass; code growth ~0.5 kB.

### Containerized build (recommended)

EC-only ROM in a clean Ubuntu 24.04 container (SDCC 4.2.0 = CI):

```
printf 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends make sdcc binutils xxd git ca-certificates && rm -rf /var/lib/apt/lists/*\n' > /tmp/Dockerfile.ecbuild
docker build -t ecbuild-noble -f /tmp/Dockerfile.ecbuild /tmp
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD:/ec" -w /ec ecbuild-noble make BOARD=system76/lemp13-b
```

Verified reproducible: the container-built `ec.rom` is byte-identical to the
bwrap/deb build (sha256 `6e0cd94d…019e` at commit 8208abc).

SDCC version matrix: 4.2.0 (CI, Ubuntu 24.04) verified; 4.4.0 (svn r14648,
mcs51-only) is what the official firmware-open build container compiles from
source (`containers/firmware-open/Containerfile`); 4.5.0 is accommodated
upstream (e-flash signature moved to 0x80 because of it); 4.6.0 fails
(error 356 on the existing `__code` declarations).

Full stack (BIOS+EC as a matched pair): build the official container image
(`make -C containers` with podman, or `docker build -t system76/firmware-open
-f containers/firmware-open/Containerfile containers/firmware-open` — heavy,
compiles the coreboot crossgcc and SDCC from source), then run
`./scripts/build.sh lemp13-b` inside it with the repo (submodules checked
out, LFS pulled) mounted at `/workspace`. Artifacts come out root-owned;
chown afterwards. Flash from the host with `scripts/flash.sh`.

## Simulator smoke test (ecsim)

Both the fixed ROM and pristine master (control) were booted in `tools/ecsim`
(area8051). Results identical: full boot through init() — banner
`System76 EC board 'system76/lemp13-b'`, same 231-byte debug trace, main loop
runs interval tasks (lid_event at the 500 ms gate fires), I2C/charger failures
stay bounded (no hangs). The fix touches only the runtime PECI path
(`peci_init()` is empty on eSPI boards), not boot.

Sim accommodations needed (temporary, reverted after the test): relax the
unimplemented-register panics in `src/xram.rs`; zero-init xram instead of
`pmem.clone()` in `src/main.rs`; clear SMBus HOSTA BUSY on reads (no SMBus
engine is emulated); build the test ROM with `-DSERIAL_DEBUGGER` so the
console goes to SBUF (sim prints it).

Sim limitation: area8051's time base freezes after the first ~1 s of EC time,
so 1 ms-gated tasks (smfi_event) stop and `ectool --access lpc-sim` probes
time out — pristine master behaves the same, so it is not firmware-induced.
PECI-over-eSPI is not modeled (sim never reaches S0), so transaction logic
can only be validated on hardware.

## Flashing lemp13-b

`CONFIG_SECURITY=y`: the running firmware is write-locked.

Pre-flight checklist:

1. Verify ROM identity: `strings build/ec.rom | grep 76EC` must show
   `76EC_BOARD=system76/lemp13-b` and the expected `76EC_VERSION`.
2. Record the installed EC version (`./scripts/ectool.sh info`; `DATE_REV` -
   REV is the exact system76/ec commit to rebuild a stock rollback ROM
   from). NOTE: `flash_backup` is NOT a dump - it programs the backup flash
   region from an existing firmware file. The in-band safety net is
   automatic: every `flash` run first dumps the current EC flash to
   `backup.rom` in the CWD; verify it after flashing (262144 bytes, old
   `76EC_VERSION` in `strings`). Rollback = unlock + `flash backup.rom`.
3. Flash on AC power, work saved. Stop `system76-firmware-daemon` and any
   other daemon holding `/dev/port` locks first (`sudo fuser -v /dev/port`).

Internal (normal path; EC must be alive):

```
./scripts/ectool.sh security unlock     # one-time per boot
make BOARD=system76/lemp13-b flash_internal
```

This triggers a watchdog reset — the machine powers off immediately, save
work first. Flashing a wrong-board ROM bricks the EC (recover below).

## Bricked-EC recovery (external programmer)

The IT5570E boots from mask ROM, so ISP recovery always works even with
corrupted/erased flash. Per `docs/flashing.md` + `docs/mega2560.md`:

There is no alternative for the EC: `tools/ecflash/examples/isp.rs` talks to
the `tools/mega2560` firmware over serial (hardcoded `/dev/ttyACM0`) and
bit-bangs a 24-line parallel address/data bus (ITE ISP) through the keyboard
connector — all 24 pins are mapped in `tools/mega2560/src/parallel.c`.
CH341A / "SPI Pi" (Raspberry Pi + SOIC8 clip) methods from firmware-open are
for the BIOS SPI ROM only; the EC flash is internal to the IT5570E and the
keyboard bus is not SPI, so no SPI programmer can reach it. A Raspberry Pi
has enough GPIO in principle, but no public port of the programmer firmware
exists. NovaCustom/3mdeb (same EC codebase, Dasharo) sell an "EC Recovery
Kit" whose programmer is an ATmega2560 board — a cheap clone is sufficient,
but it must use the ATmega16U2 USB chip (not CH340G), since the tools look
for `/dev/ttyACM0` and `usb-Arduino*` by-id. The keyboard connector carries
no ground: the extra USB-C cable provides it, and its power pin must be
taped off / power-blocked so the EC is not fed from the host.

Hardware: Arduino Mega 2560 (ATmega16U2 USB chip, not CH340G) flashed with
`tools/mega2560` firmware, 24-pin FPC breakout board — **0.5 mm pitch side**
for the 14" keyboard connector (lemp13-b uses the darp10-b/14in_83 keyboard;
lemp13 is listed as 0.5 mm — verify the cable), a 24-pin FFC cable (standard
or reversed, so breakout pin 1 meets keyboard-port pin 1; 26-pin keyboards:
align traces to pins 1-24), a USB-C cable for common ground, and a second
computer.

```
git submodule update --init tools/ecflash   # isp tool (Rust)
make -C tools/mega2560 && make -C tools/mega2560 flash
```

Procedure — the system must have **no power at all**:

1. Laptop off, AC unplugged
2. Bottom panel off, **battery disconnected**
3. Keyboard ribbon disconnected from its port
4. Panel back on, laptop flipped over
5. USB-C ground cable: laptop -> host machine
6. Mega 2560 -> host machine
7. Programmer (FPC breakout + FFC) -> keyboard port
8. `make BOARD=system76/lemp13-b flash_external`

Then reassemble, reconnect battery, power on. If the EC was only write-locked
(not bricked), `flash_internal` is enough and this is not needed.
