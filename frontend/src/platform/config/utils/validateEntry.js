/**
 * validateEntry — pure client-side validation for a single config entry.
 *
 * Mirrors the server-side validation in VarsProvider.validate() so the UI
 * can give immediate feedback without a round-trip.
 *
 * @param {object} entry  — ConfigEntry (key, type, min?, max?, options?, required?)
 * @param {string} value  — the value to validate (always a string from the input)
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateEntry(entry, value) {
  if (!entry) return { valid: true, error: null };

  // Required check
  if (entry.required && (value === '' || value == null)) {
    return { valid: false, error: 'Required' };
  }

  if (value === '' || value == null) return { valid: true, error: null };

  // XML-unsafe characters (server rejects these at deploy time)
  if (/["<>&]/.test(value)) {
    return { valid: false, error: 'Value contains invalid characters: " < > &' };
  }

  switch (entry.type) {
    case 'integer': {
      const n = Number(value);
      if (!Number.isInteger(n)) return { valid: false, error: 'Must be an integer' };
      if (entry.min != null && n < entry.min) return { valid: false, error: `Min ${entry.min}` };
      if (entry.max != null && n > entry.max) return { valid: false, error: `Max ${entry.max}` };
      break;
    }
    case 'port': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { valid: false, error: 'Must be a port number (1–65535)' };
      }
      break;
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        return { valid: false, error: 'Must be true or false' };
      }
      break;
    }
    case 'enum': {
      if (entry.options && !entry.options.includes(value)) {
        return { valid: false, error: `Must be one of: ${entry.options.join(', ')}` };
      }
      break;
    }
    case 'ipv4': {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
        return { valid: false, error: 'Must be a valid IPv4 address' };
      }
      break;
    }
    default:
      break;
  }

  return { valid: true, error: null };
}
