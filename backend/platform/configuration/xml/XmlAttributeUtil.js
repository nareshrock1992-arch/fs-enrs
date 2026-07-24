/**
 * XmlAttributeUtil — shared XML attribute value safety utilities.
 *
 * Encodes the correct XML 1.0 §3.1 rules for characters that may appear in
 * double-quoted attribute values. All XML-based configuration providers
 * (VarsProvider, SwitchCoreProvider, ACLProvider, ModulesProvider, …) should
 * import from here rather than maintain their own character checks.
 *
 * XML 1.0 §3.1 AttValue production:
 *   AttValue ::= '"' ([^<&"] | Reference)* '"'
 *
 * This means, inside a double-quoted attribute:
 *   '<'  — ALWAYS invalid (starts a tag or markup declaration)
 *   '&'  — INVALID unless it opens a recognized entity or character reference
 *   '>'  — VALID (not in the exclusion set; FreeSWITCH TGML uses >= directives)
 *   '"'  — Cannot appear (VarsParser captures values with [^"]*, so impossible)
 *
 * Entity references accepted as valid:
 *   &amp;  &lt;  &gt;  &quot;  &apos;  &#NNN;  &#xHHH;
 */

// Matches a recognized XML entity reference or numeric character reference.
const ENTITY_REF = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;

/**
 * Checks whether a string is safe to embed in a double-quoted XML attribute value.
 *
 * @param {string} value
 * @returns {{ valid: boolean, reason?: string }}
 */
export function checkXmlAttributeValue(value) {
  if (typeof value !== 'string' || value === '') {
    return { valid: true };
  }

  if (value.includes('<')) {
    return { valid: false, reason: "contains '<' which is invalid in XML attribute values" };
  }

  if (value.includes('&')) {
    // Strip all recognized entity references; any remaining '&' is bare and invalid.
    const stripped = value.replace(ENTITY_REF, '');
    if (stripped.includes('&')) {
      return { valid: false, reason: "contains '&' that is not part of a valid XML entity reference" };
    }
  }

  return { valid: true };
}
