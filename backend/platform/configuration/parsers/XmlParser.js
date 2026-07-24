/**
 * XmlParser — General-purpose XML parser with comment preservation.
 *
 * Used by Phase 7.2+ providers (ACL, Sofia, EventSocket, etc.) where the
 * configuration file is structured XML — not the line-oriented vars.xml format
 * handled by VarsParser.
 *
 * Requires: fast-xml-parser >= 4.3  (npm install fast-xml-parser)
 * Run `cd backend && npm install fast-xml-parser` before using Phase 7.2+.
 *
 * This file follows the two-pass comment-preservation strategy:
 *   Pass 1: Extract comments with their placeholder positions.
 *   Pass 2: Parse clean XML, then re-associate comments on serialise.
 */

let _XMLParser = null;
let _XMLBuilder = null;

async function getFxp() {
  if (_XMLParser) return { XMLParser: _XMLParser, XMLBuilder: _XMLBuilder };
  try {
    const mod = await import('fast-xml-parser');
    _XMLParser  = mod.XMLParser;
    _XMLBuilder = mod.XMLBuilder;
    return { XMLParser: _XMLParser, XMLBuilder: _XMLBuilder };
  } catch {
    throw new Error(
      '[XmlParser] fast-xml-parser is not installed. ' +
      'Run: cd backend && npm install fast-xml-parser@^4.3.0'
    );
  }
}

const PARSER_OPTIONS = {
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  commentPropName:     '#comment',
  preserveOrder:       true,
  unpairedTags:        ['X-PRE-PROCESS', 'br'],
  stopNodes:           [],
  trimValues:          false,
};

const BUILDER_OPTIONS = {
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  commentPropName:     '#comment',
  preserveOrder:       true,
  unpairedTags:        ['X-PRE-PROCESS', 'br'],
  format:              true,
  indentBy:            '  ',
};

/**
 * Parse XML content into an ordered node list with comments preserved.
 * @param {string} rawContent
 * @returns {Promise<object[]>}  Ordered node array from fast-xml-parser
 */
export async function parse(rawContent) {
  const { XMLParser } = await getFxp();
  const parser = new XMLParser(PARSER_OPTIONS);
  return parser.parse(rawContent);
}

/**
 * Serialise an ordered node list back to XML.
 * @param {object[]} nodes
 * @returns {Promise<string>}
 */
export async function serialize(nodes) {
  const { XMLBuilder } = await getFxp();
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  return builder.build(nodes);
}
