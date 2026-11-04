/**
 * Conference events reach only the owning tenant and SUPER_ADMIN, in order, and an ESL
 * command can never carry a line break. REAL eslService; ownership lookup and socket
 * server are fakes. No ESL connection exists here, so nothing can be dialled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const owners = vi.hoisted(() => ({ findConferenceOwners: vi.fn() }));
vi.mock('../../services/conferenceOwnership.js', () => owners);

const { setSocketIO, setConferenceRecordingError, eslCommand } = await import('../../services/eslService.js');

function fakeIo() {
  const sent = [];
  const io = {
    emit: vi.fn(),
    to(room) {
      const rooms = [room];
      const chain = { to(r) { rooms.push(r); return chain; }, emit: (event, data) => sent.push({ rooms, event, data }) };
      return chain;
    },
  };
  return { io, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('conference event routing', () => {
  let f;
  beforeEach(() => { vi.clearAllMocks(); f = fakeIo(); setSocketIO(f.io); });

  it('goes to the owning tenant and SUPER_ADMIN, never to every socket', async () => {
    owners.findConferenceOwners.mockResolvedValue(new Map([['room_a', 10]]));
    setConferenceRecordingError('room_a', 'x');
    await settle();
    expect(f.sent.map(s => s.rooms)).toEqual([['tenant:10', 'role:SUPER_ADMIN']]);
    expect(f.io.emit).not.toHaveBeenCalled();
  });
  it('a room with no known owner goes to SUPER_ADMIN only, and is looked up again next time', async () => {
    owners.findConferenceOwners.mockResolvedValue(new Map());
    setConferenceRecordingError('room_b', 'x');
    await settle();
    expect(f.sent.at(-1).rooms).toEqual(['role:SUPER_ADMIN']);
    owners.findConferenceOwners.mockResolvedValue(new Map([['room_b', 20]]));
    setConferenceRecordingError('room_b', 'y');
    await settle();
    expect(f.sent.at(-1).rooms).toEqual(['tenant:20', 'role:SUPER_ADMIN']);
  });
  it('a failed lookup limits the event to SUPER_ADMIN (fails closed)', async () => {
    owners.findConferenceOwners.mockRejectedValue(new Error('db down'));
    setConferenceRecordingError('room_c', 'x');
    await settle();
    expect(f.sent.at(-1).rooms).toEqual(['role:SUPER_ADMIN']);
  });
  it('a room\'s events keep their order and share one lookup', async () => {
    owners.findConferenceOwners.mockResolvedValue(new Map([['room_d', 10]]));
    setConferenceRecordingError('room_d', 'first');
    setConferenceRecordingError('room_d', 'second');
    await settle();
    expect(f.sent.map(s => s.data.recordingError)).toEqual(['first', 'second']);
    expect(owners.findConferenceOwners).toHaveBeenCalledTimes(1);
  });
});

describe('ESL command guard', () => {
  it.each(['conference a say hi\n\napi system id', 'status\r\n', 'x\0y'])('refuses %j', async (cmd) => {
    await expect(eslCommand(cmd)).rejects.toThrow('line break');
  });
  it('an ordinary command gets past the guard (and stops at the absent connection)', async () => {
    await expect(eslCommand('status')).rejects.toThrow('ESL not connected');
  });
});
