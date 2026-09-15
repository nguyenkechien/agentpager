/** The core's username rule, for instant feedback in the renderer (the main process validates again with the core). */
const USERNAME_PATTERN = /^[a-z0-9_]{5,32}$/;
const USERNAME_RULE = '5–32 characters a-z, 0-9, _';

export type UsernameCheck = { ok: true; username: string } | { ok: false; message: string };

export function checkUsername(input: string): UsernameCheck {
  const username = input.trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_PATTERN.test(username)) return { ok: false, message: `Invalid username: "${input}" (${USERNAME_RULE})` };
  return { ok: true, username };
}
