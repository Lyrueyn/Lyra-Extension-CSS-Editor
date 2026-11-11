import stylelint from './lib/index.mjs';
const rules = {
  'block-no-empty': true,
  'color-no-invalid-hex': true,
  'comment-no-empty': true,
  'declaration-block-no-duplicate-properties': true,
  'declaration-block-no-shorthand-property-overrides': true,
  'font-family-no-duplicate-names': true,
  'function-calc-no-unspaced-operator': true,
  'function-linear-gradient-no-nonstandard-direction': true,
  'keyframe-declaration-no-important': true,
  'media-feature-name-no-unknown': true,
  'no-duplicate-at-import-rules': true,
  'no-duplicate-selectors': true,
  'no-empty-source': true,
  'no-invalid-double-slash-comments': true,
  'property-no-unknown': true,
  'selector-pseudo-class-no-unknown': true,
  'selector-pseudo-element-no-unknown': true,
  'string-no-newline': true,
  'unit-no-unknown': true,
  'at-rule-no-unknown': true,
};
const code = await new Promise((resolve) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => resolve(data)); });
try {
  const result = await stylelint.lint({ code, codeFilename: 'input.css', config: { rules }, formatter: 'json' });
  const parsed = typeof result.report === 'string' ? JSON.parse(result.report) : result.report;
  const warnings = (parsed[0] && parsed[0].warnings) || [];
  process.stdout.write(JSON.stringify({ ok: true, warnings }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
