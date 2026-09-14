# Runbook: flashing the fixed EC on lemp13-b + recovery

Operational guide for flashing the EC firmware from the
`fix/peci-espi-recovery` branch (base `44668469` = the current EC pin in
firmware-open, plus the PECI-over-eSPI fix). Technical background:
`peci-over-espi-notes.md`.

Two ways to deploy, pick one:

- **EC-only (fast path):** build `build/ec.rom` from this repo and flash it
  over the running system (`flash_internal`). No BIOS involvement; the fix
  does not touch the EC<->BIOS interface. Sections 0-4 below.
- **Full stack (release path):** build BIOS+EC together from a
  firmware-open branch whose `ec` submodule points at this branch, then
  flash both with firmware-open `flash.sh`. The pair is then exactly as
  System76 would release it. See section 6.

## 0. What you are flashing - ROM identity check

```
strings build/ec.rom | grep 76EC
```

Must print EXACTLY:

```
76EC_BOARD=system76/lemp13-b
76EC_VERSION=<date>_<branch head hash>
```

- `76EC_BOARD` must be `system76/lemp13-b` - a wrong-board ROM bricks the
  EC (recovery in section 5).
- `<hash>` must equal `git log -1 --format=%h` of the checked-out branch.
  If not, rebuild: the recipes (docker container - recommended; or SDCC 4.2
  in a bwrap sandbox) are in `peci-over-espi-notes.md`, section Build.
  NEVER build with a system SDCC >= 4.5 (mixed-toolchain link produces a
  clean-looking but broken ROM - this caused a previous brick on this
  machine).

## 1. Preparation (EC alive, OS boots)

1. Laptop on **AC power**, all work saved - the flash triggers a watchdog
   reset and the machine powers off immediately at the end (normal).
2. Unlock firmware (required every boot; coreboot write-locks the EC):
   ```
   ./scripts/ectool.sh security unlock
   ```
3. Record the installed EC version (exact rollback source):
   ```
   ./scripts/ectool.sh info
   ```
   The `version:` line is `DATE_REV`; REV is a system76/ec commit from which
   an exact stock ROM can be rebuilt in the container.

   NOTE: `flash_backup` is NOT a dump command - it programs the EC's backup
   flash region from an existing firmware file (it reads the file first and
   panics with NotFound if the file does not exist).

   The real in-band safety net is automatic: every `flash`/`flash_internal`
   run first dumps the current EC flash to `backup.rom` in the current
   directory ("Saving ROM to backup.rom"). After flashing, verify it:
   262144 bytes and `strings backup.rom | grep 76EC_VERSION` shows the OLD
   version. Rollback = security unlock + shutdown (auto power-on) +
   `sudo tools/system76_ectool/target/release/system76_ectool flash backup.rom`.

## 2. Flash

```
make BOARD=system76/lemp13-b flash_internal
```

- The machine **powers off immediately** at the end (watchdog reset).
  This is expected.
- Power the laptop back on.

## 3. Post-flash verification

1. EC version:
   ```
   sudo fwupdmgr get-devices | grep -A3 -i embedded
   ```
   (or `./scripts/ectool.sh info`) - must match `76EC_VERSION` from the
   ROM.
2. **`sensors` must show a non-zero CPU temperature right after boot.**
   - Temperature 0 plus `oob channel not ready` repeating every 250 ms in
     the EC log means the ESC2CAC0 Enable/Ready bits do not behave as
     documented on IT5570E. This is NOT a brick. Roll back per section
     4b, drop the `espi_oob_ready()` check (5 lines per function in
     `peci.c`), rebuild, flash again.
3. EC log (optional, recommended for the first days):
   ```
   make BOARD=system76/lemp13-b console_internal
   ```
4. Reproduce the original bug: plug/unplug a DP display on USB-C.
   Temperature may drop out briefly but MUST recover within ~1 s.
   Isolated `upstream busy` / `channel disabled` / `oob channel not
   ready` / single timeout messages are fine. An endless loop of the same
   message: see section 4c.

## 4. Failure decision tree

**4a) `flash_internal` fails with "write locked"**
-> Run `./scripts/ectool.sh security unlock` again (valid until reboot)
   and retry. Nothing bad happened; the flash never started.

**4b) EC runs but the firmware misbehaves** (temperature 0 from the
start, log spam, odd fan behavior) and the OS still boots:
-> Roll back in-band, no ATmega needed (security unlock + shutdown +
   auto power-on first, daemons stopped):
```
sudo tools/system76_ectool/target/release/system76_ectool flash backup.rom
```
(`backup.rom` = the automatic pre-flash dump from the repo root; the
machine powers off immediately again; the stock EC is back after
power-on.)

**4c) Endless `upstream timeout` / `response timeout` in the log after a
DP unplug, temperature never recovers**
-> The fix did not cover your failure mode. Do not reflash anything;
   report the exact log lines to the system76/ec issue/PR - they now
   identify the engine state precisely. The laptop remains fully usable
   otherwise (temperature reads 0, fan sits at minimum; the CPU is still
   protected by hardware Tjmax/PROCHOT).

