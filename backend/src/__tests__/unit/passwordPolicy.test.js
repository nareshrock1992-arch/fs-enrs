// One password rule for administrator-set and self-service passwords.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
const { query } = await import('../../db/pool.js');
const { passwordSchema } = await import('../../validators/passwordPolicy.js');
const { changePassword } = await import('../../controllers/authController.js');

describe('password policy', () => {
  it.each(['Aa1!aaaa', 'Correct-Horse-9'])('%s is accepted', (p) => expect(passwordSchema.safeParse(p).success).toBe(true));
  it.each(['aaaaaaaa', 'AAAAAAA1', 'Aa1aaaaa', 'Aa1!'])('%s is refused', (p) => expect(passwordSchema.safeParse(p).success).toBe(false));

  it('change-password refuses a weak new password before touching the database', async () => {
    const next = vi.fn();
    await changePassword({ body: { currentPassword: 'whatever', newPassword: 'aaaaaaaa' }, user: { id: 1 } }, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
    expect(query).not.toHaveBeenCalled();
  });
});
