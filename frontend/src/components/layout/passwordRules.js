// Mirrors backend/src/validators/passwordPolicy.js for immediate feedback; the server decides.
const RULES = [
  ['At least 8 characters', (p) => p.length >= 8],
  ['An uppercase letter', (p) => /[A-Z]/.test(p)],
  ['A lowercase letter', (p) => /[a-z]/.test(p)],
  ['A digit', (p) => /\d/.test(p)],
  ['A symbol', (p) => /[^A-Za-z\d]/.test(p)],
];

/** The rules a password does not meet (all of them for ''), in a fixed order. */
export function passwordProblems(password) {
  const p = String(password ?? '');
  return RULES.filter(([, ok]) => p === '' || !ok(p)).map(([label]) => label);
}
