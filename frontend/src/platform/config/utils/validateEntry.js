// Recognized XML entity and character references — safe inside double-quoted attributes.
const XML_ENTITY_REF = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;

/**
 * validateEntry — pure client-side validation for a single config entry.
 *
 * Reads validation rules from entry.metadata.validation.{} (new Phase 7.3A shape)
 * with full backward-compat aliases for the legacy flat format:
 *   entry.min     → validation.min
 *   entry.max     → validation.max
 *   entry.options → validation.allowedValues
 *   entry.required → validation.required
 *
 * Works with both old entries (flat fields) and new entries (metadata sub-object).
 * All call sites are unchanged — same signature, same return shape.
 *
 * @param {object} entry  — ConfigurationObject or legacy ConfigEntry
 * @param {string} value  — the value to validate (always a string from the input)
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateEntry(entry, value) {
  if (!entry) return { valid: true, error: null };

  // Resolve metadata: prefer entry.metadata (Phase 7.3A+) then entry directly (legacy).
  const meta = entry.metadata ?? entry;

  // Normalise validation rules: prefer validation sub-object, fall back to flat fields.
  const v = {
    required:      meta.validation?.required      ?? meta.required      ?? false,
    min:           meta.validation?.min           ?? meta.min           ?? null,
    max:           meta.validation?.max           ?? meta.max           ?? null,
    pattern:       meta.validation?.pattern                             ?? null,
    allowedValues: meta.validation?.allowedValues ?? meta.options       ?? null,
    customMessage: meta.validation?.customMessage                       ?? null,
  };

  const type = meta.type ?? entry.type;

  // Required check
  if (v.required && (value === '' || value == null)) {
    return { valid: false, error: v.customMessage ?? 'Required' };
  }

  if (value === '' || value == null) return { valid: true, error: null };

  // XML attribute value safety (XML 1.0 §3.1): '<' is always invalid; '>' is valid;
  // bare '&' (not a recognized entity reference) is invalid.
  if (value.includes('<')) {
    return { valid: false, error: "Value cannot contain '<'" };
  }
  if (value.includes('&') && value.replace(XML_ENTITY_REF, '').includes('&')) {
    return { valid: false, error: "Value contains '&' that is not part of a valid XML entity reference (use &amp; to represent a literal &)" };
  }

  // Pattern check (new in Phase 7.3A)
  if (v.pattern) {
    try {
      if (!new RegExp(v.pattern).test(value)) {
        return { valid: false, error: v.customMessage ?? 'Invalid format' };
      }
    } catch {
      // Invalid regex in catalog — silently skip rather than breaking the UI.
    }
  }

  switch (type) {
    case 'integer': {
      const n = Number(value);
      if (!Number.isInteger(n)) return { valid: false, error: v.customMessage ?? 'Must be an integer' };
      if (v.min != null && n < v.min) return { valid: false, error: v.customMessage ?? `Min ${v.min}` };
      if (v.max != null && n > v.max) return { valid: false, error: v.customMessage ?? `Max ${v.max}` };
      break;
    }
    case 'port': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { valid: false, error: v.customMessage ?? 'Must be a port number (1–65535)' };
      }
      break;
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        return { valid: false, error: v.customMessage ?? 'Must be true or false' };
      }
      break;
    }
    case 'enum': {
      if (v.allowedValues && !v.allowedValues.includes(value)) {
        return {
          valid: false,
          error: v.customMessage ?? `Must be one of: ${v.allowedValues.join(', ')}`,
        };
      }
      break;
    }
    case 'ip':
    case 'ipv4': {
      // Accept stun: prefix (used by external_sip_ip, external_rtp_ip) and 'auto'.
      if (value !== 'auto' && !value.startsWith('stun:') && !value.startsWith('$${')) {
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
          return { valid: false, error: v.customMessage ?? 'Must be a valid IPv4 address, stun: URI, or auto' };
        }
      }
      break;
    }
    default:
      break;
  }

  return { valid: true, error: null };
}