**4d) Machine does not power on after flashing / keyboard and power
button dead / EC unresponsive** (interrupted flash, wrong ROM, ...)
-> No OS, so in-band flashing is impossible. Only path: external
   recovery, section 5.

## 5. Recovery: ATmega2560 + flex cable (EC dead)

The IT5570E boots from mask ROM - ISP recovery ALWAYS works, even with a
completely corrupted flash. The CONFIG_SECURITY write lock is irrelevant
for external flashing.

### Shopping list (buy in advance)

| Item | Notes |
|---|---|
| ATmega2560 board | Arduino Mega 2560 Rev3 **or a clone with the ATmega16U2** USB chip (~300-400 CZK). NOT a CH340G clone - the tools look for `/dev/ttyACM0` and `usb-Arduino*` by-id. |
| 24-pin FPC breakout | 0.5 mm pitch FPC connector + 2.54 mm pin headers. For lemp13-b the **0.5 mm** side (14" keyboard, same as darp10-b/lemp13; verify visually against the keyboard cable). |
| 24-pin FFC cable, 0.5 mm | same-sided, ~15 cm; buy both a standard AND a reversed cable up front - which one puts pin 1 on pin 1 depends on connector orientation. |
| USB-A to USB-B cable | ATmega -> host PC |
| USB-C cable | grounding: laptop -> host PC |
| Power blocker or tape | the keyboard connector carries no ground; the USB-C cable is ground-only - tape over its power pin (or use a power blocker) so the EC is not fed from the host. |
| Second computer | for building and running `flash_external` (same machine works if practical) |

Ready-made kits with exactly this content: 3mdeb "EC Flashing Kit" /
NovaCustom "EC Recovery Kit" (Dasharo uses the same EC codebase).

### Programmer setup (once, on the host PC)

```
sudo scripts/deps.sh                        # avr-gcc, avrdude, ...
git submodule update --init tools/ecflash   # isp tool (Rust)
make -C tools/mega2560
make -C tools/mega2560 flash                # programmer firmware -> ATmega
```

### Procedure - the laptop must have NO power at all

1. Laptop off, **AC unplugged**.
2. Bottom panel off, **battery disconnected**.
3. Keyboard flex cable unplugged from its connector on the board.
4. Panel back on (avoid shorts), laptop flipped over.
5. USB-C ground cable: laptop -> host PC (power pin taped / power
   blocker).
6. ATmega -> host PC via USB-B. Verify `/dev/ttyACM0` exists.
7. Breakout inserted into ATmega digital pins **22-45**, FPC connector
   facing AWAY from the ATmega (breakout pin 1 = ATmega pin 22/PA0).
8. FFC cable: breakout <-> keyboard connector. **Pin 1 to pin 1**
   (leftmost); on a 26-pin connector align the traces with pins 1-24.
9. Flash:
   ```
   make BOARD=system76/lemp13-b flash_external
   ```
10. **Check the output:** it must print `ID: 5570 VER: ...`.
    - `ID: FF7F VER: 127` or a timeout means the FFC is seated wrong:
      try the reversed cable, re-check pin 1, connector seating, breakout
      orientation; repeat from step 7. Retrying cannot damage anything.
11. Done: disconnect ATmega and the ground cable, reconnect keyboard and
    battery, close up, power on.
12. Continue with section 3 (verification).

The same path (`flash_external` with the current `build/ec.rom`) also
flashes the fixed ROM directly - recovery and flashing are the same
procedure.

## 6. Notes and the full-stack ("right way") build

- **Official updates overwrite the fix.** Any LVFS/fwupd update or
  firmware-open `flash.sh` flashes BIOS **and EC** and returns the EC to
  the stock version (the fix disappears; behavior returns to today's -
  nothing breaks). After such an update either reflash (section 2) or
  maintain your own firmware-open build:
  - fork `system76/firmware-open`, create a branch, point the `ec`
    submodule at this branch's commit (and its URL at your fork in
    `.gitmodules`), build per firmware-open docs, flash with `flash.sh`
    (writes both images as a matched pair).
- **The BIOS does NOT need rebuilding for the EC-only path.** The EC is a
  standalone image for the IT5570E internal flash; coreboot does not
  reflash or version-check the EC at boot (verified: the system76 coreboot
  EC driver `src/ec/system76/ec/` contains no flashing logic - it only
  write-locks the EC, hence `security unlock` every boot).
- **Compatibility of the EC-only flash:** the fix touches only the PECI
  transaction layer; no SMFI command, ACPI, PNP, virtual-wire or eSPI
  interface changes. The branch base (`44668469`, the firmware-open pin
  since 2026-08-19) differs from the previous pin (`39f1a9e2`,
  2026-01-27) by 12 commits: internal refactors, additive ectool
  commands, PNP register fixes per the ITE programming guide, and the
  e-flash signature move 0x40->0x80 (boot-neutral: hardware scans
  0x40-0xF0 for it). None require a BIOS change.
- Never flash another board's ROM (check in section 0).
- Never build with system SDCC >= 4.3, not even "just to try" - the
  mixed-toolchain link produces a ROM that builds clean but bricks
  (confirmed the hard way once already).
