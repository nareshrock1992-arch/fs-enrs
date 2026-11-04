import { z } from 'zod';

// One password rule for every place a password is set: user create/update by an
// administrator and self-service change-password. Change-password used to accept any
// 8 characters, so the complexity rule could be undone by the user straight after.
export const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d])/;
export const PASSWORD_MESSAGE = 'Must contain uppercase, lowercase, digit, and special character';

// bcrypt reads only the first 72 bytes of a password. No maximum is enforced, so long
// passphrases accepted before keep being accepted (zero-regression rule).
export const passwordSchema = z.string().min(8).regex(PASSWORD_REGEX, { message: PASSWORD_MESSAGE });
