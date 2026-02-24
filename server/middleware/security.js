// ---------------------------------------------------------------------------
// Security utilities: input sanitization and validation
// ---------------------------------------------------------------------------

/**
 * Sanitize a filename by stripping path-traversal sequences, directory
 * separators, null bytes, and other special characters.  Returns a safe
 * string suitable for use as a filesystem name.
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';

  let safe = name;

  // Remove null bytes
  safe = safe.replace(/\0/g, '');

  // Remove path traversal sequences (.. in any form)
  safe = safe.replace(/\.\./g, '');

  // Remove forward and back slashes
  safe = safe.replace(/[/\\]/g, '');

  // Remove other potentially dangerous characters
  // Allow alphanumeric, hyphens, underscores, dots, and spaces
  safe = safe.replace(/[^a-zA-Z0-9._\- ]/g, '');

  // Collapse multiple dots to prevent hidden-file tricks
  safe = safe.replace(/\.{2,}/g, '.');

  // Trim leading/trailing whitespace and dots
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');

  return safe;
}

/**
 * Validate an email address using a basic regular expression.
 * Returns true if the email looks structurally valid.
 */
export function validateEmail(email) {
  if (typeof email !== 'string') return false;
  // Basic email regex: something@something.something
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Validate that a password meets minimum requirements (>= 8 chars).
 * Returns true if the password is acceptable.
 */
export function validatePassword(password) {
  if (typeof password !== 'string') return false;
  return password.length >= 8;
}
