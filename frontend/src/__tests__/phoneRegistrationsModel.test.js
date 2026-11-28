import { describe, it, expect } from 'vitest';
import {
  connectionLabel, deviceLabel, addressLabel, healthOf, trunkLabel, uptimeLabel, matchesSearch,
} from '../pages/settings/phoneRegistrationsModel.js';

const micro = { extension: '1002', device: 'MicroSIP/3.21.6', ip: '192.168.1.123', port: 56893, transport: 'UDP', nat: false,
  reachable: true, pingMs: 0, expiresIn: 160, mac: null, browserPhone: false, realm: '192.168.1.124' };
const browser = { ...micro, extension: '1003', device: 'FS-WebRTC/0.1 (SIP.js 0.21.2)', ip: '192.168.1.124', transport: 'WSS', nat: true, browserPhone: true };
const yealink = { ...micro, extension: '2001', device: 'Yealink SIP-T46U 108.86.0.20', ip: '192.168.1.40', port: 5060, nat: true, pingMs: 240, mac: '80:5E:C0:12:34:AB' };

describe('phone registrations — words an admin understands', () => {
  it('connection', () => {
    expect(connectionLabel(micro)).toBe('UDP');
    expect(connectionLabel(browser)).toBe('Secure web (WSS) · behind NAT');
    expect(connectionLabel(yealink)).toBe('UDP · behind NAT');
    expect(connectionLabel({ transport: 'TLS' })).toBe('TLS (encrypted)');
  });

  it('device and address', () => {
    expect(deviceLabel(micro)).toBe('MicroSIP 3.21.6');
    expect(deviceLabel(browser)).toBe('Browser phone (FS-CC)');
    expect(deviceLabel(yealink)).toBe('Yealink SIP-T46U 108.86.0.20');
    expect(deviceLabel({})).toBe('Unknown device');
    expect(addressLabel(micro)).toBe('192.168.1.123:56893');
    expect(addressLabel(browser)).toBe('via FS-CC relay');
    expect(addressLabel({})).toBe('—');
  });

  it('health', () => {
    expect(healthOf(micro)).toEqual({ tone: 'ok', text: 'Reachable · 160 s left' });
    expect(healthOf(yealink)).toEqual({ tone: 'warn', text: 'Slow · 240 ms' });
    expect(healthOf({ ...micro, reachable: false })).toEqual({ tone: 'bad', text: 'Not answering' });
    expect(healthOf({ expiresIn: 30, reachable: null })).toEqual({ tone: 'muted', text: 'Registered · 30 s left' });
  });

  it('trunks', () => {
    expect(trunkLabel({ status: 'UP', registration: 'REGED', problem: null })).toEqual({ tone: 'ok', text: 'Up · Registered' });
    expect(trunkLabel({ status: 'UP', registration: 'NOREG', problem: null })).toEqual({ tone: 'ok', text: 'Up · No registration needed' });
    expect(trunkLabel({ status: 'UP', registration: 'FAIL_WAIT', problem: 'not registered' })).toEqual({ tone: 'bad', text: 'Registration failed, retrying' });
    expect(trunkLabel({ status: 'DOWN', registration: 'REGED', problem: 'down' })).toEqual({ tone: 'bad', text: 'Down' });
    expect(uptimeLabel(397954)).toBe('4 d 14 h');
    expect(uptimeLabel(3 * 3600 + 300)).toBe('3 h 5 m');
    expect(uptimeLabel(42)).toBe('42 s');
    expect(uptimeLabel(null)).toBe('—');
  });

  it('search: extension, IP, device, MAC with or without separators', () => {
    const rows = [micro, browser, yealink];
    const find = (q) => rows.filter((r) => matchesSearch(r, q)).map((r) => r.extension);
    expect(find('')).toEqual(['1002', '1003', '2001']);
    expect(find('1003')).toEqual(['1003']);
    expect(find('192.168.1.40')).toEqual(['2001']);
    expect(find('microsip')).toEqual(['1002']);
    expect(find('browser')).toEqual(['1003']);
    expect(find('80:5e:c0')).toEqual(['2001']);
    expect(find('805ec012')).toEqual(['2001']);
  });
});
