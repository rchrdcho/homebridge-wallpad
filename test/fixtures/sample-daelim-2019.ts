// SPDX-License-Identifier: AGPL-3.0-only

// Source: github.com/zooil/wallpad js/daelim_socket.js (DEVICE_COMMAND)
// Public sample from a 2019 Daelim e-Pyeonhan-Sesang unit. Not captured from this project's wallpad;
// use only to exercise the framing engine and never hard-code these values in src/.
export const SAMPLE_FRAMES = [
  'F7 20 21 01 11 00 00 00 00 00 00 00 00 53 AA', // living room light 1 off
  'F7 20 21 01 11 01 00 00 00 00 00 00 00 54 AA', // living room light 1 brightness 1
  'F7 20 21 01 11 0A 00 00 00 00 00 00 00 5D AA', // living room light 1 brightness 8
  'F7 20 21 01 12 01 00 00 00 00 00 00 00 55 AA', // living room light 2 on
  'F7 20 22 01 11 00 00 00 00 00 00 00 00 54 AA', // room 1 off
  'F7 20 24 01 11 01 00 00 00 00 00 00 00 57 AA', // room 3 on
  'F7 20 41 01 11 0E 00 00 00 00 00 00 00 81 AA', // heating off
  'F7 20 41 01 11 8E 00 00 00 00 00 00 00 01 AA', // heating heat (checksum sum 0x101 -> low byte 0x01)
];
